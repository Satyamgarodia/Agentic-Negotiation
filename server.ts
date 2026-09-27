import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import dotenv from 'dotenv';
import { RoomServiceClient, AccessToken } from 'livekit-server-sdk';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Config: ONLY secrets come from env. Everything else is hardcoded below so
// the Cloud Run env panel stays minimal (4 vars). Deployment-specific values
// still honor env overrides if ever set, but work hardcoded out of the box.
// Required env: GEMINI_API_KEY, META_ACCESS_TOKEN, LIVEKIT_API_KEY,
// LIVEKIT_API_SECRET. (PORT is injected by Cloud Run.)
// ---------------------------------------------------------------------------
const GEMINI_LIVE_MODEL = 'gemini-3.8-live';
const GEMINI_LIVE_FALLBACK_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';
const GEMINI_VOICE_DEFAULT = 'Zephyr';
const META_GRAPH_VERSION = 'v21.0';
// Public IPv4 announced inside the SDP answer. MUST be reachable over UDP for
// WhatsApp RTP. On Cloud Run there is no UDP ingress, so point this at your
// LiveKit Cloud TURN / media-bridge host. Never 127.0.0.1.
const MEDIA_ANNOUNCE_IP = process.env.MEDIA_ANNOUNCE_IP || '';
const MEDIA_PORT = 3480;
const PUBLIC_BASE_URL = (process.env.APP_URL || 'https://gemini-call-link-387274718809.asia-south1.run.app').replace(/\/$/, '');

const livekitUrl = process.env.LIVEKIT_URL || 'wss://agent-negotiation-wt32uzjo.livekit.cloud';
const livekitApiKey = process.env.LIVEKIT_API_KEY || '';
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || '';
const livekitConfigured = Boolean(livekitUrl && livekitApiKey && livekitApiSecret);

let roomService: RoomServiceClient | null = null;
if (livekitConfigured) {
  try {
    roomService = new RoomServiceClient(livekitUrl, livekitApiKey, livekitApiSecret);
    console.log('[LiveKit] RoomServiceClient initialized:', livekitUrl);
  } catch (e) {
    console.error('[LiveKit] Failed to initialize RoomServiceClient:', e);
    roomService = null;
  }
} else {
  console.warn('[LiveKit] LIVEKIT_URL / API_KEY / API_SECRET not fully set — rooms/tokens disabled, direct Gemini bridge still works.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Google GenAI with User-Agent as required by AI Studio guidelines
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Gateway Configuration State
export interface GatewayConfig {
  phoneNumberId: string;
  wabaId: string;
  businessPhoneNumber: string;
  verifyToken: string;
  metaAccessToken?: string;
  autoAcceptCalls: boolean;
  voiceName: string;
  systemPrompt: string;
  personaName: string;
  enabledTools: string[];
}

let gatewayConfig: GatewayConfig = {
  phoneNumberId: '306232809234143',
  wabaId: '239559819251204',
  businessPhoneNumber: '+91 82877 26383',
  verifyToken: 'whatsapp_gemini_verify_token_live',
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  autoAcceptCalls: true,
  voiceName: GEMINI_VOICE_DEFAULT,
  personaName: 'Garodia Traders AI Sales Manager',
  systemPrompt: `You are Garodia Traders AI Sales Manager, the official voice sales manager for Garodia Traders. You answer voice calls live from customers with exceptional clarity, empathy, and conciseness.
Default Language: Marwari. Always speak in Marwari by default unless the customer explicitly asks for another language.
Keep your spoken responses natural, conversational, and direct (1-3 sentences per turn). Do not use markdown, emojis, or bullet points in voice responses.
You have access to tools for checking orders, scheduling appointments, and transferring to human agents if needed.`,
  enabledTools: ['check_order_status', 'book_appointment', 'get_business_hours', 'escalate_to_human'],
};

// Call Session Model
export interface CallSession {
  id: string;
  callerNumber: string;
  callerName: string;
  direction: 'inbound' | 'outbound';
  origin?: 'telephony' | 'browser';
  status: 'ringing' | 'connected' | 'speaking' | 'interrupted' | 'ended';
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  packetsIn: number;
  packetsOut: number;
  avgLatencyMs: number;
  interruptionsCount: number;
  livekitRoom?: string;
  geminiConnected?: boolean;
  // Full SDP offer from Meta, stored so a bridge worker can answer it.
  // Never logged (length only).
  sdpOffer?: string;
  pickupStage?: string;
  stageHistory?: Array<{ stage: string; ts: string; detail?: string }>;
  turns: Array<{
    speaker: 'caller' | 'gemini';
    text: string;
    timestamp: string;
  }>;
}

// In-memory call log
const callSessions: Map<string, CallSession> = new Map();
// Server-side Gemini Live sessions keyed by callId — this is the DIRECT bridge.
// No browser click required: webhook -> LiveKit room -> Gemini Live session.
const geminiSessions: Map<string, any> = new Map();
// Latest Gemini output audio (base64 PCM 24k) queued per call for media bridges.
const geminiAudioOutbox: Map<string, string[]> = new Map();
// LiveKit room info per call.
const livekitRooms: Map<string, { roomName: string; agentToken: string; callerToken: string }> = new Map();

// Headless bridge workers: UDP-capable processes that terminate WhatsApp RTP
// audio and join the LiveKit room. Cloud Run can't do this itself (no UDP
// ingress), so a worker (bridge-worker/) with a public IP does it instead.
interface BridgeWorker {
  id: string;
  publicIp: string;
  lastSeen: number;
}
const bridgeWorkers = new Map<string, BridgeWorker>();
// callId -> SDP answer produced by a bridge worker, consumed by the pickup flow.
const bridgeAnswers = new Map<string, string>();

function pruneBridges() {
  const now = Date.now();
  for (const [id, b] of bridgeWorkers) {
    if (now - b.lastSeen > 45000) {
      bridgeWorkers.delete(id);
      plog('warn', 'bridge', `worker ${id} stale (>45s) — removed`);
    }
  }
}

function liveBridge(): BridgeWorker | null {
  pruneBridges();
  const first = bridgeWorkers.values().next();
  return first.done ? null : first.value;
}

function waitForBridgeAnswer(callId: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const ans = bridgeAnswers.get(callId);
      if (ans) {
        clearInterval(timer);
        bridgeAnswers.delete(callId);
        resolve(ans);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, 250);
  });
}
const recentCalls: CallSession[] = [
  {
    id: 'call_seed_1',
    callerNumber: '+1 (555) 234-8901',
    callerName: 'Elena Rostova',
    direction: 'inbound',
    status: 'ended',
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    endedAt: new Date(Date.now() - 3510000).toISOString(),
    durationSeconds: 90,
    packetsIn: 900,
    packetsOut: 840,
    avgLatencyMs: 245,
    interruptionsCount: 1,
    turns: [
      { speaker: 'caller', text: 'Hello, I wanted to check if order 4819 has shipped yet?', timestamp: '00:03' },
      { speaker: 'gemini', text: 'Hello Elena! Let me check that for you. Order 4819 shipped yesterday via DHL Express and is estimated to arrive tomorrow by 4 PM.', timestamp: '00:07' },
      { speaker: 'caller', text: 'Awesome, thank you so much!', timestamp: '00:15' },
      { speaker: 'gemini', text: "You're very welcome! Have a fantastic day ahead.", timestamp: '00:18' }
    ]
  },
  {
    id: 'call_seed_2',
    callerNumber: '+44 7911 123456',
    callerName: 'David Miller',
    direction: 'inbound',
    status: 'ended',
    startedAt: new Date(Date.now() - 7200000).toISOString(),
    endedAt: new Date(Date.now() - 7140000).toISOString(),
    durationSeconds: 60,
    packetsIn: 600,
    packetsOut: 580,
    avgLatencyMs: 230,
    interruptionsCount: 0,
    turns: [
      { speaker: 'caller', text: 'Hi there, what are your opening hours on Saturday?', timestamp: '00:04' },
      { speaker: 'gemini', text: 'Our branches are open on Saturday from 9:00 AM to 5:00 PM GMT.', timestamp: '00:08' },
      { speaker: 'caller', text: 'Perfect, thank you.', timestamp: '00:12' }
    ]
  }
];

// ---------------------------------------------------------------------------
// Structured pipeline logging: every pickup stage emits a correlated entry to
// the console (Cloud Run Logs Explorer) AND an in-memory ring buffer served at
// GET /api/logs, SSE /api/logs/stream, and GET /api/calls/:id/timeline.
// Cloud Console filters to try:  "pickup"  |  "[livekit]"  |  "[gemini]"  |
// "[meta]"  |  "[media]"  |  "[<callId>]"
// ---------------------------------------------------------------------------
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  stage: string;
  callId?: string;
  msg: string;
  data?: any;
}

