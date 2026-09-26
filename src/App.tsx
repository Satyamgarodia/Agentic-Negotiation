import React, { useState, useEffect, useRef } from 'react';
import { Header, ActiveTab } from './components/Header';
import { WhatsAppPhoneMockup } from './components/WhatsAppPhoneMockup';
import { WebhookSetupTab } from './components/WebhookSetupTab';
import { ArchitectureTab } from './components/ArchitectureTab';
import { PersonaSettingsTab } from './components/PersonaSettingsTab';
import { CallHistoryTab } from './components/CallHistoryTab';
import {
  CallStatus,
  Turn,
  CallSession,
  GatewayConfig,
  EndpointsInfo,
} from './types';
import { WhatsAppRingtone, MicRecorder, PCMPlayer } from './utils/audio';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('call-simulator');
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [callerName, setCallerName] = useState<string>('Alex Chen');
  const [callerNumber, setCallerNumber] = useState<string>('+1 (555) 382-9428');
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number>(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [userVolume, setUserVolume] = useState<number>(0);
  const [geminiVolume, setGeminiVolume] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState<boolean>(true);
  const [latencyMs, setLatencyMs] = useState<number>(0);
  const [hasApiKey, setHasApiKey] = useState<boolean>(true);

  const [config, setConfig] = useState<GatewayConfig>({
    phoneNumberId: '109283746501928',
    wabaId: 'waba_991827364510',
    businessPhoneNumber: '+1 (555) 942-8327',
    verifyToken: 'whatsapp_gemini_verify_token_live',
    voiceName: 'Zephyr',
    personaName: 'WhatsApp Business AI Assistant',
    systemPrompt: `You are the official voice assistant for WhatsApp Business. You answer voice calls live from customers with exceptional clarity, empathy, and conciseness.
Keep your spoken responses natural, conversational, and direct (1-3 sentences per turn). Do not use markdown, emojis, or bullet points in voice responses.
You have access to tools for checking orders, scheduling appointments, and transferring to human agents if needed.`,
    enabledTools: ['check_order_status', 'book_appointment', 'get_business_hours', 'escalate_to_human'],
  });

  const [endpoints, setEndpoints] = useState<EndpointsInfo>({
    webhookUrl: `${window.location.origin}/api/whatsapp/webhook`,
    twilioVoiceUrl: `${window.location.origin}/api/twilio/voice`,
    browserWsUrl: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/whatsapp-call`,
    mediaStreamWsUrl: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/media-stream`,
  });

  const [recentCalls, setRecentCalls] = useState<CallSession[]>([]);

  // Audio subsystem references
  const ringtoneRef = useRef<WhatsAppRingtone | null>(null);
  const micRecorderRef = useRef<MicRecorder | null>(null);
  const pcmPlayerRef = useRef<PCMPlayer | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<any>(null);

  // Initialize Audio & fetch initial config and call logs
  useEffect(() => {
    ringtoneRef.current = new WhatsAppRingtone();
    pcmPlayerRef.current = new PCMPlayer();

    // Fetch config & endpoints
    fetch('/api/whatsapp/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.config) setConfig(data.config);
        if (data.endpoints) setEndpoints(data.endpoints);
      })
      .catch((err) => console.warn('Config fetch warning:', err));

    // Fetch call history
    fetch('/api/calls')
      .then((res) => res.json())
      .then((data) => {
        if (data.recent) setRecentCalls(data.recent);
      })
      .catch((err) => console.warn('Calls fetch warning:', err));

    // Check health
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        setHasApiKey(data.hasApiKey);
      })
      .catch(() => {});

    // Setup WebSocket connection to server
    setupWebSocket();

    return () => {
      ringtoneRef.current?.stop();
      micRecorderRef.current?.stop();
      pcmPlayerRef.current?.destroy();
      if (wsRef.current) wsRef.current.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const setupWebSocket = () => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/whatsapp-call`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[App] WebSocket connected to /ws/whatsapp-call');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'incoming_call_event': {
            // An incoming WhatsApp call event arrived (via Webhook or trigger)
            const incoming = data.call;
            setActiveCallId(incoming.id);
            setCallerName(incoming.callerName);
            setCallerNumber(incoming.callerNumber);
            setCallStatus('ringing');
            setDurationSeconds(0);
            setTurns(incoming.turns || []);
            ringtoneRef.current?.start();
            setActiveTab('call-simulator');
            break;
          }

          case 'call_connected_meta': {
            // Meta Cloud API Call was accepted
            console.log('[App] Meta Cloud API call auto-accepted:', data);
            ringtoneRef.current?.stop();
            setCallStatus('connected');
            break;
          }

          case 'audio_chunk': {
            // Audio output from Gemini 3.8 Live
            if (isSpeakerOn && pcmPlayerRef.current) {
              setCallStatus('speaking');
              pcmPlayerRef.current.playChunk(data.audio, (level) => {
                setGeminiVolume(level);
              });
            }
            break;
          }

          case 'transcript_chunk': {
            // Text caption or transcript turn from Gemini
            setTurns((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.speaker === 'gemini') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, text: last.text + data.text },
                ];
              }
              const time = new Date().toLocaleTimeString([], {
                minute: '2-digit',
                second: '2-digit',
              });
              return [
                ...prev,
                { speaker: 'gemini', text: data.text, timestamp: time },
              ];
            });
            break;
          }

          case 'interrupted': {
            // User interrupted Gemini (Barge-in)! Flush audio output immediately
            console.log('[App] Interrupted - clearing speaker buffer');
            pcmPlayerRef.current?.stopAndClear();
            setGeminiVolume(0);
            setCallStatus('interrupted');
            setTimeout(() => {
              setCallStatus((curr) => (curr === 'interrupted' ? 'connected' : curr));
            }, 1000);
            break;
          }

          case 'telemetry_latency': {
            if (data.latencyMs) {
              setLatencyMs(data.latencyMs);
            }
            break;
          }

          case 'function_executed': {
            const time = new Date().toLocaleTimeString([], {
              minute: '2-digit',
              second: '2-digit',
            });
            setTurns((prev) => [
              ...prev,
              {
                speaker: 'gemini',
                text: `[Action: ${data.name}] -> ${JSON.stringify(data.result)}`,
                timestamp: time,
              },
            ]);
            break;
          }

          case 'call_ended': {
            handleCallEndedLocally();
            break;
          }
        }
      } catch (err) {
        console.error('[App] WebSocket parse error:', err);
      }
    };

    ws.onclose = () => {
      console.log('[App] WebSocket closed, retrying in 3s...');
      setTimeout(setupWebSocket, 3000);
    };
  };

  // Timer for call duration
  useEffect(() => {
    if (callStatus === 'connected' || callStatus === 'speaking' || callStatus === 'interrupted') {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          setDurationSeconds((prev) => prev + 1);
        }, 1000);
      }
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [callStatus]);

  // Accept incoming call or start new call
  const handleAcceptCall = async () => {
    ringtoneRef.current?.stop();
    setCallStatus('connected');

    const callId = activeCallId || `call_${Date.now()}`;
    setActiveCallId(callId);

    // Notify server to start Gemini 3.8 Live session
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'start_call',
          callId,
          callerName,
          callerNumber,
          voiceName: config.voiceName,
          systemPrompt: config.systemPrompt,
          initialGreeting: turns.length === 0,
        })
      );
    }

    // Start mic recording at 16kHz PCM
    startMicrophone();
  };

  const startMicrophone = async () => {
    if (micRecorderRef.current) {
      micRecorderRef.current.stop();
    }

    const recorder = new MicRecorder(
      (base64Pcm, volume) => {
        setUserVolume(volume);
        if (!isMuted && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'audio_input',
              audio: base64Pcm,
            })
          );
        }
      },
      (err) => {
        console.warn('Microphone access issue:', err);
      }
    );

    micRecorderRef.current = recorder;
    await recorder.start();
  };

  const handleDeclineCall = () => {
    ringtoneRef.current?.stop();
    setCallStatus('ended');
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'end_call',
          callId: activeCallId,
          durationSeconds,
        })
      );
    }
    setTimeout(() => setCallStatus('idle'), 2000);
  };

  const handleEndCall = () => {
    ringtoneRef.current?.stop();
    micRecorderRef.current?.stop();
    pcmPlayerRef.current?.stopAndClear();
    setUserVolume(0);
    setGeminiVolume(0);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'end_call',
          callId: activeCallId,
          durationSeconds,
        })
      );
    }

    handleCallEndedLocally();
  };

  const handleCallEndedLocally = () => {
    setCallStatus('ended');
    if (activeCallId && turns.length > 0) {
      const finishedCall: CallSession = {
        id: activeCallId,
        callerName,
        callerNumber,
        direction: 'inbound',
        status: 'ended',
        startedAt: new Date(Date.now() - durationSeconds * 1000).toISOString(),
        endedAt: new Date().toISOString(),
        durationSeconds,
        packetsIn: Math.round(durationSeconds * 10),
        packetsOut: Math.round(durationSeconds * 9),
        avgLatencyMs: latencyMs || 235,
        interruptionsCount: 1,
        turns: [...turns],
      };
      setRecentCalls((prev) => [finishedCall, ...prev]);
    }
    setTimeout(() => {
      setCallStatus('idle');
      setDurationSeconds(0);
    }, 2500);
  };

  const handleToggleMute = () => {
    setIsMuted(!isMuted);
    if (!isMuted) {
      setUserVolume(0);
    }
  };

  const handleToggleSpeaker = () => {
    setIsSpeakerOn(!isSpeakerOn);
    if (isSpeakerOn) {
      pcmPlayerRef.current?.stopAndClear();
      setGeminiVolume(0);
    }
  };

  const handleSendTextPrompt = (text: string) => {
    const time = new Date().toLocaleTimeString([], {
      minute: '2-digit',
      second: '2-digit',
    });

    setTurns((prev) => [...prev, { speaker: 'caller', text, timestamp: time }]);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'user_text_prompt',
          text,
        })
      );
    }
  };

  const handleTriggerSimulatedIncoming = async () => {
    ringtoneRef.current?.stop();
    try {
      const res = await fetch('/api/whatsapp/simulate-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callerNumber: '+1 (555) 789-2041',
          callerName: 'Marcus Vance',
        }),
      });
      const data = await res.json();
      if (data.call) {
        setActiveCallId(data.call.id);
        setCallerName(data.call.callerName);
        setCallerNumber(data.call.callerNumber);
        setCallStatus('ringing');
        setDurationSeconds(0);
        setTurns([]);
        ringtoneRef.current?.start();
        setActiveTab('call-simulator');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveConfig = async (newConfig: GatewayConfig) => {
    const res = await fetch('/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig),
    });
    const data = await res.json();
    if (data.config) {
      setConfig(data.config);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header with Navigation */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        callStatus={callStatus}
        businessPhoneNumber={config.businessPhoneNumber}
        hasApiKey={hasApiKey}
      />

      {/* Main Tab View */}
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-7xl mx-auto w-full">
        {activeTab === 'call-simulator' && (
          <WhatsAppPhoneMockup
            status={callStatus}
            callerName={callerName}
            callerNumber={callerNumber}
            durationSeconds={durationSeconds}
            turns={turns}
            userVolume={userVolume}
            geminiVolume={geminiVolume}
            isMuted={isMuted}
            isSpeakerOn={isSpeakerOn}
            latencyMs={latencyMs}
            activeVoice={config.voiceName}
            onAcceptCall={handleAcceptCall}
            onDeclineCall={handleDeclineCall}
            onEndCall={handleEndCall}
            onToggleMute={handleToggleMute}
            onToggleSpeaker={handleToggleSpeaker}
            onSendTextPrompt={handleSendTextPrompt}
            onTriggerSimulatedIncoming={handleTriggerSimulatedIncoming}
          />
        )}

        {activeTab === 'webhook-setup' && (
          <WebhookSetupTab
            endpoints={endpoints}
            config={config}
            onSimulateIncomingCall={handleTriggerSimulatedIncoming}
          />
        )}

        {activeTab === 'architecture' && <ArchitectureTab />}

        {activeTab === 'persona-tools' && (
          <PersonaSettingsTab
            config={config}
            onSaveConfig={handleSaveConfig}
          />
        )}

        {activeTab === 'call-history' && (
          <CallHistoryTab calls={recentCalls} />
        )}
      </main>

      {/* Bottom Footer with Status */}
      <footer className="border-t border-slate-800/80 bg-slate-950/90 py-3 px-4 text-xs text-slate-500 font-mono">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-center sm:text-left">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>WhatsApp Calling Gateway v2.4</span>
            <span>•</span>
            <span className="text-cyan-400">Gemini 3.8 Live Native PCM</span>
          </div>
          <div>
            Meta Cloud API Webhook: <code className="text-emerald-400">/api/whatsapp/webhook</code>
          </div>
        </div>
      </footer>
    </div>
  );
}
