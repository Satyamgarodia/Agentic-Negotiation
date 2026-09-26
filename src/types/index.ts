export type CallStatus = 'idle' | 'ringing' | 'connected' | 'speaking' | 'interrupted' | 'ended';

export interface Turn {
  speaker: 'caller' | 'gemini';
  text: string;
  timestamp: string;
}

export interface CallSession {
  id: string;
  callerNumber: string;
  callerName: string;
  direction: 'inbound' | 'outbound';
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  packetsIn: number;
  packetsOut: number;
  avgLatencyMs: number;
  interruptionsCount: number;
  turns: Turn[];
}

export interface GatewayConfig {
  phoneNumberId: string;
  wabaId: string;
  businessPhoneNumber: string;
  verifyToken: string;
  metaAccessToken?: string;
  autoAcceptCalls?: boolean;
  voiceName: string;
  personaName: string;
  systemPrompt: string;
  enabledTools: string[];
}

export interface EndpointsInfo {
  webhookUrl: string;
  twilioVoiceUrl: string;
  browserWsUrl: string;
  mediaStreamWsUrl: string;
}

export interface FunctionExecutionEvent {
  name: string;
  args: any;
  result: any;
  timestamp: string;
}
