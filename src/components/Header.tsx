import React from 'react';
import {
  PhoneCall,
  Radio,
  Sliders,
  Layers,
  History,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { CallStatus } from '../types';

export type ActiveTab = 'call-simulator' | 'webhook-setup' | 'architecture' | 'persona-tools' | 'call-history';

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  callStatus: CallStatus;
  businessPhoneNumber: string;
  hasApiKey: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  callStatus,
  businessPhoneNumber,
  hasApiKey,
}) => {
  const tabs = [
    { id: 'call-simulator' as ActiveTab, label: 'Live WhatsApp Call', icon: PhoneCall },
    { id: 'webhook-setup' as ActiveTab, label: 'WhatsApp Webhooks & APIs', icon: Radio },
    { id: 'architecture' as ActiveTab, label: 'Audio Pipeline Architecture', icon: Layers },
    { id: 'persona-tools' as ActiveTab, label: 'AI Voice & Tools', icon: Sliders },
    { id: 'call-history' as ActiveTab, label: 'Call Logs & Transcripts', icon: History },
  ];

  return (
    <header className="sticky top-0 z-50 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800/80 px-4 lg:px-8 py-3 transition-all">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Brand & Status */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
          <div className="flex items-center gap-2.5">
            <div className="relative w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20 text-slate-950 font-bold">
              <PhoneCall className="w-5 h-5 text-slate-950" />
              <span className="absolute -top-1 -right-1 w-3 h-3 bg-cyan-400 rounded-full border-2 border-slate-950 animate-ping" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-extrabold text-sm sm:text-base text-white tracking-tight">
                  WhatsApp &times; Gemini 3.8 Live
                </h1>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-800 text-cyan-300 font-semibold">
                  Voice Gateway
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono flex items-center gap-1.5">
                <span>{businessPhoneNumber}</span>
                <span>•</span>
                <span className="text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Meta Webhook Ready
                </span>
              </p>
            </div>
          </div>

          {/* Active Call Indicator */}
          {callStatus !== 'idle' && callStatus !== 'ended' && (
            <div className="md:hidden flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/80 border border-emerald-500 text-emerald-300 text-xs font-mono animate-pulse">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>{callStatus.toUpperCase()}</span>
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <nav className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800/80 overflow-x-auto max-w-full scrollbar-none">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'bg-emerald-500 text-slate-950 font-bold shadow-md shadow-emerald-950/50'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