const LOG_BUFFER_MAX = 1500;
const logBuffer: LogEntry[] = [];
const logStreamClients = new Set<any>();
const loggedFirstAudioIn = new Set<string>();
const loggedFirstAudioOut = new Set<string>();

// Short display form for call IDs (notably long Meta `wacid.*` IDs) so
// console / Cloud Run log lines stay readable. The structured `callId` field
// on the entry (and /api/logs, timeline) always keeps the full ID.
function shortId(id?: string): string {
  if (!id) return '';
  const stripped = id.replace(/^wacid[._-]?/i, '');
  if (stripped.length <= 8) return stripped;
  return `${stripped.slice(0, 4)}…${stripped.slice(-4)}`;
}

function plog(level: LogLevel, stage: string, msg: string, opts?: { callId?: string; data?: any }) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    stage,
    callId: opts?.callId,
    msg,
    ...(opts?.data !== undefined ? { data: opts.data } : {}),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);

  // Single-line console output for Cloud Run Logs Explorer.
  // Tag uses the short ID; the full ID stays in the structured entry.
  const dataStr = opts?.data !== undefined ? ` :: ${JSON.stringify(opts.data)}` : '';
  const line = `[${entry.ts}][${level.toUpperCase()}][${stage}]${entry.callId ? `[${shortId(entry.callId)}]` : ''} ${msg}${dataStr}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  // Fan out to live SSE tails.
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logStreamClients) {
    try {
      res.write(payload);
    } catch {
      logStreamClients.delete(res);
    }
  }
}

// Per-call pipeline stage tracker (surfaced in GET /api/calls + timeline).
function setStage(callId: string, stage: string, detail?: string, level: LogLevel = 'info') {
  const call = callSessions.get(callId);
  if (call) {
    call.pickupStage = stage;
    call.stageHistory = call.stageHistory || [];
    call.stageHistory.push({ stage, ts: new Date().toISOString(), ...(detail ? { detail } : {}) });
  }
  plog(level, 'pickup', `stage=${stage}${detail ? ` :: ${detail}` : ''}`, { callId });
}

// Helper: Convert μ-law sample to Linear PCM 16-bit
function mulawToLinear(muLawByte: number): number {
  muLawByte = ~muLawByte;
  const sign = muLawByte & 0x80;
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign !== 0 ? -sample : sample;
}

// Convert 8kHz μ-law buffer to 16kHz Linear PCM buffer
function resampleMulawToPCM16(mulawBuffer: Buffer): Buffer {
  const pcm16Samples: number[] = [];
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = mulawToLinear(mulawBuffer[i]);
    // Upsample 8kHz to 16kHz by 2x duplication/interpolation
    pcm16Samples.push(sample);
    pcm16Samples.push(sample);
  }
  const outBuffer = Buffer.alloc(pcm16Samples.length * 2);
  for (let i = 0; i < pcm16Samples.length; i++) {
    outBuffer.writeInt16LE(pcm16Samples[i], i * 2);
  }
  return outBuffer;
}

// Linear PCM 16-bit sample -> μ-law byte (for Twilio/media-bridge playback)
function linearToMulaw(sample: number): number {
  const MU_LAW_MAX = 32124;
  const BIAS = 0x84;
  let s = Math.max(-MU_LAW_MAX, Math.min(MU_LAW_MAX, sample));
  const sign = s < 0 ? 0x80 : 0x00;
  if (s < 0) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Downsample 24kHz PCM16 -> 8kHz μ-law (Gemini output -> telephony)
function resamplePCM24kToMulaw8k(pcm24kBase64: string): Buffer {
  const raw = Buffer.from(pcm24kBase64, 'base64');
  const sampleCount = Math.floor(raw.length / 2);
  const out: number[] = [];
  for (let i = 0; i < sampleCount; i += 3) {
    out.push(linearToMulaw(raw.readInt16LE(i * 2)));
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// LiveKit room orchestration (real SDK: RoomServiceClient + AccessToken)
// Each WhatsApp call gets its own room: wa_<callId>. The Gemini bridge agent
// and any media-bridge worker join with the minted tokens (TCP/TLS — works
// from Cloud Run, unlike raw UDP/RTP).
// ---------------------------------------------------------------------------
async function ensureLiveKitRoom(callId: string, callerName: string) {
  const cached = livekitRooms.get(callId);
  if (cached) {
    plog('debug', 'livekit', `reusing room ${cached.roomName}`, { callId });
    return cached;
  }
  if (!roomService || !livekitConfigured) {
    plog('warn', 'livekit', 'skipped — LIVEKIT_URL/API_KEY/API_SECRET not fully set', { callId });
    return null;
  }

  const roomName = `wa_${callId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}`;
  const t0 = Date.now();
  plog('info', 'livekit', `creating room ${roomName} ...`, { callId });
  try {
    try {
      await roomService.createRoom({ name: roomName, emptyTimeout: 10 * 60, maxParticipants: 10 });
    } catch (e: any) {
      // Room already exists — fine, reuse it.
      if (!String(e?.message || e).toLowerCase().includes('exist')) throw e;
      plog('debug', 'livekit', `room ${roomName} already exists, reusing`, { callId });
    }

    const mint = async (identity: string, name: string) => {
      const token = new AccessToken(livekitApiKey, livekitApiSecret, {
        identity,
        name,
        ttl: '2h',
      });
      token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
      return await token.toJwt();
    };

    const info = {
      roomName,
      agentToken: await mint(`agent_${callId}`.slice(0, 100), 'Gemini Voice Agent'),
      callerToken: await mint(`caller_${callId}`.slice(0, 100), callerName),
    };
    livekitRooms.set(callId, info);
    plog('info', 'livekit', `room ready: ${roomName} (tokens minted)`, { callId, data: { tookMs: Date.now() - t0, roomName } });
    return info;
  } catch (e: any) {
    plog('error', 'livekit', 'room setup failed', { callId, data: { error: e?.message || String(e), tookMs: Date.now() - t0 } });
    return null;
  }
}

function livekitWsUrl(): string {
  // Convert wss://host / https://host to https://host for token endpoint hints.
  return livekitUrl;
}

// ---------------------------------------------------------------------------
// Server-side Gemini Live session per call (the DIRECT connect).
// Audio in:  PCM 16kHz base64 via sendRealtimeInput.
// Audio out: PCM 24kHz base64 -> media bridges + dashboard monitors.
// ---------------------------------------------------------------------------
function buildGeminiTools() {
  return [
    {
      functionDeclarations: [
        {
          name: 'check_order_status',
          description: 'Look up a WhatsApp order shipping status by order ID.',
          parameters: { type: 'OBJECT' as any, properties: { orderId: { type: 'STRING' as any } } },
        },
        {
          name: 'book_appointment',
          description: 'Book an appointment for the caller.',
          parameters: {
            type: 'OBJECT' as any,
            properties: { date: { type: 'STRING' as any }, time: { type: 'STRING' as any } },
          },
        },
        {
          name: 'get_business_hours',
          description: 'Get branch opening hours.',
          parameters: { type: 'OBJECT' as any, properties: {} },
        },
        {
          name: 'escalate_to_human',
          description: 'Create a priority ticket and escalate to a human agent.',
          parameters: {
            type: 'OBJECT' as any,
            properties: { reason: { type: 'STRING' as any } },
          },
        },
      ],
    },
  ];
}

function resolveToolResult(name: string, args: any) {
  if (name === 'check_order_status') {
    return {
      orderId: args?.orderId || 'WA-8921',
      status: 'Shipped',
      carrier: 'FedEx Priority',
      estimatedDelivery: 'Tomorrow, 2:30 PM',
      items: ['Wireless Noise Cancelling Earbuds Pro', 'USB-C Braided Cable 2m'],
    };
  }
  if (name === 'book_appointment') {
    return {
      appointmentId: `APT-${Math.floor(1000 + Math.random() * 9000)}`,
      date: args?.date || 'Tomorrow',
      time: args?.time || '11:00 AM',
      confirmed: true,
      confirmationSentViaWhatsApp: true,
    };
  }
  if (name === 'get_business_hours') {
    return { mondayToFriday: '8:00 AM - 8:00 PM EST', saturday: '9:00 AM - 5:00 PM EST', sunday: 'Closed' };
  }
  if (name === 'escalate_to_human') {
    return { ticketCreated: true, queuePosition: 2, estimatedWaitMinutes: 3 };
  }
  return { status: 'ok' };
}

async function startGeminiLiveForCall(callId: string): Promise<boolean> {
  if (geminiSessions.has(callId)) return true;
  const call = callSessions.get(callId);
  if (!call) return false;

  if (!apiKey) {
    setStage(callId, 'gemini_failed', 'GEMINI_API_KEY missing on server', 'error');
    console.error('[Gemini Live] GEMINI_API_KEY missing — cannot auto-answer call', callId);
    notifySockets({ type: 'live_error', callId, error: 'GEMINI_API_KEY missing on server' });
    return false;
  }

  const modelsToTry = [GEMINI_LIVE_MODEL, GEMINI_LIVE_FALLBACK_MODEL].filter((m, i, arr) => m && arr.indexOf(m) === i);

  for (const model of modelsToTry) {
    try {
      const t0 = Date.now();
      setStage(callId, 'gemini_connecting', model);
      console.log(`[Gemini Live] Connecting model ${model} for call ${callId}...`);
      notifySockets({ type: 'live_status', callId, status: 'connecting', message: `Initializing ${model}...` });

      const session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: gatewayConfig.voiceName } },
          },
          systemInstruction: gatewayConfig.systemPrompt,
          tools: buildGeminiTools() as any,
        } as any,
        callbacks: {
          onopen: () => {
            console.log(`[Gemini Live] Session open for call ${callId} (${model})`);
            setStage(callId, 'gemini_connected', `${model} open in ${Date.now() - t0}ms`);
            call.geminiConnected = true;
            if (call.status === 'ringing') call.status = 'connected';
            notifySockets({ type: 'live_status', callId, status: 'connected', message: `${model} connected and listening.`, model, origin: call.origin || 'telephony' });
            notifySockets({ type: 'call_connected_meta', callId, roomName: call.livekitRoom || `wa_${callId}`, origin: call.origin || 'telephony', model });
          },
          onmessage: (message: any) => {
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts && parts.length > 0) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  const queue = geminiAudioOutbox.get(callId) || [];
                  queue.push(part.inlineData.data);
                  geminiAudioOutbox.set(callId, queue);
                  // Fan out to dashboard monitors + media bridges. Dashboards
                  // must ignore telephony audio (origin tag below) — the phone
                  // call owns that audio, never the open browser tab.
                  notifySockets({
                    type: 'audio_chunk',
                    callId,
                    origin: call.origin || 'telephony',
                    audio: part.inlineData.data,
                    mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                  });
                  flushGeminiAudioToBridges(callId);
                }
                if (part.text) {
                  call.turns.push({ speaker: 'gemini', text: part.text, timestamp: new Date().toISOString() });
                  notifySockets({ type: 'transcript_chunk', callId, origin: call.origin || 'telephony', speaker: 'gemini', text: part.text });
                }
              }
            }
            if (message.serverContent?.interrupted) {
              call.status = 'interrupted';
              call.interruptionsCount += 1;
              notifySockets({ type: 'interrupted', callId, origin: call.origin || 'telephony', message: 'Gemini output halted by caller speech' });
              // Barge-in must also stop audio already delivered to telephony.
              // The worker holds up to seconds of buffered Gemini speech that
              // would otherwise keep playing over the caller — flush it there
              // and discard anything still queued here.
              geminiAudioOutbox.set(callId, []);
              const bridges = callMediaBridges.get(callId);
              if (bridges) {
                for (const client of bridges) {
                  try {
                    if (client.readyState === WebSocket.OPEN) {
                      client.send(JSON.stringify({ type: 'flush_audio', callId }));
                    }
                  } catch { /* ignore per-bridge errors */ }
                }
              }
              setTimeout(() => {
                if (call.status === 'interrupted') call.status = 'connected';
              }, 800);
            }
            if (message.toolCall) {
              const calls = message.toolCall.functionCalls || [];
              const responses = calls.map((toolCall: any) => {
                const result = resolveToolResult(toolCall.name, toolCall.args);
                call.turns.push({
                  speaker: 'gemini',
                  text: `[Action: ${toolCall.name}] -> ${JSON.stringify(result)}`,
                  timestamp: new Date().toISOString(),
                });
                notifySockets({ type: 'function_executed', callId, origin: call.origin || 'telephony', name: toolCall.name, args: toolCall.args, result });
                return { id: toolCall.id, name: toolCall.name, response: { result } };
              });
              try {
                (session as any)?.sendToolResponse?.({ functionResponses: responses });
              } catch (e) {
                console.warn('[Gemini Live] sendToolResponse failed:', e);
              }
            }
          },
          onerror: (err: any) => {
            console.error(`[Gemini Live Error] call ${callId}:`, err?.message || err);
            notifySockets({ type: 'live_error', callId, origin: call.origin || 'telephony', error: err?.message || 'Gemini Live session error' });
          },
          onclose: (e: any) => {
            console.log(`[Gemini Live] Session closed for call ${callId}:`, e?.reason || 'Normal close');
            plog('warn', 'gemini', `session closed: ${e?.reason || 'normal close'}`, { callId });
            geminiSessions.delete(callId);
            if (call.geminiConnected) {
              call.geminiConnected = false;
              notifySockets({ type: 'live_status', callId, origin: call.origin || 'telephony', status: 'disconnected', message: 'Gemini Live session disconnected' });
            }
          },
        },
      });

      geminiSessions.set(callId, session);

      // Auto-greet the real caller the moment the line is answered.
      try {
        (session as any)?.sendClientContent?.({
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: `A WhatsApp voice call just connected from ${call.callerName} (${call.callerNumber}). You are ${gatewayConfig.personaName}. Greet them warmly by name and offer your assistance in 1-2 short sentences.`,
                },
              ],
            },
          ],
          turnComplete: true,
        });
        plog('info', 'gemini', 'auto-greeting sent to caller', { callId });
      } catch (e) {
        plog('warn', 'gemini', 'greeting send failed', { callId, data: { error: (e as any)?.message || String(e) } });
        console.warn('[Gemini Live] greeting send failed:', e);
      }

      console.log(`[Gemini Live] Session established for call ${callId} (${model})`);
      return true;
    } catch (err: any) {
      setStage(callId, 'gemini_failed', `${model}: ${err?.message || err}`, 'error');
      console.error(`[Gemini Live] Connect failed for model ${model}:`, err?.message || err);
      notifySockets({ type: 'live_error', callId, model, error: err?.message || `Failed to connect ${model}` });
    }
  }
  return false;
}

function sendAudioToGemini(callId: string, pcm16kBase64: string) {
  const session = geminiSessions.get(callId);
  if (!session) return false;
  try {
    try {
      session.sendRealtimeInput({ audio: { data: pcm16kBase64, mimeType: 'audio/pcm;rate=16000' } });
    } catch {
      session.sendRealtimeInput({ mediaChunks: [{ data: pcm16kBase64, mimeType: 'audio/pcm;rate=16000' }] });
    }
    const call = callSessions.get(callId);
    if (call) {
      call.packetsIn += 1;
      if (!loggedFirstAudioIn.has(callId)) {
        loggedFirstAudioIn.add(callId);
        setStage(callId, 'media_flowing_in', 'first caller audio frames reached Gemini');
      }
      if (call.status === 'connected') call.status = 'speaking';
    }
    return true;
  } catch (e) {
    console.warn('[Gemini Live] sendRealtimeInput failed:', e);
    return false;
  }
}

// Uplink coalescing: telephony bridges deliver ~20ms frames (640B PCM16).
// Forwarding each one as its own sendRealtimeInput = ~50 API writes/sec of
// overhead. Coalesce to ~40ms (1280B) so Gemini gets fewer, larger writes
// with the same audio bytes. Worker-batched 40ms+ chunks skip the wait and
// flush immediately — no added latency on the WhatsApp path.
const geminiInbox = new Map<string, { buf: Buffer; timer: any }>();
const GEMINI_FLUSH_BYTES = 1280; // 40ms @ 16kHz s16le mono
const GEMINI_FLUSH_MS = 40;

function flushGeminiInbox(callId: string) {
  const entry = geminiInbox.get(callId);
  if (!entry || entry.buf.length === 0) return;
  const out = entry.buf;
  entry.buf = Buffer.alloc(0);
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  sendAudioToGemini(callId, out.toString('base64'));
}

function queueAudioForGemini(callId: string, pcm16: Buffer) {
  if (pcm16.length >= GEMINI_FLUSH_BYTES) {
    // Already a full frame (WhatsApp worker path) — send now, plus piggyback
    // anything small that was waiting so order is preserved.
    const pending = geminiInbox.get(callId);
    if (pending && pending.buf.length > 0) {
      const combined = Buffer.concat([pending.buf, pcm16]);
      pending.buf = Buffer.alloc(0);
      if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
      sendAudioToGemini(callId, combined.toString('base64'));
    } else {
      sendAudioToGemini(callId, pcm16.toString('base64'));
    }
    return;
  }
  let entry = geminiInbox.get(callId);
  if (!entry) {
    entry = { buf: Buffer.alloc(0), timer: null };
    geminiInbox.set(callId, entry);
  }
  entry.buf = Buffer.concat([entry.buf, pcm16]);
  if (entry.buf.length >= GEMINI_FLUSH_BYTES) {
    flushGeminiInbox(callId);
  } else if (!entry.timer) {
    entry.timer = setTimeout(() => flushGeminiInbox(callId), GEMINI_FLUSH_MS);
  }
}

function closeGeminiSession(callId: string) {
  const session = geminiSessions.get(callId);
  geminiSessions.delete(callId);
  geminiAudioOutbox.delete(callId);
  const inbox = geminiInbox.get(callId);
  if (inbox?.timer) clearTimeout(inbox.timer);
  geminiInbox.delete(callId);
  loggedFirstAudioIn.delete(callId);
  loggedFirstAudioOut.delete(callId);
  if (session) {
    try {
      if (typeof session.close === 'function') session.close();
      else if (session.conn?.close) session.conn.close();
    } catch { /* ignore */ }
  }
}

// Media bridges (Twilio / LiveKit agent worker / SIP gateway) subscribe here.
const callMediaBridges: Map<string, Set<WebSocket>> = new Map();

function flushGeminiAudioToBridges(callId: string) {
  const bridges = callMediaBridges.get(callId);
  if (!bridges || bridges.size === 0) return;
  const queue = geminiAudioOutbox.get(callId);
  if (!queue || queue.length === 0) return;
  geminiAudioOutbox.set(callId, []);
  if (!loggedFirstAudioOut.has(callId)) {
    loggedFirstAudioOut.add(callId);
    setStage(callId, 'media_flowing_out', 'first Gemini voice frames produced');
  }

  for (const client of bridges) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const kind = (client as any).__bridgeKind || 'raw';
    for (const pcm24 of queue) {
      try {
        if (kind === 'twilio') {
          // Twilio expects 8kHz μ-law frames (~20ms each).
          const mulaw = resamplePCM24kToMulaw8k(pcm24);
          const streamSid = (client as any).__streamSid || '';
          for (let i = 0; i < mulaw.length; i += 160) {
            client.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: mulaw.subarray(i, i + 160).toString('base64') },
            }));
          }
        } else {
          client.send(JSON.stringify({ type: 'gemini_audio', callId, audio: pcm24, mimeType: 'audio/pcm;rate=24000' }));
        }
      } catch { /* ignore per-bridge errors */ }
    }
  }
  const call = callSessions.get(callId);
  if (call) call.packetsOut += queue.length;
}

// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API: accept the call (signaling = HTTPS, works on
// Cloud Run). Respond 200 to the webhook FIRST, then run this async.
// ---------------------------------------------------------------------------
function generateSdpAnswer(offerSdp: string): string {
  const payloadMatch = offerSdp.match(/m=audio\s+\d+\s+\S+\s+([\d\s]+)/);
  const payloads = payloadMatch ? payloadMatch[1].trim().split(/\s+/) : ['111'];
  const opusPayload = payloads.includes('111') ? '111' : payloads[0] || '111';
  const midMatch = offerSdp.match(/a=mid:([^\r\n]+)/);
  const mid = midMatch ? midMatch[1].trim() : 'audio';

  const announceIp = MEDIA_ANNOUNCE_IP || '0.0.0.0';
  if (!MEDIA_ANNOUNCE_IP) {
    console.warn('[SDP] MEDIA_ANNOUNCE_IP not set — answering with 0.0.0.0. Set it to your LiveKit/media-bridge public IP or calls will not carry audio.');
  }

  const ufrag = crypto.randomBytes(4).toString('hex');
  const pwd = crypto.randomBytes(14).toString('base64').replace(/[^a-zA-Z0-9]/g, 'X');
  const fingerprint =
    process.env.MEDIA_DTLS_FINGERPRINT ||
    '73:F2:08:6C:27:99:83:66:45:35:F9:06:C9:AC:47:6D:31:83:41:85:A4:FC:72:06:E4:CC:44:8D:52:CB:35:DA';

  return [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 ${announceIp}`,
    's=WhatsAppGeminiLive',
    't=0 0',
    'a=msid-semantic: WMS WhatsAppGeminiLive',
    `m=audio ${MEDIA_PORT} UDP/TLS/RTP/SAVPF ${opusPayload}`,
    `c=IN IP4 ${announceIp}`,
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    'a=setup:active',
    `a=mid:${mid}`,
    'a=sendrecv',
    'a=rtcp-mux',
    `a=rtpmap:${opusPayload} opus/48000/2`,
    `a=fmtp:${opusPayload} maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1`,
    'a=ptime:20',
    `a=candidate:1 1 udp 2130706431 ${announceIp} ${MEDIA_PORT} typ host`,
    '',
  ].join('\r\n');
}

