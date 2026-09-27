import React, { useEffect, useRef, useState } from 'react';
import {
  Terminal,
  Pause,
  Play,
  Trash2,
  RefreshCw,
  Search,
} from 'lucide-react';

interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  callId?: string;
  msg: string;
  data?: any;
}

const levelText: Record<string, string> = {
  debug: 'text-slate-400',
  info: 'text-cyan-300',
  warn: 'text-yellow-300',
  error: 'text-rose-400',
};

const levelBadge: Record<string, string> = {
  debug: 'bg-slate-800 text-slate-300 border-slate-700',
  info: 'bg-cyan-950 text-cyan-300 border-cyan-800',
  warn: 'bg-yellow-950 text-yellow-300 border-yellow-800',
  error: 'bg-rose-950 text-rose-300 border-rose-800',
};

// Expected happy-path order — used to highlight where a call got stuck.
const PIPELINE_STAGES = [
  'pickup_started',
  'livekit_ready',
  'waiting_bridge',
  'bridge_answered',
  'gemini_connected',
  'meta_accepted',
  'media_flowing_in',
  'media_flowing_out',
  'pickup_complete',
];

// Short display form for call IDs (notably long Meta `wacid.*` IDs).
// Strips the `wacid` prefix and keeps first 4 + last 4 chars so rows stay
// readable. Full ID is kept in the filter haystack and in `title` hover.
const shortId = (id?: string): string => {
  if (!id) return '';
  const stripped = id.replace(/^wacid[._-]?/i, '');
  if (stripped.length <= 8) return stripped;
  return `${stripped.slice(0, 4)}…${stripped.slice(-4)}`;
};

export const LogsTab: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [levelFilter, setLevelFilter] = useState('');
  const [textFilter, setTextFilter] = useState('');
  const [connected, setConnected] = useState(false);
  const [activeCallId, setActiveCallId] = useState('');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Initial backfill
    fetch('/api/logs?limit=200')
      .then((r) => r.json())
      .then((d) => {
        if (d.logs) setLogs((d.logs as LogEntry[]).reverse());
      })
      .catch(() => {});

    const es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const entry = JSON.parse(ev.data) as LogEntry;
        if (!entry.ts || !entry.msg) return; // hello frame
        setLogs((prev) => [...prev.slice(-799), entry]);
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (follow && !paused && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [logs, follow, paused]);

  const handleRefresh = async () => {
    try {
      const res = await fetch('/api/logs?limit=300');
      const data = await res.json();
      if (data.logs) setLogs((data.logs as LogEntry[]).reverse());
    } catch {
      // ignore
    }
  };

  const filtered = logs.filter((l) => {
    if (levelFilter && l.level !== levelFilter) return false;
    if (activeCallId && l.callId !== activeCallId) return false;
    if (textFilter) {
      const hay = `${l.stage} ${l.msg} ${l.callId || ''} ${l.data ? JSON.stringify(l.data) : ''}`.toLowerCase();
      if (!hay.includes(textFilter.toLowerCase())) return false;
    }
    return true;
  });

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
              Live Server Logs
              <span className={`flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded-full border ${connected ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : 'bg-rose-950 text-rose-300 border-rose-800'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
                {connected ? 'STREAMING' : 'RECONNECTING'}
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Every pickup stage: webhook → LiveKit → Gemini → Meta accept → media. Stuck calls stop at the failing stage.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(!paused)}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer"
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={handleRefresh}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            onClick={() => setLogs([])}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
              className="accent-emerald-500 cursor-pointer"
            />
            Follow
          </label>
        </div>
      </div>

      {/* Pipeline quick reference */}
      <div className="px-5 py-3 rounded-2xl bg-slate-950/70 border border-slate-800/80 text-[11px] font-mono text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-slate-500 mr-1">Happy path:</span>
        {PIPELINE_STAGES.map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            <span className="text-emerald-400">{s}</span>
            {i < PIPELINE_STAGES.length - 1 && <span className="text-slate-600">→</span>}
          </span>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
        >
          <option value="">All levels</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn (problems)</option>
          <option value="error">error (failures)</option>
        </select>
        <input
          type="text"
          value={activeCallId}
          onChange={(e) => setActiveCallId(e.target.value.trim())}
          placeholder="Filter by call ID (e.g. wa_call_...)"
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono placeholder-slate-500 focus:outline-none focus:border-emerald-500"
        />
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Search stage / message (e.g. livekit, meta, gemini)"
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {/* Log stream */}
      <div className="rounded-2xl bg-slate-950 border border-slate-800/80 shadow-xl overflow-hidden">
        <div className="h-[480px] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed space-y-0.5 scrollbar-thin">
          {filtered.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center text-xs font-sans">
              <Terminal className="w-6 h-6 mb-2 opacity-50" />
              {logs.length === 0
                ? 'Waiting for log events… trigger a call to see the pickup pipeline here.'
                : 'No entries match the current filters.'}
            </div>
          ) : (
            filtered.map((l, i) => (
              <div key={`${l.ts}-${i}`} className="flex items-start gap-2 px-2 py-0.5 rounded hover:bg-slate-900/80">
                <span className="text-slate-500 shrink-0">{formatTime(l.ts)}</span>
                <span className={`shrink-0 px-1.5 rounded border text-[10px] font-bold ${levelBadge[l.level]}`}>
                  {l.level.toUpperCase()}
                </span>
                <span className="shrink-0 text-purple-300">[{l.stage}]</span>
                {l.callId && <span className="shrink-0 text-emerald-400" title={l.callId}>[{shortId(l.callId)}]</span>}
                <span className={`${levelText[l.level]} break-all`}>
                  {l.msg}
                  {l.data !== undefined && (
                    <details className="inline ml-1">
                      <summary className="inline cursor-pointer text-slate-500 hover:text-slate-300">+data</summary>
                      <pre className="mt-1 p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 whitespace-pre-wrap break-all">
                        {JSON.stringify(l.data, null, 2)}
                      </pre>
                    </details>
                  )}
                </span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
        <div className="px-4 py-2 border-t border-slate-800/60 text-[10px] font-mono text-slate-500 flex items-center justify-between">
          <span>{filtered.length} shown / {logs.length} buffered (server keeps last 1500)</span>
          <span>Full history: Cloud Run → Logs Explorer, filter <code className="text-cyan-400">pickup</code></span>
        </div>
      </div>
    </div>
  );
};
