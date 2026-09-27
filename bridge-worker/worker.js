#!/usr/bin/env node
/**
 * bridge-worker: headless audio bridge for WhatsApp x Gemini Live.
 *
 * Why it exists: Cloud Run has no UDP ingress, so it can accept a WhatsApp
 * call at the signaling level but cannot exchange voice RTP. This worker runs
 * somewhere with a public UDP-reachable IP, terminates the WhatsApp WebRTC
 * audio, and pipes PCM both ways to the gateway over TCP WebSocket:
 *
 *   Caller phone <--RTP/Opus--> worker <--WS/PCM--> gateway <--WS--> Gemini Live
 *                                    └--> LiveKit room wa_<callId> (rendezvous)
 *
 * No browser, no human. The dashboard only watches via logs.
 *
 * Usage:
 *   npm install
 *   node worker.js --self-test        # validate werift media APIs locally first
 *   SERVER_URL=http://localhost:3000 WORKER_ID=bridge-1 node worker.js
 *   # real calls need: PUBLIC_IP=<this host's public IP>, UDP port open
 *   SERVER_URL=https://<gateway> WORKER_ID=fly-1 PUBLIC_IP=1.2.3.4 node worker.js
 */
import os from 'node:os';
import WebSocket from 'ws';
import { RTCPeerConnection, RTCAudioSink, RTCAudioSource } from 'werift';

const SERVER = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const WORKER_ID = process.env.WORKER_ID || `bridge-${os.hostname()}`;
const PUBLIC_IP = process.env.PUBLIC_IP || '';
const SELF_TEST = process.argv.includes('--self-test');
const DEBUG_AUDIO = process.env.AUDIO_DEBUG === '1' || SELF_TEST;

const log = (level, msg, extra) => {
  const line = `[bridge][${level}][${WORKER_ID}] ${msg}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`;
  if (level === 'error') console.error(line);
  else console.log(line);
};
// Short display form for long Meta `wacid.*` call IDs in log lines.
// Call maps and API payloads always use the full ID.
const shortId = (id) => {
  if (!id) return '';
  const s = String(id).replace(/^wacid[._-]?/i, '');
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

async function api(path, opts = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- PCM helpers (s16le mono)
function toBuffer(frame) {
  if (!frame) return null;
  if (Buffer.isBuffer(frame)) return frame;
  if (Buffer.isBuffer(frame.data)) return frame.data;
  if (Buffer.isBuffer(frame.samples)) return frame.samples;
  return null;
}
// 48kHz -> 16kHz (caller audio -> Gemini)
function down48to16(buf) {
  const n = Math.floor(buf.length / 2 / 3);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(buf.readInt16LE(i * 6), i * 2);
  return out;
}
// 24kHz -> 48kHz (Gemini voice -> caller)
function up24to48(buf) {
  const n = Math.floor(buf.length / 2);
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}
function tone48k(seconds, freq = 440) {
  const n = 48000 * seconds;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * 12000), i * 2);
  }
  return out;
}

// ---------------------------------------------------------------- media wiring
// Feeds decoded caller PCM into onPcm16k. Returns cleanup fn.
// NOTE (unverified API surface): if RTCAudioSink/RTCAudioSource shapes differ
// in your installed werift version, --self-test fails fast with the exact
// mismatch — paste it back and the call below gets corrected in one round.
function attachSink(transceiver, onPcm16k, label) {
  transceiver.onTrack.subscribe((track) => {
    log('info', `${label}: incoming track`, { kind: track.kind });
    const sink = new RTCAudioSink(track);
    let first = true;
    sink.ondata = (frame) => {
      if (first) {
        first = false;
        log('info', `${label}: first audio frame shape`, {
          isBuffer: Buffer.isBuffer(frame),
          keys: frame && typeof frame === 'object' ? Object.keys(frame) : typeof frame,
        });
      }
      const pcm48 = toBuffer(frame);
      if (!pcm48) {
        if (DEBUG_AUDIO) log('warn', `${label}: unrecognized frame, skipping`);
        return;
      }
      onPcm16k(down48to16(pcm48));
    };
  });
}

function makeFeeder(source, label) {
  return (pcm48k) => {
    try {
      // werift RTCAudioSource push API — validated by --self-test.
      source.ondata(pcm48k);
    } catch (e) {
      log('error', `${label}: RTCAudioSource feed failed`, {
        error: e?.message || String(e),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(source)),
        own: Object.keys(source),
      });
      throw e;
    }
  };
}

// ---------------------------------------------------------------- one call
const activeCalls = new Map(); // callId -> { pc, ws, cleanup }