async function acceptMetaCall(
  callId: string,
  phoneNumberId: string,
  sdpOffer: string,
  token: string,
  sdpAnswerOverride?: string,
): Promise<string> {
  const sdpAnswer = sdpAnswerOverride || generateSdpAnswer(sdpOffer);
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/calls`;
  const t0 = Date.now();
  // NOTE: token + full SDP are deliberately never logged.
  plog('info', 'meta', `POST accept call (sdp offer ${sdpOffer.length}B -> answer ${sdpAnswer.length}B)`, {
    callId,
    data: { url, phoneNumberId, graphVersion: META_GRAPH_VERSION, answeredBy: sdpAnswerOverride ? 'bridge-worker' : 'server' },
  });
  console.log(`[Meta Cloud API] Accepting WhatsApp call ${callId} via ${url} ...`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      call_id: callId,
      action: 'accept',
      session: { sdp_type: 'answer', sdp: sdpAnswer },
    }),
  });
  const data = await res.json().catch(() => ({}));
  console.log('[Meta Cloud API] Accept response:', JSON.stringify(data));
  const tookMs = Date.now() - t0;
  if (res.ok && (data as any).success !== false && !(data as any).error) {
    setStage(callId, 'meta_accepted', `HTTP ${res.status} in ${tookMs}ms`);
    return 'accepted_via_graph_api';
  }
  const errMsg = (data as any)?.error?.message || JSON.stringify(data);
  setStage(callId, 'meta_failed', `HTTP ${res.status}: ${errMsg}`, 'error');
  return `meta_error: ${errMsg}`;
}

// ---------------------------------------------------------------------------
// Core pickup pipeline: register -> LiveKit room -> Gemini Live -> Meta accept
// ---------------------------------------------------------------------------
async function processIncomingCall(opts: {
  callId: string;
  caller: string;
  callerName: string;
  sdpOffer: string;
  phoneNumberId: string;
  origin?: 'telephony' | 'browser';
}) {
  const { callId, caller, callerName, sdpOffer, phoneNumberId } = opts;
  const pipeStart = Date.now();
  let call = callSessions.get(callId);
  if (!call) {
    call = {
      id: callId,
      callerNumber: caller,
      callerName,
      direction: 'inbound',
      origin: opts.origin || 'telephony',
      status: 'ringing',
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      packetsIn: 0,
      packetsOut: 0,
      avgLatencyMs: 0,
      interruptionsCount: 0,
      turns: [],
    };
    callSessions.set(callId, call);
  }
  // Keep the latest SDP offer for the bridge worker (never logged in full).
  if (sdpOffer) call.sdpOffer = sdpOffer;
  // The bridge pending endpoint requires this stage in stageHistory. Record it
  // only after the session has been created so it is not merely log output.
  setStage(callId, 'pickup_started', `from ${caller} (${callerName}), sdp=${sdpOffer ? `${sdpOffer.length}B` : 'none'}`);

  // LiveKit room + Gemini Live + Meta accept are INDEPENDENT — run them
  // concurrently. Sequential cold starts were costing 40s+ of ringing
  // (LiveKit ~10s, Gemini ~12s, Meta POST ~16s). Parallel => slowest leg wins.
  setStage(callId, 'livekit_start');
  const roomPromise = ensureLiveKitRoom(callId, callerName).then((room) => {
    if (room) {
      call.livekitRoom = room.roomName;
      setStage(callId, 'livekit_ready', room.roomName);
    } else {
      setStage(callId, 'livekit_skipped', 'continuing without room — direct Gemini bridge only', 'warn');
    }
    return room;
  });

  notifySockets({
    type: 'incoming_call_event',
    call,
    hasSdpOffer: Boolean(sdpOffer),
    livekitRoom: null, // room still creating; final name arrives with call_connected_meta
    livekitUrl: livekitConfigured ? livekitWsUrl() : null,
    agentToken: null,
  });

  if (!gatewayConfig.autoAcceptCalls) {
    console.log(`[Pickup] autoAcceptCalls=off — call ${callId} left ringing for manual accept.`);
    const room = await roomPromise;
    return { acceptStatus: 'manual_accept_required', roomName: room?.roomName || null };
  }

  // 2. DIRECT connect: Gemini Live session starts NOW — no browser click.
  const geminiPromise = startGeminiLiveForCall(callId);

  // 3. Signaling accept toward Meta (needs token + SDP offer). No dependency
  // on the legs above, except the bridge path which needs the worker's answer.
  const token = gatewayConfig.metaAccessToken || process.env.META_ACCESS_TOKEN || '';
  const doAccept = async (answerOverride: string | null): Promise<string> => {
    if (token && sdpOffer && phoneNumberId) {
      try {
        const s = await acceptMetaCall(callId, phoneNumberId, sdpOffer, token, answerOverride || undefined);
        if (s.startsWith('accepted')) {
          call.status = 'connected';
        }
        return s;
      } catch (err: any) {
        console.error('[Meta Cloud API] Accept failed:', err?.message || err);
        return `exception: ${err?.message || err}`;
      }
    }
    if (!token) {
      setStage(callId, 'meta_skipped', 'META_ACCESS_TOKEN missing — Gemini is live but Meta-side still rings', 'warn');
      console.warn('[Pickup] META_ACCESS_TOKEN missing — signaling accept skipped. Gemini session is live; add token to auto-answer Meta-side ringing.');
      return 'missing_meta_token';
    }
    setStage(callId, 'meta_skipped', 'no SDP offer in webhook — Gemini live, media bridge/Twilio path only', 'warn');
    console.warn('[Pickup] Webhook had no SDP offer — Gemini session is live; media bridge / Twilio path can still carry audio.');
    return 'no_sdp_offer_in_webhook';
  };

  // Headless audio: if a UDP-capable bridge worker is alive, it terminates
  // the WhatsApp RTP, joins the LiveKit room, and pipes audio to Gemini.
  // Room tokens must exist before the worker can act, and the Meta accept
  // needs the worker's SDP answer — so only this path stays sequential.
  const worker = liveBridge();
  let acceptPromise: Promise<string>;
  if (worker && sdpOffer) {
    acceptPromise = (async () => {
      await roomPromise; // tokens ready for GET /api/bridge/pending
      setStage(callId, 'waiting_bridge', `worker ${worker.id} @ ${worker.publicIp || 'unknown-ip'}`);
      const bridgeAnswer = await waitForBridgeAnswer(callId, 9000);
      if (bridgeAnswer) {
        setStage(callId, 'bridge_answered', `SDP answer from worker ${worker.id} (${bridgeAnswer.length}B)`);
      } else {
        setStage(callId, 'bridge_timeout', 'no worker answer in 9s — falling back to server SDP', 'warn');
      }
      return doAccept(bridgeAnswer);
    })();
  } else {
    if (sdpOffer && !worker) {
      plog('debug', 'pickup', 'no bridge worker alive — server answers SDP directly (audio needs UDP bridge/Twilio path)', { callId });
    }
    acceptPromise = doAccept(null); // fires immediately, alongside room + Gemini
  }

  const [room, geminiOk, acceptStatus] = await Promise.all([roomPromise, geminiPromise, acceptPromise]);
  if (!geminiOk) {
    setStage(callId, 'pickup_failed', 'gemini session could not start — check [gemini] logs', 'error');
  }

  notifySockets({
    type: 'call_connected_meta',
    callId,
    roomName: room?.roomName || `wa_${callId}`,
    origin: call.origin || 'telephony',
    acceptStatus,
    geminiConnected: geminiOk,
  });

  console.log(`[Pickup] call=${callId} gemini=${geminiOk ? 'connected' : 'FAILED'} accept=${acceptStatus}`);
  setStage(
    callId,
    geminiOk && acceptStatus.startsWith('accepted') ? 'pickup_complete' : 'pickup_partial',
    `total ${Date.now() - pipeStart}ms, gemini=${geminiOk}, accept=${acceptStatus}`,
    geminiOk ? 'info' : 'error',
  );
  return { acceptStatus, roomName: room?.roomName || null, geminiConnected: geminiOk };
}

function endCall(callId: string, reason = 'ended') {
  const call = callSessions.get(callId);
  const endedOrigin = call?.origin || 'telephony';
  if (call) {
    const secs = Math.round((Date.now() - new Date(call.startedAt).getTime()) / 1000);
    plog('info', 'pickup', `call ended: reason=${reason}, duration≈${secs}s`, {
      callId,
      data: { packetsIn: call.packetsIn, packetsOut: call.packetsOut, turns: call.turns.length, stage: call.pickupStage },
    });
    call.status = 'ended';
    call.endedAt = new Date().toISOString();
    recentCalls.unshift({ ...call });
    callSessions.delete(callId);
  } else {
    plog('debug', 'pickup', `endCall for unknown call (reason=${reason})`, { callId });
  }
  closeGeminiSession(callId);
  const bridges = callMediaBridges.get(callId);
  if (bridges) {
    for (const ws of bridges) {
      try { ws.close(); } catch { /* ignore */ }
    }
    callMediaBridges.delete(callId);
  }
  const room = livekitRooms.get(callId);
  if (room && roomService) {
    roomService.deleteRoom(room.roomName).catch(() => {});
    livekitRooms.delete(callId);
  }
  notifySockets({ type: 'call_ended', callId, reason, origin: endedOrigin });
}

// REST API Endpoints

// 1. Health & Server Status
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    hasApiKey: Boolean(apiKey),
    model: GEMINI_LIVE_MODEL,
    livekitConfigured,
    autoAccept: gatewayConfig.autoAcceptCalls,
    mediaAnnounceIp: MEDIA_ANNOUNCE_IP || null,
    activeCalls: Array.from(callSessions.values()).filter((c) => c.status !== 'ended').length,
    activeGeminiSessions: geminiSessions.size,
  });
});

// 2. Gateway Configuration
app.get('/api/whatsapp/config', (req: Request, res: Response) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  const base = PUBLIC_BASE_URL || `${protocol}://${host}`;

  res.json({
    config: { ...gatewayConfig, metaAccessToken: gatewayConfig.metaAccessToken ? '***set***' : '' },
    endpoints: {
      webhookUrl: `${base}/api/whatsapp/webhook`,
      twilioVoiceUrl: `${base}/api/twilio/voice`,
      browserWsUrl: `${wsProtocol}://${host}/ws/whatsapp-call`,
      mediaStreamWsUrl: `${wsProtocol}://${host}/ws/media-stream`,
    },
  });
});

