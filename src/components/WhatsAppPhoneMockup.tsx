import React, { useState, useEffect, useRef } from 'react';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Lock,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  Wand2,
  RotateCcw,
  Zap,
} from 'lucide-react';
import { CallStatus, Turn } from '../types';
import { AudioWaveform } from './AudioWaveform';

interface WhatsAppPhoneMockupProps {
  status: CallStatus;
  callerName: string;
  callerNumber: string;
  durationSeconds: number;
  turns: Turn[];
  userVolume: number;
  geminiVolume: number;
  isMuted: boolean;
  isSpeakerOn: boolean;
  latencyMs: number;
  activeVoice: string;
  onAcceptCall: () => void;
  onDeclineCall: () => void;
  onEndCall: () => void;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onSendTextPrompt: (text: string) => void;
  onTriggerSimulatedIncoming: () => void;
}

export const WhatsAppPhoneMockup: React.FC<WhatsAppPhoneMockupProps> = ({
  status,
  callerName,
  callerNumber,
  durationSeconds,
  turns,
  userVolume,
  geminiVolume,
  isMuted,
  isSpeakerOn,
  latencyMs,
  activeVoice,
  onAcceptCall,
  onDeclineCall,
  onEndCall,
  onToggleMute,
  onToggleSpeaker,
  onSendTextPrompt,
  onTriggerSimulatedIncoming,
}) => {
  const [customText, setCustomText] = useState('');
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [turns]);

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remSecs.toString().padStart(2, '0')}`;
  };

  const sampleVoicePrompts = [
    { label: 'Check Order #8921', prompt: 'Hello, can you check the shipping status of my WhatsApp order 8921?' },
    { label: 'Book Appointment', prompt: 'I would like to book a dental checkup appointment for this Friday at 3 PM.' },
    { label: 'Business Hours', prompt: 'What are your store opening hours this weekend?' },
    { label: 'Talk to Human Agent', prompt: 'I have a complex billing issue, can you escalate me to a human support agent?' },
  ];

  return (
    <div className="flex flex-col xl:flex-row items-center justify-center gap-8 w-full max-w-5xl mx-auto">
      {/* Mobile Device Frame */}
      <div className="relative w-[340px] sm:w-[380px] h-[700px] bg-slate-950 rounded-[48px] p-3.5 shadow-2xl border-[6px] border-slate-800 shadow-emerald-950/20 ring-1 ring-white/10 flex flex-col overflow-hidden">
        {/* Phone Speaker Notch & Dynamic Island */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 w-32 h-4 bg-slate-900 rounded-full flex items-center justify-center gap-2 z-30">
          <div className="w-10 h-1.5 bg-slate-800 rounded-full" />
          <div className="w-2.5 h-2.5 bg-emerald-500/80 rounded-full animate-pulse" />
        </div>

        {/* Screen Area (WhatsApp Dark Theme: #0b141a / #111b21) */}
        <div className="relative flex-1 rounded-[38px] bg-[#0c1317] text-slate-100 flex flex-col justify-between overflow-hidden pt-8 pb-5 px-4 shadow-inner">
          {/* Subtle WhatsApp background doodle pattern */}
          <div
            className="absolute inset-0 opacity-[0.03] pointer-events-none"
            style={{
              backgroundImage: `radial-gradient(#10b981 1px, transparent 1px)`,
              backgroundSize: '20px 20px',
            }}
          />

          {/* Top WhatsApp Call Header */}
          <div className="relative z-10 flex flex-col items-center text-center pt-2">
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-medium bg-emerald-950/60 border border-emerald-800/40 px-3 py-1 rounded-full mb-2">
              <Lock className="w-3 h-3" />
              <span>WhatsApp Voice • Gemini 3.8 Live</span>
            </div>

            <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              {callerName}
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500 text-[10px] text-slate-950 font-bold">
                ✓
              </span>
            </h2>
            <p className="text-xs text-slate-400 font-mono mt-0.5">{callerNumber}</p>

            {/* Status / Duration */}
            <div className="mt-2 text-xs font-medium">
              {status === 'ringing' && (
                <span className="text-emerald-400 animate-pulse flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  Incoming WhatsApp Call...
                </span>
              )}
              {(status === 'connected' || status === 'speaking' || status === 'interrupted') && (
                <div className="flex items-center gap-2 text-slate-300 font-mono">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span>{formatDuration(durationSeconds)}</span>
                  <span className="text-slate-500">•</span>
                  <span className="text-emerald-400 text-[11px]">{latencyMs > 0 ? `${latencyMs}ms RTT` : 'Live'}</span>
                </div>
              )}
              {status === 'idle' && (
                <span className="text-slate-500">Ready for Incoming / Outbound Call</span>
              )}
              {status === 'ended' && (
                <span className="text-rose-400 font-medium">Call Ended</span>
              )}
            </div>
          </div>

          {/* Center Call Body */}
          <div className="relative z-10 flex-1 flex flex-col items-center justify-center my-2 overflow-hidden">
            {/* Caller Avatar with Audio Reactive Glow */}
            <div className="relative mb-3">
              {/* Outer wave glow ring when Gemini speaks */}
              <div
                className={`absolute inset-0 rounded-full bg-gradient-to-tr from-cyan-500 to-emerald-500 blur-xl opacity-30 transition-all duration-300 ${
                  geminiVolume > 10 ? 'scale-125 opacity-70' : 'scale-100 opacity-20'
                }`}
              />
              <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full border-4 border-slate-700/80 bg-slate-800 flex items-center justify-center overflow-hidden shadow-xl ring-2 ring-emerald-500/30">
                <div className="w-full h-full bg-gradient-to-br from-emerald-600 to-teal-800 flex items-center justify-center text-white text-3xl font-bold">
                  {callerName.charAt(0)}
                </div>
                {/* Voice badge */}
                <div className="absolute bottom-1 right-1 bg-slate-900/90 text-cyan-300 border border-cyan-500/30 text-[9px] px-1.5 py-0.5 rounded-full font-mono flex items-center gap-0.5">
                  <Sparkles className="w-2.5 h-2.5" />
                  {activeVoice}
                </div>
              </div>
            </div>

            {/* Live Audio Visualizer (Waveform) */}
            <div className="w-full px-1 mb-2">
              <AudioWaveform
                userVolume={userVolume}
                geminiVolume={geminiVolume}
                isActive={status === 'connected' || status === 'speaking' || status === 'interrupted'}
                status={status}
              />
            </div>

            {/* Live Transcripts / Captions Container */}
            <div className="w-full h-28 bg-slate-950/70 border border-slate-800/80 rounded-2xl p-2.5 overflow-y-auto text-xs space-y-2 font-sans shadow-inner scrollbar-thin">
              {turns.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center text-[11px] px-3">
                  <MessageSquare className="w-4 h-4 mb-1 text-slate-600" />
                  {status === 'connected'
                    ? 'Speak into your microphone. Gemini 3.8 Live will reply instantly.'
                    : 'Real-time conversation transcript will stream here.'}
                </div>
              ) : (
                turns.map((turn, i) => (
                  <div
                    key={i}
                    className={`flex flex-col ${
                      turn.speaker === 'caller' ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div className="flex items-center gap-1 text-[9px] text-slate-400 mb-0.5 font-mono">
                      <span>{turn.speaker === 'caller' ? 'You (Caller)' : 'Gemini 3.8 Live'}</span>
                      <span>• {turn.timestamp}</span>
                    </div>
                    <div
                      className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-[12px] leading-relaxed ${
                        turn.speaker === 'caller'
                          ? 'bg-emerald-600 text-white rounded-br-none shadow-sm'
                          : 'bg-slate-800 text-cyan-100 border border-cyan-900/40 rounded-bl-none shadow-sm'
                      }`}
                    >
                      {turn.text}
                    </div>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Bottom Call Action Controls */}
          <div className="relative z-10 pt-2 border-t border-slate-800/60">
            {/* If Ringing: Accept & Decline Buttons */}
            {status === 'ringing' && (
              <div className="flex items-center justify-around px-4 py-2">
                <button
                  onClick={onDeclineCall}
                  className="flex flex-col items-center gap-1.5 group cursor-pointer"
                >
                  <div className="w-14 h-14 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-900/50 transition-all duration-150 active:scale-95">
                    <PhoneOff className="w-6 h-6" />
                  </div>
                  <span className="text-[11px] text-slate-400 group-hover:text-rose-400 font-medium">
                    Decline
                  </span>
                </button>

                <div className="text-center">
                  <div className="text-[11px] text-emerald-400 font-medium animate-pulse">
                    Swipe or Tap to Answer
                  </div>
                </div>

                <button
                  onClick={onAcceptCall}
                  className="flex flex-col items-center gap-1.5 group cursor-pointer"
                >
                  <div className="w-14 h-14 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center shadow-lg shadow-emerald-900/50 transition-all duration-150 active:scale-95 animate-bounce">
                    <Phone className="w-7 h-7" />
                  </div>
                  <span className="text-[11px] text-slate-300 group-hover:text-emerald-400 font-medium">
                    Accept
                  </span>
                </button>
              </div>
            )}

            {/* If In-Call: Mute, Speaker, End Call */}
            {(status === 'connected' || status === 'speaking' || status === 'interrupted') && (
              <div className="flex items-center justify-around px-2 py-1">
                {/* Mute button */}
                <button
                  onClick={onToggleMute}
                  className="flex flex-col items-center gap-1 group cursor-pointer"
                  title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  <div
                    className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                      isMuted
                        ? 'bg-amber-500/20 border border-amber-500 text-amber-400'
                        : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                    }`}
                  >
                    {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                  </div>
                  <span className="text-[10px] text-slate-400">{isMuted ? 'Muted' : 'Mute'}</span>
                </button>

                {/* Speaker button */}
                <button
                  onClick={onToggleSpeaker}
                  className="flex flex-col items-center gap-1 group cursor-pointer"
                  title="Toggle speaker"
                >
                  <div
                    className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                      isSpeakerOn
                        ? 'bg-emerald-500/20 border border-emerald-500 text-emerald-400'
                        : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                    }`}
                  >
                    {isSpeakerOn ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
                  </div>
                  <span className="text-[10px] text-slate-400">Speaker</span>
                </button>

                {/* End Call Button */}
                <button
                  onClick={onEndCall}
                  className="flex flex-col items-center gap-1 group cursor-pointer"
                  title="End WhatsApp Call"
                >
                  <div className="w-14 h-14 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-900/50 transition-all active:scale-95">
                    <PhoneOff className="w-6 h-6" />
                  </div>
                  <span className="text-[10px] text-rose-400 font-medium">End</span>
                </button>
              </div>
            )}

            {/* If Idle or Ended: Start New Call options */}
            {(status === 'idle' || status === 'ended') && (
              <div className="flex flex-col gap-2 p-1">
                <button
                  onClick={onTriggerSimulatedIncoming}
                  className="w-full py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50 transition-all cursor-pointer"
                >
                  <Phone className="w-4 h-4" />
                  Simulate WhatsApp Call
                </button>
                <button
                  onClick={onAcceptCall}
                  className="w-full py-2 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs flex items-center justify-center gap-2 border border-slate-700/60 transition-all cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5 text-cyan-400" />
                  Start Direct Live Call Now
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Side Command & Simulation Deck */}
      <div className="flex-1 flex flex-col gap-4 w-full">
        {/* Quick Testing Voice Queries */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <Wand2 className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">One-Click Caller Scenarios</h3>
                <p className="text-xs text-slate-400">Test real WhatsApp customer queries directly with Gemini 3.8 Live</p>
              </div>
            </div>
            <span className="text-[10px] font-mono bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full border border-slate-700/60">
              Live Bridge
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {sampleVoicePrompts.map((item, idx) => (
              <button
                key={idx}
                disabled={status !== 'connected' && status !== 'speaking' && status !== 'interrupted'}
                onClick={() => onSendTextPrompt(item.prompt)}
                className={`p-2.5 rounded-xl border text-left transition-all text-xs flex flex-col justify-between ${
                  status === 'connected' || status === 'speaking' || status === 'interrupted'
                    ? 'bg-slate-800/80 hover:bg-slate-750 border-slate-700/80 hover:border-emerald-500/50 cursor-pointer text-slate-200'
                    : 'bg-slate-900/50 border-slate-800/50 text-slate-500 cursor-not-allowed'
                }`}
              >
                <div className="font-semibold text-emerald-400 flex items-center justify-between">
                  <span>{item.label}</span>
                  <span className="text-[10px] text-slate-500 font-mono">Simulate Turn</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1 line-clamp-2 italic">
                  "{item.prompt}"
                </p>
              </button>
            ))}
          </div>

          {/* Custom query input if user prefers typing */}
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customText.trim()) {
                  onSendTextPrompt(customText.trim());
                  setCustomText('');
                }
              }}
              placeholder={
                status === 'connected' || status === 'speaking'
                  ? 'Type a message to simulate caller speech...'
                  : 'Connect call first to simulate voice input...'
              }
              disabled={status !== 'connected' && status !== 'speaking' && status !== 'interrupted'}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
            />
            <button
              onClick={() => {
                if (customText.trim()) {
                  onSendTextPrompt(customText.trim());
                  setCustomText('');
                }
              }}
              disabled={
                !customText.trim() ||
                (status !== 'connected' && status !== 'speaking' && status !== 'interrupted')
              }
              className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition-all cursor-pointer disabled:cursor-not-allowed"
            >
              Send Turn
            </button>
          </div>
        </div>

        {/* Live Audio & Connection Diagnostics */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl">
          <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
            <Zap className="w-4 h-4 text-cyan-400" />
            Live Audio Pipeline Metrics
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
              <span className="text-slate-400 text-[10px] block">Model</span>
              <span className="text-cyan-400 font-bold">gemini-3.8-live</span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
              <span className="text-slate-400 text-[10px] block">Audio Format</span>
              <span className="text-emerald-400 font-bold">16kHz PCM (In) / 24kHz (Out)</span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
              <span className="text-slate-400 text-[10px] block">Latency (RTT)</span>
              <span className="text-yellow-400 font-bold">{latencyMs > 0 ? `${latencyMs} ms` : '~240 ms'}</span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
              <span className="text-slate-400 text-[10px] block">Voice Preset</span>
              <span className="text-purple-400 font-bold">{activeVoice}</span>
            </div>
          </div>

          <div className="mt-3 p-3 rounded-xl bg-emerald-950/20 border border-emerald-900/40 text-[11px] text-emerald-300/90 leading-relaxed flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              <strong>Barge-in / Interruption Support:</strong> When the user speaks while Gemini is talking, Gemini's Voice Activity Detection (VAD) automatically triggers an interruption event, immediately pausing Gemini's audio and flushing the speaker queue for zero-lag conversational flow.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
