import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import dotenv from 'dotenv';
import { ConnectorClient } from 'livekit-server-sdk';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// LiveKit Cloud Configuration
const livekitUrl = process.env.LIVEKIT_URL || 'wss://agent-negotiation-wt32uzjo.livekit.cloud';
const livekitApiKey = process.env.LIVEKIT_API_KEY || 'API6QmR77yuXpVF';
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || 'MjYVsQxNWPZoK1mLBWtOcVIu22GR3TkuKsFxpcDu41F';

let livekitConnector: ConnectorClient | null = null;
try {
  livekitConnector = new ConnectorClient(livekitUrl, livekitApiKey, livekitApiSecret);
  console.log('[LiveKit Cloud] Connector initialized with endpoint:', livekitUrl);
} catch (e) {
  console.error('[LiveKit Cloud] Failed to initialize ConnectorClient:', e);
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
  metaAccessToken: process.env.META_ACCESS_TOKEN || 'EAAE2FEOgZBCUBO5ZAmWlFybw7gjNDLCQsjdy8DAkUDFa3nzwc6ZBFtBK01tvNzjfYx3t1oMe0PdZAejBo9q4zC4A9KdJgpQzvZBpErOKjGBcKtxK0ju0ZCihMUwYKsn7umrQ4RpiL94tWvySrMvHH8l4BT762yZBrb6HzFK3xYmjEZB087ZC2sDlrZCwABVpSUKpco6iIXps8ZA3ugZCrL2I',
  autoAcceptCalls: true,
  voiceName: 'Zephyr',
  personaName: 'WhatsApp Business AI Assistant',
  systemPrompt: `You are the official voice assistant for WhatsApp Business. You answer voice calls live from customers with exceptional clarity, empathy, and conciseness.
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
  status: 'ringing' | 'connected' | 'speaking' | 'interrupted' | 'ended';
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  packetsIn: number;
  packetsOut: number;
  avgLatencyMs: number;
  interruptionsCount: number;
  turns: Array<{
    speaker: 'caller' | 'gemini';
    text: string;
    timestamp: string;
  }>;
}

// In-memory call log
const callSessions: Map<string, CallSession> = new Map();
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

// REST API Endpoints

// 1. Health & Server Status
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    hasApiKey: Boolean(apiKey),
    model: 'gemini-3.8-live',
    activeCalls: Array.from(callSessions.values()).filter((c) => c.status !== 'ended').length,
  });
});

// 2. Gateway Configuration
app.get('/api/whatsapp/config', (req: Request, res: Response) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

  res.json({
    config: gatewayConfig,
    endpoints: {
      webhookUrl: `${protocol}://${host}/api/whatsapp/webhook`,
      twilioVoiceUrl: `${protocol}://${host}/api/twilio/voice`,
      browserWsUrl: `${wsProtocol}://${host}/ws/whatsapp-call`,
      mediaStreamWsUrl: `${wsProtocol}://${host}/ws/media-stream`,
    },
  });
});

