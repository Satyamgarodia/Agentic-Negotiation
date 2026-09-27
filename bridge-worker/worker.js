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
// `werift` exposes RTP packets, not decoded/injectable PCM audio sources.
// The bridge needs the native Node audio helpers exposed by @roamhq/wrtc.
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, nonstandard } = wrtc;
const { RTCAudioSink, RTCAudioSource } = nonstandard;

const SERVER = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const WORKER_ID = process.env.WORKER_ID || `bridge-${os.hostname()}`;
const PUBLIC_IP = process.env.PUBLIC_IP || '';
const SELF_TEST = process.argv.includes('--self-test');
const DEBUG_AUDIO = process.env.AUDIO_DEBUG === '1' || SELF_TEST;
// TONE_TEST=1: feed a continuous 440Hz tone instead of Gemini audio.
// Killer diagnostic: if the caller hears the tone, outbound RTP works and the
// bug is upstream (Gemini silence). If not, the bug is transport. Unset after.
const TONE_TEST = process.env.TONE_TEST === '1';

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
function sinkFrameToPcm16k(frame) {
  if (!frame?.samples || !(frame.samples instanceof Int16Array)) return null;
  const sampleRate = frame.sampleRate || 48000;
  const channels = frame.channelCount || 1;
  const ratio = sampleRate / 16000;
  if (!Number.isInteger(ratio)) {
    log('warn', 'unsupported incoming audio sample rate', { sampleRate, channels });
    return null;
  }
  const n = Math.floor(frame.samples.length / channels / ratio);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const base = Math.floor(i * ratio) * channels;
    let sample = 0;
    for (let channel = 0; channel < channels; channel++) sample += frame.samples[base + channel];
    out.writeInt16LE(Math.round(sample / channels), i * 2);
  }
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

// Force IPv4: Meta offers IPv4 + IPv6 host candidates. A v6 nomination can
// show pc 'connected' while the v4 media path Meta actually uses stays dead.
function stripIpv6Candidates(sdp) {
  const lines = String(sdp).split('\r\n');
  const kept = lines.filter((l) => {
    if (!l.startsWith('a=candidate:')) return true;
    const ip = l.split(' ')[4] || '';
    return !ip.includes(':');
  });
  return { sdp: kept.join('\r\n'), removed: lines.length - kept.length };
}

// Bounded wait for a usable answer: resolve shortly after the first srflx
// (public) candidate appears instead of waiting for full gathering, so setup
// doesn't idle on dead interfaces. Hard cap 1s — never ship host-only.
function waitForIceGathering(pc, timeoutMs = 1000, srflxGraceMs = 250) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let grace = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      try {
        if (typeof pc.removeEventListener === 'function') {
          pc.removeEventListener('icegatheringstatechange', onGathering);
          pc.removeEventListener('icecandidate', onCandidate);
        }
      } catch {}
      resolve();
    };
    const onGathering = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const onCandidate = (e) => {
      try {
        const c = e?.candidate?.candidate ?? (typeof e?.candidate === 'string' ? e.candidate : '');
        if (typeof c === 'string' && c.includes(' typ srflx') && !grace && !done) {
          grace = setTimeout(finish, srflxGraceMs);
        }
      } catch {}
    };
    try {
      if (typeof pc.addEventListener === 'function') {
        pc.addEventListener('icegatheringstatechange', onGathering);
        pc.addEventListener('icecandidate', onCandidate);
      } else {
        pc.onicegatheringstatechange = onGathering;
        pc.onicecandidate = onCandidate;
      }
    } catch { finish(); return; }
    const timer = setTimeout(finish, timeoutMs);
  });
}

// Log only signaling-shape lines (m=/c=/mid/direction/rtpmap/candidate).
// Never logs ufrag/pwd/fingerprint values.
function logSdpSummary(sdp, callId, tag) {
  try {
    const interesting = String(sdp).split('\r\n').filter((l) =>
      /^(m=audio|c=IN|a=mid:|a=sendrecv|a=sendonly|a=recvonly|a=inactive|a=rtpmap:|a=candidate:|a=rtcp-mux|a=group:)/.test(l));
    const mLines = interesting.filter((l) => l.startsWith('m=')).length;
    log('info', `${shortId(callId)}: ${tag} SDP summary (${String(sdp).length}B, ${mLines} m-line(s))`, { lines: interesting });
  } catch (e) {
    log('warn', `${shortId(callId)}: ${tag} SDP summary failed`, { error: e?.message || String(e) });
  }
}