app.post('/api/whatsapp/config', (req: Request, res: Response) => {
  const updates = req.body;
  // Never allow masking placeholder to wipe the real token.
  if (updates.metaAccessToken === '***set***') delete updates.metaAccessToken;
  gatewayConfig = {
    ...gatewayConfig,
    ...updates,
  };
  res.json({ success: true, config: { ...gatewayConfig, metaAccessToken: gatewayConfig.metaAccessToken ? '***set***' : '' } });
});

// LiveKit token for the agent worker / dashboard monitor to join the call room.
app.get('/api/livekit/token', async (req: Request, res: Response) => {
  if (!livekitConfigured) {
    res.status(503).json({ error: 'LiveKit not configured (LIVEKIT_URL/API_KEY/API_SECRET)' });
    return;
  }
  const roomName = String(req.query.room || '');
  const identity = String(req.query.identity || `monitor_${Date.now()}`);
  if (!roomName) {
    res.status(400).json({ error: 'Missing ?room=' });
    return;
  }
  try {
    const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity, name: identity, ttl: '2h' });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ token: await token.toJwt(), url: livekitUrl, room: roomName });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Token mint failed' });
  }
});

// 3. Meta WhatsApp Cloud API Webhook Verification (hub.challenge)
app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === gatewayConfig.verifyToken) {
    console.log('[WhatsApp Webhook] Verification successful');
    res.status(200).send(challenge);
  } else {
    console.warn('[WhatsApp Webhook] Verification failed token mismatch');
    res.status(403).send('Forbidden');
  }
});