app.post('/api/whatsapp/config', (req: Request, res: Response) => {
  const updates = req.body;
  gatewayConfig = {
    ...gatewayConfig,
    ...updates,
  };
  res.json({ success: true, config: gatewayConfig });
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
app.post('/api/whatsapp/webhook', async (req: Request, res: Response) => {
  const payload = req.body;
  console.log('[WhatsApp Webhook] Received event:', JSON.stringify(payload, null, 2));

  // Check if incoming call event across various payload formats:
  // Format A: Standard Meta WhatsApp Cloud API
  const entry = payload?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  let callId = '';
  let caller = '';
  let callerName = 'WhatsApp Caller';
  let sdpOffer = '';
  let phoneNumberId = value?.metadata?.phone_number_id || gatewayConfig.phoneNumberId;

  // Extract contact name from contacts array if provided by Meta
  const contactName = value?.contacts?.[0]?.profile?.name;

  if (value?.calls && value.calls.length > 0) {
    const callData = value.calls[0];
    callId = callData.id || `wa_call_${Date.now()}`;
    caller = callData.from || callData.caller_id || '+15550000000';
    callerName = contactName || callData.name || callData.display_name || 'WhatsApp Caller';
    if (callData.session?.sdp) {
      sdpOffer = callData.session.sdp;
    }
  } else if (payload.CallSid || payload.CallDuration || payload.From) {
    // Twilio Voice / WhatsApp Voice forwarder
    callId = payload.CallSid || `twilio_call_${Date.now()}`;
    caller = payload.From?.replace('whatsapp:', '') || '+15550000000';
    callerName = payload.CallerName || contactName || 'WhatsApp Caller';
  } else if (payload.event === 'incoming_call' || payload.call_id || payload.caller) {
    // Custom/SIP proxy forwarder
    callId = payload.call_id || `sip_call_${Date.now()}`;
    caller = payload.caller || payload.from || '+15550000000';
    callerName = payload.caller_name || contactName || 'WhatsApp Caller';
  }

  if (callId) {
    console.log(`[WhatsApp Webhook] Incoming call identified: ${callId} from ${caller} (${callerName})`);
    
    // Check if call already registered
    let existingCall = callSessions.get(callId);
    if (!existingCall) {
      existingCall = {
        id: callId,
        callerNumber: caller,
        callerName: callerName,
        direction: 'inbound',
        status: 'ringing',
        startedAt: new Date().toISOString(),
        durationSeconds: 0,
        packetsIn: 0,
        packetsOut: 0,
        avgLatencyMs: 0,
        interruptionsCount: 0,
        turns: [
          {
            speaker: 'gemini',
            text: `Incoming WhatsApp call from ${callerName} (${caller}). Meta SDP Offer received.`,
            timestamp: '00:00',
          },
        ],
      };
      callSessions.set(callId, existingCall);
    }

    // Broadcast to connected UI simulator / dashboard
    notifySockets({
      type: 'incoming_call_event',
      call: existingCall,
      hasSdpOffer: Boolean(sdpOffer),
    });

    // If LiveKit Cloud Connector is available, route WebRTC SDP media directly to LiveKit
    let livekitAccepted = false;
    let acceptStatus = 'waiting_for_agent_or_token';
    const token = gatewayConfig.metaAccessToken || process.env.META_ACCESS_TOKEN;

    if (livekitConnector && sdpOffer && phoneNumberId && token) {
      // LiveKit Cloud WhatsApp Connector supports v23.0, v24.0, v25.0, v26.0 (both with and without 'v' prefix)
      const supportedVersions = ['v23.0', '23.0', 'v24.0', '24.0', 'v25.0', '25.0', 'v22.0', '22.0'];
      for (const ver of supportedVersions) {
        if (livekitAccepted) break;
        try {
          console.log(`[LiveKit Cloud] Calling acceptWhatsAppCall for ${callId} with version ${ver}...`);
          const lkRes = await livekitConnector.acceptWhatsAppCall({
            whatsappPhoneNumberId: phoneNumberId,
            whatsappApiKey: token,
            whatsappCloudApiVersion: ver,
            whatsappCallId: callId,
            sdp: {
              type: 'offer',
              sdp: sdpOffer,
            } as any,
            roomName: `wa_${callId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            participantIdentity: caller,
            participantName: callerName,
          });

          console.log('[LiveKit Cloud] WhatsApp call accepted successfully with version:', ver, lkRes);
          existingCall.status = 'connected';
          livekitAccepted = true;
          acceptStatus = `accepted_via_livekit_cloud_v${ver}`;

          notifySockets({
            type: 'call_connected_meta',
            callId,
            roomName: lkRes.roomName || `wa_${callId}`,
            livekitResponse: lkRes,
          });
          break;
        } catch (lkErr: any) {
          console.warn(`[LiveKit Cloud] Version ${ver} rejected:`, lkErr?.message || lkErr);
        }
      }
    }

    // Fallback: If LiveKit did not accept, attempt direct Meta Graph API accept
    if (!livekitAccepted && token && sdpOffer && phoneNumberId) {
      try {
        console.log(`[Meta Cloud API] Attempting direct accept for WhatsApp Call ${callId}...`);
        const sdpAnswer = generateSdpAnswer(sdpOffer);
        const metaRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/calls`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            call_id: callId,
            action: 'accept',
            session: {
              sdp_type: 'answer',
              sdp: sdpAnswer,
            },
          }),
        });

        const metaData = await metaRes.json();
        console.log('[Meta Cloud API] Accept response:', metaData);
        if (metaRes.ok && metaData.success !== false) {
          existingCall.status = 'connected';
          acceptStatus = 'accepted_via_graph_api';
          notifySockets({
            type: 'call_connected_meta',
            callId,
            metaResponse: metaData,
          });
        } else {
          acceptStatus = `meta_error: ${metaData.error?.message || JSON.stringify(metaData)}`;
        }
      } catch (err: any) {
        console.error('[Meta Cloud API] Error accepting call:', err);
        acceptStatus = `exception: ${err.message}`;
      }
    }

    return res.status(200).json({
      status: 'call_received',
      callId,
      caller,
      callerName,
      acceptStatus,
      instructions: token
        ? 'Meta Graph API answer dispatched or media stream connecting'
        : 'To have the server pick up calls without human click, provide META_ACCESS_TOKEN in Persona Settings or connect audio via /ws/media-stream',
      mediaStreamWsUrl: `/ws/media-stream`,
    });
  }

  res.status(200).json({ status: 'received', message: 'Webhook acknowledged' });
});

// Helper: Generate WebRTC SDP Answer matching WhatsApp Offer
function generateSdpAnswer(offerSdp: string): string {
  // Extract ice-ufrag, ice-pwd, and ssrc from offer if present
  const ufragMatch = offerSdp.match(/a=ice-ufrag:([^\r\n]+)/);
  const pwdMatch = offerSdp.match(/a=ice-pwd:([^\r\n]+)/);
  const midMatch = offerSdp.match(/a=mid:([^\r\n]+)/);

  const ufrag = ufragMatch ? ufragMatch[1] : 'geminiliveufrag';
  const pwd = pwdMatch ? pwdMatch[1] : 'geminilivepwd1234567890';
  const mid = midMatch ? midMatch[1] : 'audio';

  return [
    'v=0',
    'o=- 1790423974000 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=msid-semantic: WMS WhatsAppGeminiLive',
    'm=audio 3480 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 127.0.0.1',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=fingerprint:sha-256 73:F2:08:6C:27:99:83:66:45:35:F9:06:C9:AC:47:6D:31:83:41:85:A4:FC:72:06:E4:CC:44:8D:52:CB:35:DA',
    'a=setup:active',
    `a=mid:${mid}`,
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1',
    'a=ptime:20',
    '',
  ].join('\r\n');
}

// 5. Twilio Voice / WhatsApp Voice TwiML Webhook
app.post('/api/twilio/voice', (req: Request, res: Response) => {
  const host = req.get('host') || 'localhost:3000';
  const wsProtocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
  const streamUrl = `${wsProtocol}://${host}/ws/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting your WhatsApp call directly to Gemini 3.8 Live Voice.</Say>
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

// 7. Simulate incoming call trigger
app.post('/api/whatsapp/simulate-call', (req: Request, res: Response) => {
  const { callerNumber, callerName } = req.body;
  const callId = `sim_call_${Date.now()}`;

  const call: CallSession = {
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
  };

  callSessions.set(callId, call);
  notifySockets({
    type: 'incoming_call_event',
    call,
  });

  res.json({ success: true, call });
});

// 8. End Call
app.post('/api/calls/:id/end', (req: Request, res: Response) => {
  const { id } = req.params;
  const call = callSessions.get(id);
  if (call) {
    call.status = 'ended';
    call.endedAt = new Date().toISOString();
    recentCalls.unshift({ ...call });
    callSessions.delete(id);
    notifySockets({
      type: 'call_ended',
      callId: id,
    });
    res.json({ success: true, call });
  } else {
    res.status(404).json({ error: 'Call not found' });
  }
});

// WebSocket Server Configuration
const wssSimulator = new WebSocketServer({ noServer: true });
const wssMediaStream = new WebSocketServer({ noServer: true });

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
  } else {
    socket.destroy();
  }
});

// Handler for Interactive Browser WhatsApp Call Simulator
wssSimulator.on('connection', async (clientWs: WebSocket) => {
  activeSimulatorClients.add(clientWs);
  console.log('[Simulator WS] Client connected. Total clients:', activeSimulatorClients.size);

  let geminiSession: any = null;
  let activeCallId: string | null = null;
  let isConnecting = false;
  let latencyStartTime = 0;

  async function establishGeminiLiveSession(callId: string, customPrompt?: string, customVoice?: string) {
    if (geminiSession || isConnecting) return;
    isConnecting = true;

    try {
      console.log(`[Gemini Live] Connecting to model gemini-3.8-live for call ${callId}...`);
      clientWs.send(
        JSON.stringify({
          type: 'live_status',
          status: 'connecting',
          message: 'Initializing Gemini 3.8 Live session...',
        })
      );

      const voice = customVoice || gatewayConfig.voiceName;
      const prompt = customPrompt || gatewayConfig.systemPrompt;

      geminiSession = await ai.live.connect({
        model: 'gemini-3.8-live',
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
            console.log('[Gemini Live] Session WebSocket connected successfully!');
            clientWs.send(
              JSON.stringify({
                type: 'live_status',
                status: 'connected',
                message: 'Gemini 3.8 Live connected and listening.',
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
                      audio: part.inlineData.data,
                      mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                    })
                  );
                }
                if (part.text) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'transcript_chunk',
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
                error: err?.message || 'Gemini 3.8 Live session encountered an error',
              })
            );
          },
          onclose: (e: any) => {
            console.log('[Gemini Live] Session closed:', e?.reason || 'Normal close');
            geminiSession = null;
            clientWs.send(
              JSON.stringify({
                type: 'live_status',
                status: 'disconnected',
                message: 'Gemini 3.8 Live session disconnected',
              })
            );
          },
        },
      });

      console.log('[Gemini Live] Session connected successfully.');
    } catch (error: any) {
      console.error('[Gemini Live Connection Failed]:', error);
      clientWs.send(
        JSON.stringify({
          type: 'live_error',
          error: error?.message || 'Failed to initialize Gemini 3.8 Live session.',
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
      let result: any = { status: 'success' };
      if (call.name === 'check_order_status') {
        result = {
          orderId: call.args?.orderId || 'WA-8921',
          status: 'Shipped',
          carrier: 'FedEx Priority',
          estimatedDelivery: 'Tomorrow, 2:30 PM',
          items: ['Wireless Noise Cancelling Earbuds Pro', 'USB-C Braided Cable 2m'],
        };
      } else if (call.name === 'book_appointment') {
        result = {
          appointmentId: `APT-${Math.floor(1000 + Math.random() * 9000)}`,
          date: call.args?.date || 'Tomorrow',
          time: call.args?.time || '11:00 AM',
          confirmed: true,
          confirmationSentViaWhatsApp: true,
        };
      } else if (call.name === 'get_business_hours') {
        result = {
          mondayToFriday: '8:00 AM - 8:00 PM EST',
          saturday: '9:00 AM - 5:00 PM EST',
          sunday: 'Closed',
        };
      } else if (call.name === 'escalate_to_human') {
        result = {
          ticketCreated: true,
          queuePosition: 2,
          estimatedWaitMinutes: 3,
        };
      }

      clientWs.send(
        JSON.stringify({
          type: 'function_executed',
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

    if (geminiSession && geminiSession.sendToolResponse) {
      geminiSession.sendToolResponse({ functionResponses: responses });
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

          await establishGeminiLiveSession(callId, message.systemPrompt, message.voiceName);

          // If caller has an initial greeting or prompt
          if (message.initialGreeting && call) {
            geminiSession?.sendClientContent?.({
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
          // Real-time audio from browser mic (PCM 16kHz Base64)
          if (geminiSession && message.audio) {
            latencyStartTime = Date.now();
            try {
              geminiSession.sendRealtimeInput({
                audio: {
                  data: message.audio,
                  mimeType: 'audio/pcm;rate=16000',
                },
              });
            } catch (err) {
              // Alternative parameter structure in some SDK builds
              geminiSession.sendRealtimeInput({
                mediaChunks: [
                  {
                    data: message.audio,
                    mimeType: 'audio/pcm;rate=16000',
                  },
                ],
              });
            }
          }
          break;
        }

        case 'user_text_prompt': {
          // Text simulation turn
          if (geminiSession && message.text) {
            geminiSession.sendClientContent?.({
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
            const call = callSessions.get(activeCallId);
            if (call) {
              call.status = 'ended';
              call.endedAt = new Date().toISOString();
              if (message.durationSeconds) {
                call.durationSeconds = message.durationSeconds;
              }
              recentCalls.unshift({ ...call });
              callSessions.delete(activeCallId);
            }
          }
          if (geminiSession) {
            try {
              if (typeof geminiSession.close === 'function') {
                geminiSession.close();
              } else if (geminiSession.conn?.close) {
                geminiSession.conn.close();
              }
            } catch (e) {
              // Ignore close errors
            }
            geminiSession = null;
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
    if (geminiSession) {
      try {
        if (typeof geminiSession.close === 'function') geminiSession.close();
        else if (geminiSession.conn?.close) geminiSession.conn.close();
      } catch (e) {}
      geminiSession = null;
    }
  });
});

// Handler for Telephony / Twilio / Meta Media Stream WebSocket
wssMediaStream.on('connection', async (telephonyWs: WebSocket) => {
  console.log('[Media Stream WS] Telephony connected');
  let geminiSession: any = null;
  let streamSid: string = '';

  try {
    geminiSession = await ai.live.connect({
      model: 'gemini-3.8-live',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: gatewayConfig.voiceName },
          },
        },
        systemInstruction: gatewayConfig.systemPrompt,
      },
      callbacks: {
        onmessage: (msg: any) => {
          const parts = msg.serverContent?.modelTurn?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.inlineData?.data && streamSid) {
                // Send back audio in Twilio Media format
                // In full telephony production, convert 24kHz PCM to 8kHz mulaw
                telephonyWs.send(
                  JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: {
                      payload: part.inlineData.data,
                    },
                  })
                );
              }
            }
          }
          if (msg.serverContent?.interrupted && streamSid) {
            telephonyWs.send(
              JSON.stringify({
                event: 'clear',
                streamSid,
              })
            );
          }
        },
      },
    });
  } catch (err) {
    console.error('[Media Stream WS] Failed to connect Gemini Live:', err);
  }

  telephonyWs.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid || '';
        console.log(`[Media Stream WS] Stream started: ${streamSid}`);
      } else if (msg.event === 'media' && geminiSession) {
        // Twilio sends payload as base64 mulaw 8000Hz
        const rawMulaw = Buffer.from(msg.media.payload, 'base64');
        const pcm16Buffer = resampleMulawToPCM16(rawMulaw);
        geminiSession.sendRealtimeInput({
          audio: {
            data: pcm16Buffer.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } else if (msg.event === 'stop') {
        console.log(`[Media Stream WS] Stream stopped: ${streamSid}`);
        if (geminiSession) {
          try {
            if (typeof geminiSession.close === 'function') geminiSession.close();
            else if (geminiSession.conn?.close) geminiSession.conn.close();
          } catch (e) {}
        }
      }
    } catch (e) {
      console.error('[Media Stream WS] Message error:', e);
    }
  });

  telephonyWs.on('close', () => {
    console.log('[Media Stream WS] Telephony socket closed');
    if (geminiSession) {
      try {
        if (typeof geminiSession.close === 'function') geminiSession.close();
        else if (geminiSession.conn?.close) geminiSession.conn.close();
      } catch (e) {}
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
    console.log(` WhatsApp Gemini 3.8 Live Voice Gateway Running!`);
    console.log(` URL: http://localhost:${PORT}`);
    console.log(` Model: gemini-3.8-live (Low-latency Audio PCM)`);
    console.log(` WhatsApp Webhook: /api/whatsapp/webhook`);
    console.log(` Telephony Media Stream: /ws/media-stream`);
    console.log(` Browser Live Call: /ws/whatsapp-call`);
    console.log(`=================================================\n`);
  });
});
