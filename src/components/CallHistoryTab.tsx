import React, { useState } from 'react';
import {
  PhoneIncoming,
  PhoneOutgoing,
  Clock,
  CheckCircle2,
  Calendar,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Radio,
  Sparkles,
  Zap,
  Send,
} from 'lucide-react';
import { CallSession } from '../types';

interface CallHistoryTabProps {
  calls: CallSession[];
  onSelectCall?: (call: CallSession) => void;
}

export const CallHistoryTab: React.FC<CallHistoryTabProps> = ({ calls }) => {
  const [expandedCallId, setExpandedCallId] = useState<string | null>(calls[0]?.id || null);
  const [sentFollowupId, setSentFollowupId] = useState<string | null>(null);

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${mins}m ${rem}s`;
  };

  const handleSimulateFollowup = (callId: string) => {
    setSentFollowupId(callId);
    setTimeout(() => setSentFollowupId(null), 3000);
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Title banner */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Clock className="w-5 h-5 text-emerald-400" />
            WhatsApp Voice Call History &amp; Transcripts
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Logs of live incoming &amp; outgoing WhatsApp voice calls with latency telemetry, audio packet counts, and AI conversation turns.
          </p>
        </div>
        <span className="text-xs font-mono bg-slate-800 text-slate-300 px-3 py-1 rounded-full border border-slate-700/80">
          {calls.length} Total Recorded Calls
        </span>
      </div>

      {calls.length === 0 ? (
        <div className="p-12 text-center rounded-2xl bg-slate-900/40 border border-slate-800 text-slate-500">
          <PhoneIncoming className="w-8 h-8 mx-auto mb-2 opacity-40 text-slate-400" />
          <p className="text-sm">No WhatsApp voice calls recorded yet.</p>
          <p className="text-xs text-slate-600 mt-1">
            Use the Live Call Simulator or trigger a test webhook to generate a call record.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {calls.map((call) => {
            const isExpanded = expandedCallId === call.id;
            return (
              <div
                key={call.id}
                className="rounded-2xl bg-slate-900/80 border border-slate-800/80 overflow-hidden shadow-lg transition-all"
              >
                {/* Call Summary Bar */}
                <div
                  onClick={() => setExpandedCallId(isExpanded ? null : call.id)}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:bg-slate-850/60 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm ${
                        call.status === 'connected' || call.status === 'speaking'
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 animate-pulse'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {call.direction === 'inbound' ? (
                        <PhoneIncoming className="w-5 h-5 text-emerald-400" />
                      ) : (
                        <PhoneOutgoing className="w-5 h-5 text-cyan-400" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-white">{call.callerName}</span>
                        <span className="text-xs font-mono text-slate-400">
                          {call.callerNumber}
                        </span>
                        {call.status === 'connected' && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-slate-950 animate-pulse">
                            LIVE CALL
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5 font-mono">
                        <span>{new Date(call.startedAt).toLocaleTimeString()}</span>
                        <span>•</span>
                        <span>Duration: {formatDuration(call.durationSeconds)}</span>
                        <span>•</span>
                        <span>Turns: {call.turns.length}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {/* Performance Chips */}
                    <div className="hidden md:flex items-center gap-2 text-[11px] font-mono">
                      <span className="px-2 py-0.5 rounded bg-slate-950 text-cyan-400 border border-slate-800">
                        {call.avgLatencyMs || 240}ms RTT
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-950 text-slate-400 border border-slate-800">
                        {call.interruptionsCount} barge-in
                      </span>
                    </div>

                    <button
                      className="p-1 rounded-lg text-slate-400 hover:text-white transition-colors"
                      title={isExpanded ? 'Collapse' : 'Expand'}
                    >
                      {isExpanded ? (
                        <ChevronUp className="w-5 h-5" />
                      ) : (
                        <ChevronDown className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Expanded Conversation Transcript & WhatsApp Follow-up */}
                {isExpanded && (
                  <div className="p-4 pt-2 border-t border-slate-800/80 bg-slate-950/70 space-y-4">
                    <div>
                      <h4 className="text-xs font-mono text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
                        Full Voice Transcript
                      </h4>
                      {call.turns.length === 0 ? (
                        <div className="text-xs text-slate-500 italic p-3 bg-slate-900/50 rounded-xl">
                          No conversation turns recorded during this call session.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-64 overflow-y-auto pr-2 scrollbar-thin">
                          {call.turns.map((t, idx) => (
                            <div
                              key={idx}
                              className={`p-2.5 rounded-xl text-xs ${
                                t.speaker === 'caller'
                                  ? 'bg-emerald-950/30 border border-emerald-900/40 text-slate-200'
                                  : 'bg-slate-900 border border-cyan-900/40 text-cyan-100'
                              }`}
                            >
                              <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1 font-mono">
                                <span className={t.speaker === 'caller' ? 'text-emerald-400 font-bold' : 'text-cyan-400 font-bold'}>
                                  {t.speaker === 'caller' ? call.callerName : 'Gemini 3.8 Live'}
                                </span>
                                <span>{t.timestamp}</span>
                              </div>
                              <p className="leading-relaxed">{t.text}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* WhatsApp Post-Call Message Summary Preview */}
                    <div className="p-3.5 rounded-xl bg-slate-900 border border-emerald-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <div>
                        <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5" />
                          Automated WhatsApp Post-Call Summary Message
                        </span>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Send the customer an instant WhatsApp text message summarizing the voice call resolution and order/appointment details.
                        </p>
                      </div>
                      <button
                        onClick={() => handleSimulateFollowup(call.id)}
                        className="px-3 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer shrink-0"
                      >
                        {sentFollowupId === call.id ? (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            Message Dispatched!
                          </>
                        ) : (
                          <>
                            <Send className="w-3.5 h-3.5" />
                            Dispatch Summary to WhatsApp
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