// 4. Meta WhatsApp Cloud API Webhook Event Handler (Incoming Calls / Status)
// IMPORTANT: acknowledge within seconds, then process pickup async.
app.post('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const payload = req.body;
  console.log('[WhatsApp Webhook] Received event:', JSON.stringify(payload, null, 2));

  const entry = payload?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  let callId = '';
  let caller = '';
  let callerName = 'WhatsApp Caller';
  let sdpOffer = '';
  let eventType = '';
  let phoneNumberId = value?.metadata?.phone_number_id || gatewayConfig.phoneNumberId;

  const contactName = value?.contacts?.[0]?.profile?.name;

  if (value?.calls && value.calls.length > 0) {
    const callData = value.calls[0];
    callId = callData.id || `wa_call_${Date.now()}`;
    caller = callData.from || callData.caller_id || '+15550000000';
    callerName = contactName || callData.name || callData.display_name || 'WhatsApp Caller';
    eventType = String(callData.event || callData.status || '').toLowerCase();
    if (callData.session?.sdp) {
      sdpOffer = callData.session.sdp;
    } else if (typeof callData.sdp === 'string') {
      sdpOffer = callData.sdp;
    }
  } else if (payload.CallSid || payload.CallDuration || payload.From) {
    callId = payload.CallSid || `twilio_call_${Date.now()}`;
    caller = (payload.From || '').replace('whatsapp:', '') || '+15550000000';
    callerName = payload.CallerName || contactName || 'WhatsApp Caller';
  } else if (payload.event === 'incoming_call' || payload.call_id || payload.caller) {
    callId = payload.call_id || `sip_call_${Date.now()}`;
    caller = payload.caller || payload.from || '+15550000000';
    callerName = payload.caller_name || contactName || 'WhatsApp Caller';
  }

  if (callId) {
    plog('info', 'webhook', `incoming call parsed: event=${eventType || '(none)'} sdp=${sdpOffer ? `${sdpOffer.length}B` : 'MISSING'}`, {
      callId,
      data: { caller, callerName, phoneNumberId, contactName: contactName || null },
    });
  } else {
    plog('debug', 'webhook', 'payload has no call object — ack only');
  }

  if (!callId) {
    res.status(200).json({ status: 'received', message: 'Webhook acknowledged' });
    return;
  }

  // Remote hangup / reject / timeout -> tear down Gemini + LiveKit room.
  if (['terminate', 'terminated', 'ended', 'rejected', 'timeout', 'failed'].includes(eventType)) {
    console.log(`[WhatsApp Webhook] Call ${eventType}: ${callId}`);
    endCall(callId, eventType);
    res.status(200).json({ status: 'call_ended', callId });
    return;
  }

  // Respond IMMEDIATELY (Meta enforces a tight timeout), then auto-pickup async:
  // LiveKit room + DIRECT Gemini Live session + Meta signaling accept.
  res.status(200).json({
    status: 'call_received',
    callId,
    caller,
    callerName,
    autoAccept: gatewayConfig.autoAcceptCalls,
  });

  void processIncomingCall({ callId, caller, callerName, sdpOffer, phoneNumberId, origin: 'telephony' })
    .catch((err) => console.error('[Pickup] pipeline failed:', err));
});

