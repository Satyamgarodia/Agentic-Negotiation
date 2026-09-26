import React, { useState } from 'react';
import {
  Sparkles,
  Bot,
  Sliders,
  Check,
  Save,
  Volume2,
  Wrench,
  RotateCcw,
  Languages,
} from 'lucide-react';
import { GatewayConfig } from '../types';

interface PersonaSettingsTabProps {
  config: GatewayConfig;
  onSaveConfig: (newConfig: GatewayConfig) => Promise<void>;
}

export const PersonaSettingsTab: React.FC<PersonaSettingsTabProps> = ({
  config,
  onSaveConfig,
}) => {
  const [formData, setFormData] = useState<GatewayConfig>(config);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const voices = [
    { name: 'Zephyr', description: 'Warm, natural, clear, balanced tone (Default for WhatsApp Support)' },
    { name: 'Puck', description: 'Energetic, upbeat, conversational, friendly' },
    { name: 'Charon', description: 'Calm, authoritative, steady, deep tone' },
    { name: 'Kore', description: 'Gentle, polite, compassionate, empathetic' },
    { name: 'Fenrir', description: 'Resonant, confident, professional' },
  ];

  const presets = [
    {
      name: 'E-Commerce & Orders Support',
      personaName: 'Nova Logistics AI',
      voice: 'Zephyr',
      prompt: `You are the official voice assistant for WhatsApp Business at an e-commerce company. You answer voice calls live from customers with exceptional clarity, empathy, and conciseness.
Keep your spoken responses natural, conversational, and direct (1-3 sentences per turn). Do not use markdown, emojis, or bullet points in voice responses.
You have access to tools for checking orders, scheduling appointments, and transferring to human agents if needed.`,
      tools: ['check_order_status', 'book_appointment', 'get_business_hours', 'escalate_to_human'],
    },
    {
      name: 'Medical Clinic Receptionist',
      personaName: 'Apex Health Desk',
      voice: 'Kore',
      prompt: `You are the friendly WhatsApp voice receptionist for Apex Health Clinic. You help patients check doctor schedules, book or reschedule appointments, and find clinic opening hours.
Always speak warmly, clearly, and reassuringly. Keep answers to 1-2 sentences. Never diagnose medical conditions; advise callers to consult the physician or emergency services for urgent matters.`,
      tools: ['book_appointment', 'get_business_hours', 'escalate_to_human'],
    },
    {
      name: 'Bilingual Hotel Concierge',
      personaName: 'Grand Azure Concierge',
      voice: 'Puck',
      prompt: `You are the luxury WhatsApp voice concierge for Grand Azure Hotel & Suites. You speak English fluently and seamlessly switch to Spanish, French, or Hindi if the guest speaks in those languages.
Assist callers with room reservations, dining bookings, airport transfers, and concierge recommendations. Keep voice answers polite, hospitable, and concise.`,
      tools: ['book_appointment', 'get_business_hours'],
    },
    {
      name: 'Technical IT Helpdesk',
      personaName: 'CloudTech Live Voice',
      voice: 'Fenrir',
      prompt: `You are the technical voice specialist for CloudTech Support on WhatsApp. You assist customers in diagnosing connection issues, checking system service status, and escalating complex outages to engineers.
Speak with crisp technical precision, patience, and clear step-by-step guidance.`,
      tools: ['check_order_status', 'escalate_to_human'],
    },
  ];

  const applyPreset = (preset: (typeof presets)[0]) => {
    setFormData({
      ...formData,
      personaName: preset.personaName,
      voiceName: preset.voice,
      systemPrompt: preset.prompt,
      enabledTools: preset.tools,
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      await onSaveConfig(formData);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleTool = (toolName: string) => {
    const exists = formData.enabledTools.includes(toolName);
    const updated = exists
      ? formData.enabledTools.filter((t) => t !== toolName)
      : [...formData.enabledTools, toolName];
    setFormData({ ...formData, enabledTools: updated });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Title */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Bot className="w-5 h-5 text-purple-400" />
            <h2 className="text-xl font-bold text-white tracking-tight">
              Gemini 3.8 Live Voice Persona &amp; Configuration
            </h2>
          </div>
          <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
            Configure the voice persona, speech style, system instructions, and real-time function
            calling tools invoked during WhatsApp calls.
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg shadow-emerald-950/50 transition-all cursor-pointer shrink-0"
        >
          {saveSuccess ? (
            <>
              <Check className="w-4 h-4 text-slate-950 font-bold" />
              Saved to Gateway!
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              {isSaving ? 'Saving...' : 'Save Configuration'}
            </>
          )}
        </button>
      </div>

      {/* Preset Personas */}
      <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-lg space-y-3">
        <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
          Industry Presets (One-Click Setup)
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {presets.map((preset, idx) => (
            <button
              key={idx}
              onClick={() => applyPreset(preset)}
              className="p-3.5 rounded-xl bg-slate-950/80 hover:bg-slate-800/80 border border-slate-800 hover:border-emerald-500/50 text-left transition-all cursor-pointer flex flex-col justify-between group"
            >
              <div>
                <span className="text-xs font-bold text-slate-200 group-hover:text-emerald-400">
                  {preset.name}
                </span>
                <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">
                  Voice: <strong className="text-cyan-400">{preset.voice}</strong> • {preset.personaName}
                </p>
              </div>
              <span className="mt-3 text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                Apply Template &rarr;
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Voice Selection */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-cyan-400" />
            Gemini 3.8 Live Voice Selection
          </h3>
          <span className="text-xs font-mono text-slate-400">
            Current: <strong className="text-cyan-400">{formData.voiceName}</strong>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {voices.map((v) => {
            const isSelected = formData.voiceName === v.name;
            return (
              <button
                key={v.name}
                onClick={() => setFormData({ ...formData, voiceName: v.name })}
                className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-cyan-950/40 border-cyan-400 ring-1 ring-cyan-400 text-white'
                    : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700 text-slate-300'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold">{v.name}</span>
                  {isSelected && <span className="w-2 h-2 rounded-full bg-cyan-400" />}
                </div>
                <p className="text-[10px] text-slate-400 leading-tight">{v.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* System Instruction / Persona Prompt */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-bold text-white">System Prompt (Conversational Directives)</h3>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Sent in <code className="text-purple-300">ai.live.connect</code> config
          </span>
        </div>

        <textarea
          value={formData.systemPrompt}
          onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
          rows={6}
          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-200 font-mono leading-relaxed focus:outline-none focus:border-emerald-500 scrollbar-thin"
          placeholder="Instruct the model on tone, persona, response length, language..."
        />

        <div className="text-[11px] text-slate-400 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span>
            <strong>Voice Design Tip:</strong> Keep voice directives concise. Gemini 3.8 Live responds in spoken audio, so advise the model to avoid bullet points and URLs.
          </span>
        </div>
      </div>

      {/* Function Calling Tools */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-yellow-400" />
            <h3 className="text-sm font-bold text-white">In-Call Function Calling Tools</h3>
          </div>
          <span className="text-[10px] font-mono bg-yellow-950/60 text-yellow-300 px-2 py-0.5 rounded border border-yellow-800/40">
            Real-time Tool Invocation
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {[
            {
              id: 'check_order_status',
              label: 'check_order_status(orderId)',
              desc: 'Queries shipping status, carrier, and estimated arrival from CRM/inventory.',
            },
            {
              id: 'book_appointment',
              label: 'book_appointment(date, time)',
              desc: 'Schedules a calendar slot and automatically issues a confirmation message.',
            },
            {
              id: 'get_business_hours',
              label: 'get_business_hours()',
              desc: 'Fetches open/closing hours for branches, holidays, and weekend schedules.',
            },
            {
              id: 'escalate_to_human',
              label: 'escalate_to_human(reason)',
              desc: 'Creates an urgent priority ticket and transfers the live call to a staff member.',
            },
          ].map((tool) => {
            const enabled = formData.enabledTools.includes(tool.id);
            return (
              <div
                key={tool.id}
                onClick={() => toggleTool(tool.id)}
                className={`p-3.5 rounded-xl border flex items-start gap-3 cursor-pointer transition-all ${
                  enabled
                    ? 'bg-slate-950 border-emerald-500/50 text-slate-200'
                    : 'bg-slate-950/40 border-slate-800/60 text-slate-500'
                }`}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => toggleTool(tool.id)}
                  className="mt-0.5 accent-emerald-500 cursor-pointer"
                />
                <div>
                  <code className={`font-mono text-xs font-semibold ${enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {tool.label}
                  </code>
                  <p className="text-[11px] text-slate-400 mt-1 leading-snug">{tool.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Meta WhatsApp Cloud API Auto-Answer & Credentials */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 backdrop-blur-md shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <h3 className="text-sm font-bold text-white">Meta WhatsApp Cloud API Call Auto-Pickup</h3>
          </div>
          <span className="text-[10px] font-mono bg-emerald-950/60 text-emerald-300 px-2 py-0.5 rounded border border-emerald-800/40">
            Graph API v21.0
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="text-[11px] font-mono text-slate-400 block mb-1">
              Phone Number ID
            </label>
            <input
              type="text"
              value={formData.phoneNumberId}
              onChange={(e) => setFormData({ ...formData, phoneNumberId: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-mono text-slate-400 block mb-1">
              WhatsApp Business Account ID (WABA)
            </label>
            <input
              type="text"
              value={formData.wabaId}
              onChange={(e) => setFormData({ ...formData, wabaId: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <div>
          <label className="text-[11px] font-mono text-slate-400 block mb-1">
            Meta System User Access Token (for auto-accepting WebRTC calls)
          </label>
          <input
            type="password"
            value={formData.metaAccessToken || ''}
            onChange={(e) => setFormData({ ...formData, metaAccessToken: e.target.value })}
            placeholder="EAA..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
          />
          <p className="text-[10px] text-slate-500 mt-1">
            When a WhatsApp user calls and an SDP Offer arrives, the server calls{' '}
            <code className="text-slate-400 font-mono">POST /v21.0/&#123;phone_number_id&#125;/calls action=accept</code> with this token to pick up the call automatically.
          </p>
        </div>
      </div>
    </div>
  );
};