async function handleCall(job) {
  const { callId, sdpOffer, roomName } = job;
  if (activeCalls.has(callId)) return;
  log('info', `bridging call ${shortId(callId)} (room ${roomName})`);
  const t0 = Date.now();

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  pc.onconnectionstatechange = () => {
    log('info', `pc state ${shortId(callId)}: ${pc.connectionState}`);
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) cleanupCall(callId);
  };

  // Caller audio -> Gemini (via gateway WS)
  const recvT = pc.addTransceiver('audio', { direction: 'recvonly' });

  // Gemini voice -> caller
  const source = new RTCAudioSource();
  const sendTrack = source.createTrack();
  pc.addTransceiver(sendTrack, { direction: 'sendonly' });
  const feedCaller = makeFeeder(source, callId);

  // Gateway media socket (TCP — works from anywhere)
  const mediaWs = new WebSocket(job.callMediaWs);
  const wsReady = new Promise((resolve, reject) => {
    mediaWs.on('open', resolve);
    mediaWs.on('error', reject);
  });

  attachSink(recvT, (pcm16k) => {
    if (mediaWs.readyState === WebSocket.OPEN) {
      mediaWs.send(JSON.stringify({ type: 'caller_audio', callId, audio: pcm16k.toString('base64') }));
    }
  }, callId);

  mediaWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'gemini_audio' && msg.audio) {
        feedCaller(up24to48(Buffer.from(msg.audio, 'base64')));
      }
    } catch (e) {
      log('warn', `media ws parse error ${shortId(callId)}`, { error: e?.message });
    }
  });
  mediaWs.on('close', () => {
    log('info', `media ws closed ${shortId(callId)}`);
    cleanupCall(callId);
  });

  try {
    await wsReady;
    await pc.setRemoteDescription({ type: 'offer', sdp: sdpOffer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const sdpAnswer = pc.localDescription?.sdp || answer.sdp;
    await api('/api/bridge/answer', { method: 'POST', body: { callId, sdpAnswer, workerId: WORKER_ID } });
    log('info', `SDP answer submitted for ${callId} in ${Date.now() - t0}ms`);
    activeCalls.set(callId, {
      pc,
      ws: mediaWs,
      cleanup: () => {
        try { mediaWs.close(); } catch {}
        try { pc.close(); } catch {}
      },
    });
  } catch (e) {
    log('error', `bridge setup failed ${shortId(callId)}`, { error: e?.message || String(e) });
    try { mediaWs.close(); } catch {}
    try { pc.close(); } catch {}
  }
}

function cleanupCall(callId) {
  const c = activeCalls.get(callId);
  if (!c) return;
  activeCalls.delete(callId);
  try { c.cleanup(); } catch {}
  log('info', `call cleaned up ${shortId(callId)}`);
}

// ---------------------------------------------------------------- main loops
async function heartbeat() {
  try {
    await api('/api/bridge/heartbeat', { method: 'POST', body: { workerId: WORKER_ID, publicIp: PUBLIC_IP } });
  } catch (e) {
    log('warn', 'heartbeat failed (is SERVER_URL correct?)', { error: e?.message });
  }
}

async function pollPending() {
  try {
    const { pending } = await api('/api/bridge/pending');
    for (const job of pending || []) {
      if (!activeCalls.has(job.callId)) {
        void handleCall(job).catch((e) => log('error', `handleCall ${shortId(job.callId)}`, { error: e?.message }));
      }
    }
  } catch (e) {
    log('warn', 'pending poll failed', { error: e?.message });
  }
}

// ---------------------------------------------------------------- self-test (no server, no Meta)
async function selfTest() {
  log('info', 'self-test: wiring two local peer connections (sender -> receiver)');
  const sender = new RTCPeerConnection({});
  const receiver = new RTCPeerConnection({});

  const source = new RTCAudioSource();
  const track = source.createTrack();
  sender.addTransceiver(track, { direction: 'sendonly' });
  const recvT = receiver.addTransceiver('audio', { direction: 'recvonly' });

  // Minimal in-process signaling
  sender.onicecandidate = (e) => e.candidate && receiver.addIceCandidate(e.candidate).catch(() => {});
  receiver.onicecandidate = (e) => e.candidate && sender.addIceCandidate(e.candidate).catch(() => {});

  let frames = 0;
  let bytes = 0;
  attachSink(recvT, (pcm16k) => {
    frames++;
    bytes += pcm16k.length;
  }, 'self-test');

  const offer = await sender.createOffer();
  await sender.setLocalDescription(offer);
  await receiver.setRemoteDescription(sender.localDescription);
  const answer = await receiver.createAnswer();
  await receiver.setLocalDescription(answer);
  await sender.setRemoteDescription(receiver.localDescription);

  const feed = makeFeeder(source, 'self-test');
  const tone = tone48k(1);
  for (let i = 0; i < tone.length; i += 960 * 2) {
    feed(tone.subarray(i, i + 960 * 2)); // 20ms frames @48k
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 1000));
  sender.close();
  receiver.close();

  if (frames > 0) {
    log('info', `SELF-TEST PASSED: received ${frames} frames (${bytes}B PCM16). werift media APIs OK.`);
    process.exit(0);
  } else {
    log('error', 'SELF-TEST FAILED: sender ran but receiver got 0 frames. Paste this + werift version.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------- entry
if (SELF_TEST) {
  void selfTest().catch((e) => {
    log('error', 'self-test crashed', {
      error: e?.message || String(e),
      stack: e?.stack?.split('\n').slice(0, 6),
    });
    process.exit(1);
  });
} else {
  if (!PUBLIC_IP) {
    log('warn', 'PUBLIC_IP not set — SDP answers will carry host candidates only. Fine for --self-test/local dev, NOT for real Meta calls.');
  }
  log('info', `worker starting -> server ${SERVER}`);
  void heartbeat();
  setInterval(heartbeat, 10000);
  void pollPending();
  setInterval(pollPending, 2000);
}