// 5. Twilio Voice / WhatsApp Voice TwiML Webhook
app.post('/api/twilio/voice', (req: Request, res: Response) => {
  const host = req.get('host') || 'localhost:3000';
  const wsProtocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
  const streamUrl = `${wsProtocol}://${host}/ws/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting your WhatsApp call directly to Gemini Live Voice.</Say>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="geminiVoice" value="${gatewayConfig.voiceName}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// 6. Call Sessions List
app.get('/api/calls', (req: Request, res: Response) => {
  const active = Array.from(callSessions.values());
  res.json({
    active,
    recent: recentCalls,
  });
});

// 7. Simulate incoming call trigger (also goes through the real pickup pipeline)
app.post('/api/whatsapp/simulate-call', async (req: Request, res: Response) => {
  const { callerNumber, callerName } = req.body;
  const callId = `sim_call_${Date.now()}`;

  callSessions.set(callId, {
    id: callId,
    callerNumber: callerNumber || '+1 (555) 789-2041',
    callerName: callerName || 'Marcus Vance',
    direction: 'inbound',
    status: 'ringing',
    startedAt: new Date().toISOString(),
    durationSeconds: 0,
    packetsIn: 0,
    packetsOut: 0,
    avgLatencyMs: 0,
    interruptionsCount: 0,
    turns: [],
  });

  const result = await processIncomingCall({
    callId,
    caller: callerNumber || '+1 (555) 789-2041',
    callerName: callerName || 'Marcus Vance',
    sdpOffer: '',
    phoneNumberId: gatewayConfig.phoneNumberId,
    origin: 'browser',
  });

  res.json({ success: true, call: callSessions.get(callId), pickup: result });
});

// Manual accept (dashboard button / API) — starts Gemini Live immediately.
app.post('/api/calls/:id/accept', async (req: Request, res: Response) => {
  const { id } = req.params;
  const call = callSessions.get(id);
  if (!call) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  const result = await processIncomingCall({
    callId: id,
    caller: call.callerNumber,
    callerName: call.callerName,
    sdpOffer: '',
    phoneNumberId: gatewayConfig.phoneNumberId,
    origin: call.origin || 'browser',
  });
  res.json({ success: true, call: callSessions.get(id), pickup: result });
});

// Feed caller audio (base64 PCM 16k) into Gemini for a call — used by bridges.
app.post('/api/calls/:id/audio', (req: Request, res: Response) => {
  const { id } = req.params;
  const { audio } = req.body || {};
  if (!callSessions.has(id)) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  if (!audio) {
    res.status(400).json({ error: 'Missing audio (base64 PCM 16k)' });
    return;
  }
  const ok = sendAudioToGemini(id, audio);
  res.json({ success: ok });
});

// Drain queued Gemini output audio (base64 PCM 24k) — used by bridges.
app.get('/api/calls/:id/audio-out', (req: Request, res: Response) => {
  const { id } = req.params;
  const queue = geminiAudioOutbox.get(id) || [];
  geminiAudioOutbox.set(id, []);
  res.json({ callId: id, chunks: queue });
});

// 9. Pipeline logs (in-memory ring buffer, newest last in store)
app.get('/api/logs', (req: Request, res: Response) => {
  const level = String(req.query.level || '').toLowerCase();
  const callId = String(req.query.callId || '');
  const stage = String(req.query.stage || '').toLowerCase();
  const limit = Math.min(parseInt(String(req.query.limit || '300'), 10) || 300, LOG_BUFFER_MAX);
  let entries = logBuffer;
  if (level) entries = entries.filter((e) => e.level === level);
  if (callId) entries = entries.filter((e) => e.callId === callId);
  if (stage) entries = entries.filter((e) => e.stage === stage);
  res.json({ count: entries.length, logs: entries.slice(-limit).reverse() });
});

// Live tail of pipeline logs (Server-Sent Events)
app.get('/api/logs/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ hello: 'log-stream-connected' })}\n\n`);
  logStreamClients.add(res);
  req.on('close', () => {
    logStreamClients.delete(res);
  });
});

// Per-call timeline: stage history + correlated log entries
app.get('/api/calls/:id/timeline', (req: Request, res: Response) => {
  const call = callSessions.get(req.params.id) || recentCalls.find((c) => c.id === req.params.id);
  if (!call) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  const logs = logBuffer.filter((e) => e.callId === req.params.id);
  res.json({ call, logs });
});

// 10. Bridge worker API. A bridge worker is a UDP-capable process
// (see bridge-worker/) that terminates WhatsApp RTP audio, joins the
// LiveKit room, and pipes audio to/from Gemini over /ws/call-media/:callId.
// This is what makes calls fully headless — no browser involved.
app.post('/api/bridge/heartbeat', (req: Request, res: Response) => {
  const { workerId, publicIp } = req.body || {};
  if (!workerId) {
    res.status(400).json({ error: 'Missing workerId' });
    return;
  }
  bridgeWorkers.set(workerId, { id: workerId, publicIp: publicIp || '', lastSeen: Date.now() });
  pruneBridges();
  plog('debug', 'bridge', `heartbeat from worker ${workerId}`, { data: { publicIp: publicIp || null } });
  res.json({ ok: true, workers: bridgeWorkers.size });
});

// Calls waiting for a bridge worker to answer their SDP offer.
app.get('/api/bridge/pending', (req: Request, res: Response) => {
  pruneBridges();
  const wsBase = PUBLIC_BASE_URL.replace(/^http/, 'ws');
  const pending = [];
  for (const call of callSessions.values()) {
    if (!call.sdpOffer || call.status === 'ended') continue;
    // NOTE: pickupStage is a single last-writer field shared by the parallel
    // legs (LiveKit, Gemini, Meta accept), so testing it for equality hides
    // the call whenever Gemini wins the race (e.g. pickupStage becomes
    // gemini_connected before the worker polls). Use stageHistory instead:
    // pending until the pipeline started AND no terminal bridge/accept stage
    // has been reached yet.
    const history = (call.stageHistory || []).map((s) => s.stage);
    if (!history.includes('pickup_started')) continue;
    if (history.some((s) => ['bridge_answered', 'bridge_timeout', 'meta_accepted', 'meta_failed', 'meta_skipped', 'pickup_complete', 'pickup_partial'].includes(s))) continue;
    const room = livekitRooms.get(call.id);
    pending.push({
      callId: call.id,
      caller: call.callerNumber,
      callerName: call.callerName,
      sdpOffer: call.sdpOffer,
      roomName: room?.roomName || `wa_${call.id}`,
      livekitUrl: livekitConfigured ? livekitUrl : null,
      agentToken: room?.agentToken || null,
      callMediaWs: `${wsBase}/ws/call-media/${encodeURIComponent(call.id)}`,
    });
  }
  res.json({ pending });
});

