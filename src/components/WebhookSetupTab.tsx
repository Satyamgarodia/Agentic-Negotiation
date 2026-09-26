import React, { useState } from 'react';
import {
  Copy,
  Check,
  Globe,
  Radio,
  Server,
  Terminal,
  Send,
  ShieldCheck,
  ExternalLink,
  PhoneCall,
  Sparkles,
} from 'lucide-react';
import { EndpointsInfo, GatewayConfig } from '../types';

interface WebhookSetupTabProps {
  endpoints: EndpointsInfo;
  config: GatewayConfig;
  onSimulateIncomingCall: () => void;
}

export const WebhookSetupTab: React.FC<WebhookSetupTabProps> = ({
  endpoints,
  config,
  onSimulateIncomingCall,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [testPayload, setTestPayload] = useState(
    JSON.stringify(
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '239559819251204',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '918287726383',
                    phone_number_id: '306232809234143',
                  },
                  contacts: [
                    {
                      profile: {
                        name: 'Satyam Garodia',
                      },
                      wa_id: '918340370685',
                      user_id: 'IN.966375249447956',
                    },
                  ],
                  calls: [
                    {
                      id: `wacid_${Date.now()}`,
                      from: '918340370685',
                      from_user_id: 'IN.966375249447956',
                      to: '918287726383',
                      event: 'connect',
                      direction: 'USER_INITIATED',
                      session: {
                        sdp_type: 'offer',
                        sdp: 'v=0\r\nm=audio 3480 UDP/TLS/RTP/SAVPF 111 126\r\nc=IN IP4 163.70.146.130\r\na=ice-ufrag:oG/ZV/IoluTOlXYM\r\na=ice-pwd:j67L6jGRjnPA4ykpOQawoQ==\r\na=mid:audio\r\na=sendrecv\r\na=rtpmap:111 opus/48000/2\r\n',
                      },
                    },
                  ],
                },
                field: 'calls',
              },
            ],
          },
        ],
      },
      null,
      2
    )
  );

  const [testResponse, setTestResponse] = useState<any>(null);
  const [isSending, setIsSending] = useState(false);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleSendTestWebhook = async () => {
    setIsSending(true);
    setTestResponse(null);
    try {
      const parsed = JSON.parse(testPayload);
      const res = await fetch('/api/whatsapp/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      setTestResponse({
        status: res.status,
        statusText: res.statusText,
        data,
        timestamp: new Date().toLocaleTimeString(),
      });
    } catch (err: any) {
      setTestResponse({
        error: err.message || 'Failed to dispatch test webhook',
        timestamp: new Date().toLocaleTimeString(),
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Overview Banner */}
      <div className="p-6 rounded-2xl bg-gradient-to-r from-emerald-950/40 via-slate-900 to-cyan-950/40 border border-emerald-500/20 shadow-xl">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold mb-2">
              <ShieldCheck className="w-3.5 h-3.5" />
              Production WhatsApp Calling Integration
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Connect WhatsApp Calls Directly with Gemini 3.8 Live
            </h2>
            <p className="text-sm text-slate-300 mt-1 max-w-2xl leading-relaxed">
              Meta WhatsApp Business Cloud API provides native VoIP WhatsApp Calling. This gateway
              receives incoming call webhooks, negotiates real-time audio streams, and bridges callers
              directly into a low-latency bidirectional Gemini 3.8 Live session.
            </p>
          </div>
          <button
            onClick={onSimulateIncomingCall}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg shadow-emerald-950/50 transition-all cursor-pointer shrink-0"
          >
            <PhoneCall className="w-4 h-4" />
            Trigger Test Call
          </button>
        </div>
      </div>

      {/* Copyable Webhook & Media Stream Endpoints */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Webhook Callback URL */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-lg flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                <Globe className="w-4 h-4" />
                WhatsApp Webhook Callback URL
              </span>
              <span className="text-[10px] font-mono bg-emerald-950/60 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-800/50">
                HTTPS POST & GET
              </span>
            </div>
            <p className="text-xs text-slate-400 mb-3">
              Configure this in your Meta App Dashboard under{' '}
              <strong className="text-slate-200">WhatsApp &gt; Configuration &gt; Callback URL</strong>.
            </p>
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl p-2.5">
              <code className="text-xs text-slate-200 font-mono flex-1 truncate">
                {endpoints.webhookUrl}
              </code>
              <button
                onClick={() => copyToClipboard(endpoints.webhookUrl, 'webhook')}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all cursor-pointer"
                title="Copy URL"
              >
                {copiedKey === 'webhook' ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs">
            <span className="text-slate-400">Verify Token:</span>
            <div className="flex items-center gap-2">
              <code className="font-mono text-cyan-300 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                {config.verifyToken}
              </code>
              <button
                onClick={() => copyToClipboard(config.verifyToken, 'token')}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                {copiedKey === 'token' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Media Stream WebSocket URL */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-lg flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1.5">
                <Radio className="w-4 h-4" />
                Telephony Media Stream URL
              </span>
              <span className="text-[10px] font-mono bg-cyan-950/60 text-cyan-300 px-2 py-0.5 rounded-full border border-cyan-800/50">
                WSS Bidirectional
              </span>
            </div>
            <p className="text-xs text-slate-400 mb-3">
              Real-time RTP/WebSocket stream endpoint for Twilio Voice, Vonage, or SIP Gateways
              bridging WhatsApp audio.
            </p>
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl p-2.5">
              <code className="text-xs text-slate-200 font-mono flex-1 truncate">
                {endpoints.mediaStreamWsUrl}
              </code>
              <button
                onClick={() => copyToClipboard(endpoints.mediaStreamWsUrl, 'stream')}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all cursor-pointer"
                title="Copy Stream URL"
              >
                {copiedKey === 'stream' ? (
                  <Check className="w-4 h-4 text-cyan-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs">
            <span className="text-slate-400">Audio Format:</span>
            <span className="text-slate-200 font-mono text-[11px]">
              G.711 μ-law / PCM 16kHz &rarr; 24kHz
            </span>
          </div>
        </div>
      </div>

      {/* 3-Step Setup Instructions */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl space-y-4">
        <h3 className="text-base font-bold text-white flex items-center gap-2">
          <Server className="w-4 h-4 text-emerald-400" />
          How WhatsApp Voice Calls Reach Gemini 3.8 Live
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold flex items-center justify-center mb-2">
                1
              </div>
              <h4 className="text-xs font-semibold text-slate-200">Register Webhook on Meta</h4>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                In Meta Developers &gt; WhatsApp &gt; Configuration, paste the Webhook URL and Verify Token. Subscribe to the <code className="text-emerald-300">calls</code> and <code className="text-emerald-300">messages</code> webhook fields.
              </p>
            </div>
            <div className="mt-3 text-[10px] font-mono text-slate-500">
              Auto-negotiates GET challenge verification
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-400 text-xs font-bold flex items-center justify-center mb-2">
                2
              </div>
              <h4 className="text-xs font-semibold text-slate-200">Inbound Call Routing</h4>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                When a customer calls your WhatsApp Business Number, Meta sends an incoming call webhook payload. The gateway acknowledges the call and connects the media stream.
              </p>
            </div>
            <div className="mt-3 text-[10px] font-mono text-slate-500">
              Low-latency VoIP SDP negotiation
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-col justify-between">
            <div>
              <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 text-xs font-bold flex items-center justify-center mb-2">
                3
              </div>
              <h4 className="text-xs font-semibold text-slate-200">Bidirectional Gemini 3.8 Live</h4>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                Caller audio frames are resampled to 16kHz PCM and fed into <code className="text-purple-300">ai.live.connect</code>. Gemini's synthesized speech streams back in 24kHz with instant barge-in support.
              </p>
            </div>
            <div className="mt-3 text-[10px] font-mono text-slate-500">
              Round-trip voice latency &lt; 280ms
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Webhook Simulator & Payload Tester */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-400" />
            <div>
              <h3 className="text-sm font-bold text-white">Live Webhook Payload Tester</h3>
              <p className="text-xs text-slate-400">
                Simulate an actual Meta WhatsApp Cloud API incoming call webhook to verify server ingestion
              </p>
            </div>
          </div>
          <button
            onClick={handleSendTestWebhook}
            disabled={isSending}
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            {isSending ? 'Sending Webhook...' : 'Send Test Webhook'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] font-mono text-slate-400 mb-1 flex items-center justify-between">
              <span>POST /api/whatsapp/webhook JSON Payload</span>
              <button
                onClick={() =>
                  setTestPayload(
                    JSON.stringify(
                      {
                        object: 'whatsapp_business_account',
                        entry: [
                          {
                            id: config.wabaId,
                            changes: [
                              {
                                value: {
                                  messaging_product: 'whatsapp',
                                  calls: [
                                    {
                                      id: `wacall_${Date.now()}`,
                                      from: '+1 (555) 789-2041',
                                      name: 'Marcus Vance',
                                      status: 'ringing',
                                    },
                                  ],
                                },
                                field: 'calls',
                              },
                            ],
                          },
                        ],
                      },
                      null,
                      2
                    )
                  )
                }
                className="text-emerald-400 hover:underline cursor-pointer"
              >
                Reset Payload
              </button>
            </div>
            <textarea
              value={testPayload}
              onChange={(e) => setTestPayload(e.target.value)}
              rows={12}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-emerald-300 focus:outline-none focus:border-emerald-500 scrollbar-thin"
            />
          </div>

          <div>
            <div className="text-[11px] font-mono text-slate-400 mb-1">Server Response Log</div>
            <div className="h-[250px] bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs overflow-y-auto text-slate-300">
              {testResponse ? (
                <div>
                  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-slate-800">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        testResponse.status === 200
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : 'bg-rose-950 text-rose-400 border border-rose-800'
                      }`}
                    >
                      HTTP {testResponse.status} {testResponse.statusText}
                    </span>
                    <span className="text-[10px] text-slate-500">{testResponse.timestamp}</span>
                  </div>
                  <pre className="text-emerald-400 text-[11px]">
                    {JSON.stringify(testResponse.data, null, 2)}
                  </pre>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center">
                  <Terminal className="w-6 h-6 mb-2 opacity-50" />
                  <span>Click "Send Test Webhook" above to trigger a test call event to the server.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
