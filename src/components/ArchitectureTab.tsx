import React from 'react';
import {
  Layers,
  ArrowRight,
  Radio,
  Cpu,
  Volume2,
  Zap,
  ShieldCheck,
  RefreshCw,
  GitBranch,
} from 'lucide-react';

export const ArchitectureTab: React.FC = () => {
  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Title */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <Layers className="w-5 h-5" />
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            WhatsApp Calling &plus; Gemini 3.8 Live Architecture
          </h2>
        </div>
        <p className="text-sm text-slate-300 leading-relaxed max-w-3xl">
          Connecting voice calls requires sub-300ms bidirectional audio streaming. This architecture
          bridges WhatsApp VoIP codecs (Opus/RTP/μ-law) to the Gemini 3.8 Live API WebSocket with
          real-time Voice Activity Detection (VAD) and immediate barge-in interruption.
        </p>
      </div>

      {/* Interactive Visual Flow Diagram */}
      <div className="p-6 rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl overflow-x-auto">
        <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-6 flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-emerald-400" />
          End-to-End Bidirectional Audio Pipeline
        </h3>

        <div className="flex flex-col md:flex-row items-center justify-between gap-4 min-w-[750px] relative">
          {/* Node 1: WhatsApp Caller */}
          <div className="flex-1 p-4 rounded-xl bg-slate-900 border border-emerald-500/40 relative group hover:border-emerald-400 transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/40">
                1. Caller Node
              </span>
              <span className="text-emerald-400 text-xs font-bold">WhatsApp Client</span>
            </div>
            <p className="text-xs text-slate-300 font-semibold">User speaks into WhatsApp</p>
            <p className="text-[11px] text-slate-400 mt-1">
              Encrypted VoIP RTP stream, Opus/G.711 μ-law audio frames.
            </p>
            <div className="mt-3 text-[10px] font-mono text-emerald-400/90 flex items-center gap-1">
              <Radio className="w-3 h-3 animate-pulse" />
              <span>Network latency: ~30-50ms</span>
            </div>
          </div>

          <ArrowRight className="w-5 h-5 text-slate-500 shrink-0 hidden md:block" />

          {/* Node 2: Telephony / Gateway Webhook & Media Server */}
          <div className="flex-1 p-4 rounded-xl bg-slate-900 border border-cyan-500/40 relative group hover:border-cyan-400 transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/40">
                2. Voice Gateway
              </span>
              <span className="text-cyan-400 text-xs font-bold">Node.js Express / WS</span>
            </div>
            <p className="text-xs text-slate-300 font-semibold">Transcoder &amp; Jitter Buffer</p>
            <p className="text-[11px] text-slate-400 mt-1">
              Converts telephony audio to 16kHz Linear PCM Little-Endian frames.
            </p>
            <div className="mt-3 text-[10px] font-mono text-cyan-400/90 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />
              <span>Transcode latency: &lt;5ms</span>
            </div>
          </div>

          <ArrowRight className="w-5 h-5 text-slate-500 shrink-0 hidden md:block" />

          {/* Node 3: Gemini 3.8 Live API */}
          <div className="flex-1 p-4 rounded-xl bg-slate-900 border border-purple-500/40 relative group hover:border-purple-400 transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800/40">
                3. Live Model
              </span>
              <span className="text-purple-400 text-xs font-bold">gemini-3.8-live</span>
            </div>
            <p className="text-xs text-slate-300 font-semibold">Bidirectional Live Audio Session</p>
            <p className="text-[11px] text-slate-400 mt-1">
              Native multi-modal audio reasoning, real-time VAD &amp; 24kHz voice output.
            </p>
            <div className="mt-3 text-[10px] font-mono text-purple-400/90 flex items-center gap-1">
              <Zap className="w-3 h-3" />
              <span>Inference latency: ~140ms</span>
            </div>
          </div>
        </div>

        {/* Latency Summary Bar */}
        <div className="mt-6 pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2 mb-2 sm:mb-0">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-semibold text-white">Total Round-Trip Latency:</span>
            <span className="font-mono text-emerald-400 font-bold">~220ms - 280ms</span>
            <span className="text-slate-500">(Feels instantaneous like talking to a human)</span>
          </div>
          <div className="font-mono text-[11px] text-slate-500">
            Zero intermediate STT &rarr; LLM &rarr; TTS lag!
          </div>
        </div>
      </div>

      {/* Deep-Dive Architectural Highlights */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Barge-In (Interruption Handling) */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-lg space-y-2">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
            <Zap className="w-4 h-4" />
            Barge-in / Voice Interruption Handling
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            In human telephone conversations, callers naturally interject with "Wait", "Actually", or
            "One moment". Traditional bots keep talking until their audio file finishes.
          </p>
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80 text-[11px] text-slate-300 space-y-1.5 font-sans">
            <div className="text-emerald-300 font-semibold">How Gemini 3.8 Live solves this:</div>
            <div>
              1. The caller speaks while Gemini audio is playing.
            </div>
            <div>
              2. Gemini's on-chip Voice Activity Detection fires{' '}
              <code className="text-cyan-300 font-mono">interrupted: true</code>.
            </div>
            <div>
              3. The Voice Gateway immediately flushes the outgoing audio buffer and instructs the WhatsApp telephony stream to silence audio instantly.
            </div>
          </div>
        </div>

        {/* Codec & Sampling Alignment */}
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-lg space-y-2">
          <div className="flex items-center gap-2 text-cyan-400 font-semibold text-sm">
            <Cpu className="w-4 h-4" />
            Audio Sampling &amp; Codec Normalization
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            WhatsApp Calling and standard telephony operate on either 8,000Hz (G.711) or 16,000Hz (Opus). Gemini 3.8 Live API strictly requires:
          </p>
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80 text-[11px] text-slate-300 space-y-1.5 font-mono">
            <div className="flex justify-between">
              <span className="text-slate-400">Input to Gemini:</span>
              <span className="text-emerald-400">audio/pcm;rate=16000 (16-bit LE)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Output from Gemini:</span>
              <span className="text-cyan-400">audio/pcm;rate=24000 (16-bit LE)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Packet Duration:</span>
              <span className="text-purple-400">~100ms - 250ms chunks</span>
            </div>
          </div>
        </div>
      </div>

      {/* Comparison: Text Bot vs Gemini 3.8 Live Voice */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl">
        <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          Why Direct Live Voice Trumps Legacy "STT &rarr; LLM &rarr; TTS"
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-mono text-[11px]">
                <th className="py-2.5 px-3">Metric / Feature</th>
                <th className="py-2.5 px-3 text-slate-400">Legacy Voice Bot Pipeline</th>
                <th className="py-2.5 px-3 text-emerald-400">Gemini 3.8 Live Voice Bridge</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              <tr>
                <td className="py-2.5 px-3 font-semibold text-white">Voice Latency</td>
                <td className="py-2.5 px-3 text-rose-400">1,800ms - 3,500ms (High lag)</td>
                <td className="py-2.5 px-3 text-emerald-400 font-semibold">220ms - 280ms (Instantaneous)</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 font-semibold text-white">Barge-in / Interruption</td>
                <td className="py-2.5 px-3 text-slate-400">Clunky, requires manual sentence detection</td>
                <td className="py-2.5 px-3 text-emerald-400 font-semibold">Native on-chip hardware VAD</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 font-semibold text-white">Tone &amp; Emotion</td>
                <td className="py-2.5 px-3 text-slate-400">Flat synthetic robot speech</td>
                <td className="py-2.5 px-3 text-emerald-400 font-semibold">Human-like inflection, pacing, empathy</td>
              </tr>
              <tr>
                <td className="py-2.5 px-3 font-semibold text-white">Tool Use during Call</td>
                <td className="py-2.5 px-3 text-slate-400">Slow round-trip pauses speech</td>
                <td className="py-2.5 px-3 text-emerald-400 font-semibold">Concurrent streaming function calling</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