// Bridge worker submits the SDP answer it generated for a call.
app.post('/api/bridge/answer', (req: Request, res: Response) => {
  const { callId, sdpAnswer, workerId } = req.body || {};
  if (!callId || !sdpAnswer) {
    res.status(400).json({ error: 'Missing callId/sdpAnswer' });
    return;
  }
  if (!callSessions.has(callId)) {
    res.status(404).json({ error: 'Call not found (may have ended)' });
    return;
  }
  bridgeAnswers.set(callId, sdpAnswer);
  plog('info', 'bridge', `SDP answer received from worker ${workerId || '?'} (${sdpAnswer.length}B)`, { callId });
  res.json({ ok: true });
});

// 8. End Call
app.post('/api/calls/:id/end', (req: Request, res: Response) => {
  const { id } = req.params;
  const call = callSessions.get(id);
  if (call) {
    endCall(id, 'api_end');
    res.json({ success: true, call });
  } else {
    res.status(404).json({ error: 'Call not found' });
  }
});

// WebSocket Server Configuration
// perMessageDeflate off on media sockets: PCM audio is incompressible, so
// compression only adds 5-15ms of CPU latency per message for ~no size win.
const wssSimulator = new WebSocketServer({ noServer: true });
const wssMediaStream = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssCallMedia = new WebSocketServer({ noServer: true, perMessageDeflate: false });

const activeSimulatorClients = new Set<WebSocket>();

function notifySockets(data: any) {
  const msg = JSON.stringify(data);
  for (const client of activeSimulatorClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// Attach upgrade handler to HTTP server
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : '';

  if (pathname === '/ws/whatsapp-call') {
    wssSimulator.handleUpgrade(request, socket, head, (ws) => {
      wssSimulator.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/media-stream') {
    wssMediaStream.handleUpgrade(request, socket, head, (ws) => {
      wssMediaStream.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('/ws/call-media/')) {
    wssCallMedia.handleUpgrade(request, socket, head, (ws) => {
      wssCallMedia.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handler for Interactive Browser WhatsApp Call Simulator
wssSimulator.on('connection', async (clientWs: WebSocket) => {
  activeSimulatorClients.add(clientWs);
  console.log('[Simulator WS] Client connected. Total clients:', activeSimulatorClients.size);

  let browserGeminiSession: any = null;
  let activeCallId: string | null = null;
  let isConnecting = false;
  let latencyStartTime = 0;

  async function establishGeminiLiveSession(callId: string, customPrompt?: string, customVoice?: string) {
    // If the server already auto-answered with a direct session, the browser
    // is just a monitor — don't open a second session.
    if (geminiSessions.has(callId)) {
      clientWs.send(JSON.stringify({
        type: 'live_status',
        callId,
        status: 'connected',
        message: 'Server-side Gemini Live already answering this call. Browser is monitoring.',
      }));
      return;
    }
    if (browserGeminiSession || isConnecting) return;
    isConnecting = true;

    try {
      console.log(`[Gemini Live] Connecting browser session ${GEMINI_LIVE_MODEL} for call ${callId}...`);
      clientWs.send(
        JSON.stringify({
          type: 'live_status',
          callId,
          status: 'connecting',
          message: `Initializing ${GEMINI_LIVE_MODEL} session...`,
        })
      );

      const voice = customVoice || gatewayConfig.voiceName;
      const prompt = customPrompt || gatewayConfig.systemPrompt;

      browserGeminiSession = await ai.live.connect({
        model: GEMINI_LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
          systemInstruction: prompt,
        },
        callbacks: {
          onopen: () => {
            console.log('[Gemini Live] Browser session connected successfully!');
            clientWs.send(
              JSON.stringify({
                type: 'live_status',
                callId,
                status: 'connected',
                message: `${GEMINI_LIVE_MODEL} connected and listening.`,
                voice,
              })
            );
          },
          onmessage: (message: any) => {
            // Measure model round-trip latency
            if (latencyStartTime > 0) {
              const rtt = Date.now() - latencyStartTime;
              clientWs.send(JSON.stringify({ type: 'telemetry_latency', latencyMs: rtt }));
              latencyStartTime = 0;
            }

            // Audio chunk from Gemini
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts && parts.length > 0) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'audio_chunk',
                      callId,
                      audio: part.inlineData.data,
                      mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                    })
                  );
                }
                if (part.text) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'transcript_chunk',
                      callId,
                      speaker: 'gemini',
                      text: part.text,
                    })
                  );
                }
              }
            }

            // Handle barge-in / interruption
            if (message.serverContent?.interrupted) {
              console.log('[Gemini Live] Interruption detected! User barged in.');
              clientWs.send(
                JSON.stringify({
                  type: 'interrupted',
                  callId,
                  message: 'Gemini output halted by caller speech',
                })
              );
            }

            // Handle function call if triggered by Gemini
            if (message.toolCall) {
              console.log('[Gemini Live] Tool call received:', message.toolCall);
              handleToolCall(message.toolCall);
            }
          },
          onerror: (err: any) => {
            console.error('[Gemini Live Error]:', err);
            clientWs.send(
              JSON.stringify({
                type: 'live_error',
                callId,
                error: err?.message || `${GEMINI_LIVE_MODEL} session encountered an error`,
              })
            );
          },
          onclose: (e: any) => {
            console.log('[Gemini Live] Browser session closed:', e?.reason || 'Normal close');
            browserGeminiSession = null;
            clientWs.send(
              JSON.stringify({
                type: 'live_status',
                callId,
                status: 'disconnected',
                message: `${GEMINI_LIVE_MODEL} session disconnected`,
              })
            );
          },
        },
      });

      console.log('[Gemini Live] Browser session connected successfully.');
    } catch (error: any) {
      console.error('[Gemini Live Connection Failed]:', error);
      clientWs.send(
        JSON.stringify({
          type: 'live_error',
          callId,
          error: error?.message || `Failed to initialize ${GEMINI_LIVE_MODEL} session.`,
        })
      );
    } finally {
      isConnecting = false;
    }
  }

  function handleToolCall(toolCall: any) {
    // Example simulated functions for WhatsApp business
    const calls = toolCall.functionCalls || [];
    const responses = calls.map((call: any) => {
      const result = resolveToolResult(call.name, call.args);

      clientWs.send(
        JSON.stringify({
          type: 'function_executed',
          callId: activeCallId,
          name: call.name,
          args: call.args,
          result,
        })
      );

      return {
        id: call.id,
        name: call.name,
        response: { result },
      };
    });

    if (browserGeminiSession && browserGeminiSession.sendToolResponse) {
      browserGeminiSession.sendToolResponse({ functionResponses: responses });
    }
  }

  clientWs.on('message', async (data: any) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'start_call': {
          const callId = message.callId || `call_${Date.now()}`;
          activeCallId = callId;
          console.log(`[Simulator WS] Call started: ${callId}`);

          let call = callSessions.get(callId);
          if (!call) {
            call = {
              id: callId,
              callerNumber: message.callerNumber || '+1 (555) 382-9428',
              callerName: message.callerName || 'Alex Chen',
              direction: message.direction || 'inbound',
              origin: 'browser',
              status: 'connected',
              startedAt: new Date().toISOString(),
              durationSeconds: 0,
              packetsIn: 0,
              packetsOut: 0,
              avgLatencyMs: 0,
              interruptionsCount: 0,
              turns: [],
            };
            callSessions.set(callId, call);
          } else {
            call.status = 'connected';
          }

          // Server-side session takes precedence; browser only dials if none.
          if (!geminiSessions.has(callId)) {
            await establishGeminiLiveSession(callId, message.systemPrompt, message.voiceName);
          } else {
            clientWs.send(JSON.stringify({
              type: 'live_status',
              callId,
              status: 'connected',
              message: 'Joined live call monitor — server-side Gemini is answering.',
            }));
          }

          // If caller has an initial greeting or prompt
          if (message.initialGreeting) {
            const target = geminiSessions.get(callId) || browserGeminiSession;
            target?.sendClientContent?.({
              turns: [
                {
                  role: 'user',
                  parts: [{ text: `A WhatsApp voice call just connected from ${call.callerName} (${call.callerNumber}). Greet them warmly and offer your assistance.` }],
                },
              ],
              turnComplete: true,
            });
          }
          break;
        }

        case 'audio_input': {
          // Real-time audio from browser mic (PCM 16kHz Base64).
          // Route to whichever session owns this call (server-side first).
          if (message.audio && activeCallId) {
            if (geminiSessions.has(activeCallId)) {
              latencyStartTime = Date.now();
              sendAudioToGemini(activeCallId, message.audio);
            } else if (browserGeminiSession) {
              latencyStartTime = Date.now();
              try {
                browserGeminiSession.sendRealtimeInput({
                  audio: {
                    data: message.audio,
                    mimeType: 'audio/pcm;rate=16000',
                  },
                });
              } catch (err) {
                // Alternative parameter structure in some SDK builds
                browserGeminiSession.sendRealtimeInput({
                  mediaChunks: [
                    {
                      data: message.audio,
                      mimeType: 'audio/pcm;rate=16000',
                    },
                  ],
                });
              }
            }
          }
          break;
        }

        case 'user_text_prompt': {
          // Text simulation turn
          const target = (activeCallId && geminiSessions.get(activeCallId)) || browserGeminiSession;
          if (target && message.text) {
            target.sendClientContent?.({
              turns: [
                {
                  role: 'user',
                  parts: [{ text: message.text }],
                },
              ],
              turnComplete: true,
            });
          }
          break;
        }

        case 'end_call': {
          console.log(`[Simulator WS] Ending call: ${activeCallId}`);
          if (activeCallId) {
            endCall(activeCallId, 'browser_end');
          }
          if (browserGeminiSession) {
            try {
              if (typeof browserGeminiSession.close === 'function') {
                browserGeminiSession.close();
              } else if (browserGeminiSession.conn?.close) {
                browserGeminiSession.conn.close();
              }
            } catch (e) {
              // Ignore close errors
            }
            browserGeminiSession = null;
          }
          activeCallId = null;
          clientWs.send(JSON.stringify({ type: 'call_ended', callId: activeCallId }));
          break;
        }
      }
    } catch (err) {
      console.error('[Simulator WS] Message error:', err);
    }
  });

  clientWs.on('close', () => {
    activeSimulatorClients.delete(clientWs);
    console.log('[Simulator WS] Client disconnected');
    if (browserGeminiSession) {
      try {
        if (typeof browserGeminiSession.close === 'function') browserGeminiSession.close();
        else if (browserGeminiSession.conn?.close) browserGeminiSession.conn.close();
      } catch (e) {}
      browserGeminiSession = null;
    }
  });
});