// ---------------------------------------------------------------- media wiring
// Feeds decoded caller PCM into onPcm16k. Returns cleanup fn.
// NOTE (unverified API surface): if RTCAudioSink/RTCAudioSource shapes differ
// in your installed werift version, --self-test fails fast with the exact
// mismatch — paste it back and the call below gets corrected in one round.
function attachSink(peerConnection, onPcm16k, label) {
  peerConnection.ontrack = ({ track }) => {
    log('info', `${label}: incoming track`, { kind: track.kind });
    const sink = new RTCAudioSink(track);
    let first = true;
    sink.ondata = (frame) => {
      if (first) {
        first = false;
        log('info', `${label}: first audio frame shape`, {
          isBuffer: Buffer.isBuffer(frame),
          keys: frame && typeof frame === 'object' ? Object.keys(frame) : typeof frame,
          sampleRate: frame?.sampleRate ?? null,
          channelCount: frame?.channelCount ?? null,
          bitsPerSample: frame?.bitsPerSample ?? null,
          numberOfFrames: frame?.numberOfFrames ?? null,
          samplesLength: frame?.samples?.length ?? null,
          type: frame?.type ?? null,
        });
      }
      const pcm16 = sinkFrameToPcm16k(frame);
      if (!pcm16) {
        if (DEBUG_AUDIO) log('warn', `${label}: unrecognized frame, skipping`);
        return;
      }
      onPcm16k(pcm16);
    };
  };
}

function makeFeeder(source, label) {
  const frames = [];
  let pendingPcm = Buffer.alloc(0);
  let firstQueued = true;
  let firstSent = true;
  let fedFrames = 0;
  let feedErrors = 0;
  let enqueuedChunks = 0;
  let droppedFrames = 0;
  // RTCAudioSource requires real-time 10ms delivery. Continuous silence keeps
  // the WhatsApp RTP stream alive between Gemini speech chunks.
  const timer = setInterval(() => {
    const samples = frames.shift() || new Int16Array(480);
    try {
      source.onData({
        samples,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: 480,
      });
      fedFrames++;
      if (firstSent) {
        firstSent = false;
        log('info', `${label}: outbound RTP audio pump started`);
      }
    } catch (e) {
      feedErrors++;
      if (feedErrors <= 3) log('error', `${label}: RTCAudioSource feed failed`, { error: e?.message || String(e) });
    }
  }, 10);

  const enqueue = (pcm48k) => {
    try {
      // werift RTCAudioSource push API — validated by --self-test.
      // Gemini chunks are not guaranteed to align to 10ms WebRTC frames.
      // Preserve the remainder so sub-frame chunks are never discarded.
      pendingPcm = Buffer.concat([pendingPcm, pcm48k]);
      enqueuedChunks++;
      let added = 0;
      while (pendingPcm.length >= 960) {
        // Copy each slice so it has exactly 480 samples / 960 B.
        frames.push(Int16Array.from(new Int16Array(pendingPcm.buffer, pendingPcm.byteOffset, 480)));
        pendingPcm = pendingPcm.subarray(960);
        added++;
      }
      // Generous cap (~10s): Gemini delivers speech in bursts faster than
      // realtime, so the queue legitimately holds seconds of audio during a
      // long reply. NEVER chop live speech here — drops are last-resort
      // safety for a real stall only. Barge-in staleness is handled by
      // flush(), not by this cap.
      if (frames.length > 1000) {
        droppedFrames += frames.length - 1000;
        frames.splice(0, frames.length - 1000);
        if (droppedFrames <= 3 || droppedFrames % 100 === 0) {
          log('warn', `${label}: dropped stale outbound frames to stay live`, { droppedFrames });
        }
      }
      if (firstQueued && added > 0) {
        firstQueued = false;
        log('info', `${label}: first Gemini PCM queued for caller`, { queuedFrames: frames.length });
      }
    } catch (e) {
      log('error', `${label}: RTCAudioSource feed failed`, {
        error: e?.message || String(e),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(source)),
        own: Object.keys(source),
      });
      throw e;
    }
  };
  enqueue.stop = () => clearInterval(timer);
  // Barge-in: the caller interrupted Gemini — discard already-buffered
  // speech (up to seconds of it) so the stale reply stops immediately
  // instead of playing out. The sub-10ms partial remainder goes too;
  // inaudible, keeps the stream cleanly aligned.
  enqueue.flush = () => {
    const n = frames.length;
    frames.length = 0;
    pendingPcm = Buffer.alloc(0);
    if (n > 0) log('info', `${label}: flushed ${n} queued outbound frames on barge-in`);
  };
  enqueue.stats = () => ({ queuedFrames: frames.length, fedFrames, feedErrors, enqueuedChunks, droppedFrames, pendingBytes: pendingPcm.length });
  return enqueue;
}