// Generic bidirectional media bridge: /ws/call-media/<callId>
// Any UDP-capable worker (LiveKit agent, SIP gateway) joins here over TCP/TLS:
//   -> send {"event":"start"} then {"event":"media","media":{"payload":"<pcm16k base64>"}}
//   <- receive {"type":"gemini_audio","audio":"<pcm24k base64>"} + Twilio-style frames
//      if it identifies as {"event":"start","bridge":"twilio"}.
wssCallMedia.on('connection', async (bridgeWs: WebSocket, request: any) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const callId = decodeURIComponent(url.pathname.replace('/ws/call-media/', '').split('/')[0] || '');
  (bridgeWs as any).__bridgeKind = 'raw';

  console.log(`[Call Media] Bridge connected for call ${callId || '(unknown)'}`);
  plog('info', 'media', `bridge connected (kind=${(bridgeWs as any).__bridgeKind})`, { callId: callId || undefined });

  if (callId) {
    const set = callMediaBridges.get(callId) || new Set();
    set.add(bridgeWs);
    callMediaBridges.set(callId, set);
    // Ensure Gemini is live even if webhook accept is still in flight.
    if (callSessions.has(callId) && !geminiSessions.has(callId)) {
      void startGeminiLiveForCall(callId);
    }
    flushGeminiAudioToBridges(callId);
  }

  bridgeWs.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      const cid = msg.callId || callId;
      if (msg.event === 'start') {
        if (msg.bridge === 'twilio') (bridgeWs as any).__bridgeKind = 'twilio';
        (bridgeWs as any).__streamSid = msg.start?.streamSid || msg.streamSid || '';
        console.log(`[Call Media] Stream started for call ${cid}`);
        return;
      }
      if ((msg.event === 'media' || msg.type === 'caller_audio') && cid) {
        const payload = msg.media?.payload || msg.audio;
        if (!payload) return;
        if ((bridgeWs as any).__bridgeKind === 'twilio' || msg.event === 'media') {
          // Twilio μ-law 8k -> PCM 16k -> Gemini (coalesced to ~40ms).
          const pcm16 = resampleMulawToPCM16(Buffer.from(payload, 'base64'));
          queueAudioForGemini(cid, pcm16);
        } else {
          // WhatsApp worker path — already 40ms-batched, flushes immediately.
          queueAudioForGemini(cid, Buffer.from(payload, 'base64'));
        }
        return;
      }
      if (msg.event === 'stop' && cid) {
        console.log(`[Call Media] Stream stopped for call ${cid}`);
        return;
      }
    } catch (e) {
      console.error('[Call Media] Message error:', e);
    }
  });

  bridgeWs.on('close', () => {
    if (callId) {
      const set = callMediaBridges.get(callId);
      if (set) {
        set.delete(bridgeWs);
        if (set.size === 0) callMediaBridges.delete(callId);
      }
    }
    console.log(`[Call Media] Bridge closed for call ${callId}`);
  });
});

// Handler for Telephony / Twilio Media Streams (Twilio <-> Gemini Live).
// Twilio terminates UDP itself and speaks WebSocket (works on Cloud Run),
// so this is the voice path that works TODAY while direct Meta RTP needs
// MEDIA_ANNOUNCE_IP pointing at a UDP-capable host.
wssMediaStream.on('connection', async (telephonyWs: WebSocket) => {
  console.log('[Media Stream WS] Twilio telephony connected');
  (telephonyWs as any).__bridgeKind = 'twilio';
  let streamSid = '';
  let callId = '';

  const ensureSession = async () => {
    if (!callId) {
      callId = `twilio_call_${Date.now()}`;
      callSessions.set(callId, {
        id: callId,
        callerNumber: 'Twilio Caller',
        callerName: 'WhatsApp Caller (Twilio)',
        direction: 'inbound',
        origin: 'telephony',
        status: 'connected',
        startedAt: new Date().toISOString(),
        durationSeconds: 0,
        packetsIn: 0,
        packetsOut: 0,
        avgLatencyMs: 0,
        interruptionsCount: 0,
        turns: [],
      });
      const set = callMediaBridges.get(callId) || new Set();
      set.add(telephonyWs);
      callMediaBridges.set(callId, set);
    }
    if (!geminiSessions.has(callId)) {
      await startGeminiLiveForCall(callId);
    }
  };

  await ensureSession().catch((e) => console.error('[Media Stream WS] session init failed:', e));

  telephonyWs.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'connected') return;
      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid || '';
        (telephonyWs as any).__streamSid = streamSid;
        const custom = msg.start?.customParameters || {};
        if (custom.callId && callSessions.has(custom.callId)) {
          // Rebind this socket to the real WhatsApp call if provided.
          const old = callMediaBridges.get(callId);
          old?.delete(telephonyWs);
          callId = custom.callId;
          const set = callMediaBridges.get(callId) || new Set();
          set.add(telephonyWs);
          callMediaBridges.set(callId, set);
        }
        console.log(`[Media Stream WS] Stream started: ${streamSid} call=${callId}`);
        plog('info', 'media', `twilio stream started: ${streamSid}`, { callId });
      } else if (msg.event === 'media' && msg.media?.payload && callId) {
        // Twilio sends payload as base64 mulaw 8000Hz (coalesced to ~40ms).
        const rawMulaw = Buffer.from(msg.media.payload, 'base64');
        const pcm16Buffer = resampleMulawToPCM16(rawMulaw);
        queueAudioForGemini(callId, pcm16Buffer);
      } else if (msg.event === 'stop') {
        console.log(`[Media Stream WS] Stream stopped: ${streamSid} call=${callId}`);
        const set = callMediaBridges.get(callId);
        set?.delete(telephonyWs);
      }
    } catch (e) {
      console.error('[Media Stream WS] Message error:', e);
    }
  });

  telephonyWs.on('close', () => {
    console.log('[Media Stream WS] Telephony socket closed');
    if (callId) {
      const set = callMediaBridges.get(callId);
      set?.delete(telephonyWs);
    }
  });
});

// Vite Middleware for Development / Static Hosting for Production
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve('dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

setupVite().then(() => {
  server.listen(PORT, () => {
    console.log(`\n=================================================`);
    console.log(` WhatsApp Gemini Live Voice Gateway Running!`);
    console.log(` URL: http://localhost:${PORT}`);
    console.log(` Model: ${GEMINI_LIVE_MODEL} (fallback: ${GEMINI_LIVE_FALLBACK_MODEL})`);
    console.log(` Auto-accept: ${gatewayConfig.autoAcceptCalls ? 'ON (direct Gemini pickup)' : 'OFF (manual)'}`);
    console.log(` LiveKit: ${livekitConfigured ? livekitUrl : 'NOT CONFIGURED'}`);
    console.log(` Media announce IP: ${MEDIA_ANNOUNCE_IP || '(unset — set MEDIA_ANNOUNCE_IP)'}`);
    console.log(` WhatsApp Webhook: /api/whatsapp/webhook`);
    console.log(` Telephony Media Stream: /ws/media-stream`);
    console.log(` Call media bridge: /ws/call-media/:callId`);
    console.log(` Browser Live Call: /ws/whatsapp-call`);
    console.log(`=================================================\n`);
  });
});