// ---------------------------------------------------------------- one call
const activeCalls = new Map(); // callId -> { pc, ws, cleanup }
// Calls currently in setup (SDP answer not submitted yet). The poll interval
// (2s) is shorter than setup time (~2.1s with the ICE wait), so a second poll
// can otherwise start a duplicate PeerConnection for the same call — two PCs,
// two answers, one leaked with its timers still running.
const startingCalls = new Set();

async function handleCall(job) {
  const { callId, sdpOffer, roomName } = job;
  if (activeCalls.has(callId) || startingCalls.has(callId)) return;
  startingCalls.add(callId);
  log('info', `bridging call ${shortId(callId)} (room ${roomName})`);
  const t0 = Date.now();

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  // WhatsApp offers one audio m-line. Put both directions on the same
  // transceiver; separate recvonly/sendonly transceivers leave the source
  // track unassociated with Meta's sole negotiated m-line.
  // Do NOT addTransceiver here: a pre-offer transceiver ends up orphaned
  // (mid:null, currentDirection:null) while the offer spawns its own recvonly
  // transceiver — and the SDP answer goes out a=recvonly, which is exactly
  // Meta error 138021 (no media from business). Instead addTrack() AFTER
  // setRemoteDescription, which attaches to Meta's offered m-line.
  const source = new RTCAudioSource();
  const sendTrack = source.createTrack();
  const feedCaller = makeFeeder(source, callId);
  let audioTransceiver = null;
  let geminiMsgs = 0;
  let toneTimer = null;
  let diagTimer = null;

  let statsLogged = false;
  pc.onconnectionstatechange = () => {
    log('info', `pc state ${shortId(callId)}: ${pc.connectionState}`);
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      cleanupCall(callId);
      return;
    }
    if (pc.connectionState !== 'connected' || statsLogged) return;
    statsLogged = true;
    setTimeout(async () => {
      try {
        const stats = await pc.getStats();
        const all = Array.from(stats.values());
        const summary = all.map((s) => ({
          type: s.type,
          kind: s.kind ?? s.mediaType ?? null,
          packetsSent: s.packetsSent ?? null,
          bytesSent: s.bytesSent ?? null,
          packetsReceived: s.packetsReceived ?? null,
          state: s.state ?? null,
          nominated: s.nominated ?? null,
        }));
        const types = summary.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc; }, {});
        const outbound = all.find((s) => s.type === 'outbound-rtp' && ((s.kind ?? s.mediaType) === 'audio' || s.kind === undefined));
        log('info', `${shortId(callId)}: audio stats dump`, {
          direction: audioTransceiver?.direction ?? null,
          currentDirection: audioTransceiver?.currentDirection ?? null,
          transceivers: typeof pc.getTransceivers === 'function'
            ? pc.getTransceivers().map((t) => ({ direction: t.direction, currentDirection: t.currentDirection, mid: t.mid ?? null }))
            : null,
          statTypes: types,
          outboundAudio: outbound ? { packetsSent: outbound.packetsSent ?? null, bytesSent: outbound.bytesSent ?? null } : null,
          entries: summary,
        });
      } catch (e) {
        log('warn', `${shortId(callId)}: could not read audio stats`, { error: e?.message || String(e) });
      }
    }, 3000);
  };

  // Gateway media socket (TCP — works from anywhere).
  // perMessageDeflate off: compression adds 5-15ms per message for
  // incompressible PCM audio — pure latency cost, ~no size win.
  const mediaWs = new WebSocket(job.callMediaWs, { perMessageDeflate: false });
  try { mediaWs.on('open', () => mediaWs._socket?.setNoDelay?.(true)); } catch {}
  const wsReady = new Promise((resolve, reject) => {
    mediaWs.on('open', resolve);
    mediaWs.on('error', reject);
  });

  // Uplink batching: RTCAudioSink emits ~10ms frames (~320B @16k).
  // Sending each frame as its own JSON+base64 WS message = ~100 msgs/sec
  // of TCP/WS framing overhead. Batch to 40ms (1280B) -> ~25 msgs/sec,
  // same audio bytes, far less per-message latency tax. A 40ms flush timer
  // bounds tail latency so a partial batch never sits waiting.
  let uplinkBuf = Buffer.alloc(0);
  let uplinkMsgs = 0;
  const UPLINK_TARGET = 1280; // 40ms @ 16kHz s16le mono
  const flushUplink = () => {
    if (uplinkBuf.length === 0) return;
    if (mediaWs.readyState === WebSocket.OPEN) {
      mediaWs.send(JSON.stringify({ type: 'caller_audio', callId, audio: uplinkBuf.toString('base64') }));
      uplinkMsgs++;
    }
    uplinkBuf = Buffer.alloc(0);
  };
  const uplinkTimer = setInterval(flushUplink, 40);
  attachSink(pc, (pcm16k) => {
    uplinkBuf = Buffer.concat([uplinkBuf, pcm16k]);
    if (uplinkBuf.length >= UPLINK_TARGET) flushUplink();
  }, callId);

  mediaWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'flush_audio') {
        feedCaller.flush();
        return;
      }
      if (msg.type === 'gemini_audio' && msg.audio) {
        geminiMsgs++;
        if (geminiMsgs <= 3 || geminiMsgs % 50 === 0) {
          log('info', `${shortId(callId)}: gemini_audio #${geminiMsgs} received`, { bytes: String(msg.audio).length });
        }
        if (TONE_TEST) return; // tone loop owns the feeder in test mode
        feedCaller(up24to48(Buffer.from(msg.audio, 'base64')));
      }
    } catch (e) {
      log('warn', `media ws parse error ${shortId(callId)}`, { error: e?.message });
    }
  });
  mediaWs.on('close', () => {
    log('info', `media ws closed ${shortId(callId)}`);
    clearInterval(uplinkTimer);
    cleanupCall(callId);
  });

  try {
    await wsReady;
    // Force IPv4: Meta offers IPv4 + IPv6 host candidates. A v6 nomination can
    // show 'connected' while the v4 media path Meta actually uses stays dead.
    const stripped = stripIpv6Candidates(sdpOffer);
    if (stripped.removed > 0) log('info', `${shortId(callId)}: stripped ${stripped.removed} IPv6 candidate line(s) from offer`);
    logSdpSummary(stripped.sdp, callId, 'offer');
    await pc.setRemoteDescription({ type: 'offer', sdp: stripped.sdp });
    // Attach outbound audio to Meta's offered m-line (upgrades it
    // recvonly->sendrecv). addTrack reuses the still-unassociated offer
    // transceiver; addTransceiver here would open a second m-line Meta ignores.
    pc.addTrack(sendTrack);
    try {
      audioTransceiver = pc.getTransceivers().find((t) => t.sender && t.sender.track === sendTrack) || null;
    } catch { audioTransceiver = null; }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // Wait (bounded, srflx-triggered) so the answer carries a reachable
    // public candidate instead of host-only.
    await waitForIceGathering(pc);
    const sdpAnswer = pc.localDescription?.sdp || answer.sdp;
    logSdpSummary(sdpAnswer, callId, 'answer');
    if (/^a=recvonly$/m.test(sdpAnswer)) {
      log('error', `${shortId(callId)}: answer m-line is recvonly — Meta will hear nothing (expect 138021)`, {});
    }
    await api('/api/bridge/answer', { method: 'POST', body: { callId, sdpAnswer, workerId: WORKER_ID } });
    log('info', `SDP answer submitted for ${callId} in ${Date.now() - t0}ms`);
    if (TONE_TEST) {
      // Killer test: continuous 440Hz tone owns the feeder all call long.
      // If the caller hears it, outbound RTP works and the bug is upstream
      // (Gemini silence). If not, the bug is transport. Unset TONE_TEST after.
      const tone = tone48k(1);
      let off = 0;
      log('warn', `${shortId(callId)}: TONE_TEST=1 — feeding continuous tone, ignoring Gemini audio`);
      toneTimer = setInterval(() => {
        for (let i = 0; i < 2; i++) {
          feedCaller(tone.subarray(off, off + 960));
          off = (off + 960) % tone.length;
        }
      }, 20);
    }
    // Per-call counters every 5s: the only window into a long silent stretch.
    diagTimer = setInterval(() => {
      try {
        log('info', `${shortId(callId)}: call counters`, {
          geminiMsgs,
          uplinkMsgs,
          ...feedCaller.stats(),
          wsOpen: mediaWs.readyState === WebSocket.OPEN,
          pcState: pc.connectionState,
        });
      } catch {}
    }, 5000);
    activeCalls.set(callId, {
      pc,
      ws: mediaWs,
      cleanup: () => {
        if (toneTimer) clearInterval(toneTimer);
        if (diagTimer) clearInterval(diagTimer);
        clearInterval(uplinkTimer);
        feedCaller.stop();
        try { mediaWs.close(); } catch {}
        try { pc.close(); } catch {}
      },
    });
    startingCalls.delete(callId);
  } catch (e) {
    log('error', `bridge setup failed ${shortId(callId)}`, { error: e?.message || String(e) });
    startingCalls.delete(callId);
    if (toneTimer) clearInterval(toneTimer);
    if (diagTimer) clearInterval(diagTimer);
    clearInterval(uplinkTimer);
    feedCaller.stop();
    try { mediaWs.close(); } catch {}
    try { pc.close(); } catch {}
  }
}

function cleanupCall(callId) {
  startingCalls.delete(callId); // unblock retry if setup never completed
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
  attachSink(receiver, (pcm16k) => {
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
  setInterval(pollPending, 500);
}
