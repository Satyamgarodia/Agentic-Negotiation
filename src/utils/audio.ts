/**
 * Audio Utilities for WhatsApp Gemini 3.8 Live Bridge
 * Handles 16kHz PCM mic capture, 24kHz PCM playback queue,
 * instant interruption flush, and WhatsApp ringtone synthesis.
 */

// Synthesize authentic WhatsApp call ringtone with Web Audio API
export class WhatsAppRingtone {
  private ctx: AudioContext | null = null;
  private isRinging = false;
  private ringInterval: any = null;

  start() {
    if (this.isRinging) return;
    this.isRinging = true;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
    } catch (e) {
      console.warn('AudioContext not allowed or not supported', e);
      return;
    }

    const playChime = () => {
      if (!this.isRinging || !this.ctx) return;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }

      const now = this.ctx.currentTime;
      // WhatsApp-style marimba chime sequence: E5 (659Hz) -> G5 (784Hz) -> B5 (988Hz)
      const freqs = [659.25, 783.99, 987.77, 783.99];
      freqs.forEach((freq, idx) => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.12);

        gain.gain.setValueAtTime(0, now + idx * 0.12);
        gain.gain.linearRampToValueAtTime(0.18, now + idx * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.12 + 0.35);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now + idx * 0.12);
        osc.stop(now + idx * 0.12 + 0.4);
      });
    };

    playChime();
    this.ringInterval = setInterval(playChime, 2400);
  }

  stop() {
    this.isRinging = false;
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
    }
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch (e) {}
      this.ctx = null;
    }
  }
}

// Capture mic audio at 16kHz PCM (Gemini Live standard format)
export class MicRecorder {
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private isRecording = false;

  constructor(
    private onAudioData: (base64Pcm: string, volume: number) => void,
    private onError: (err: any) => void
  ) {}

  async start() {
    if (this.isRecording) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      // Resample to 16000Hz for Gemini Live API
      this.audioCtx = new AudioCtx({ sampleRate: 16000 });

      const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;

      // 4096 samples at 16kHz = ~256ms audio packet
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

      source.connect(this.analyser);
      this.analyser.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);

      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording) return;
        const inputData = e.inputBuffer.getChannelData(0);

        // Convert Float32Array (-1.0 to 1.0) to 16-bit Signed PCM Little-Endian
        let sum = 0;
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          sum += Math.abs(s);
        }

        const volume = Math.min(100, Math.round((sum / inputData.length) * 500));

        // Convert Int16Array buffer to Base64
        const uint8 = new Uint8Array(pcm16.buffer);
        let binary = '';
        const len = uint8.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        const base64 = btoa(binary);

        this.onAudioData(base64, volume);
      };

      this.isRecording = true;
    } catch (err) {
      console.error('MicRecorder start failed:', err);
      this.onError(err);
    }
  }

  stop() {
    this.isRecording = false;

    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch (e) {}
      this.processor = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {}
      this.audioCtx = null;
    }
  }
}

// 24kHz PCM Audio Output Player with seamless queueing & instant interruption flush
export class PCMPlayer {
  private audioCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  public analyser: AnalyserNode | null = null;

  constructor() {
    this.initContext();
  }

  private initContext() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtx({ sampleRate: 24000 });
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.audioCtx.destination);
    } catch (e) {
      console.warn('Failed to init PCMPlayer AudioContext:', e);
    }
  }

  playChunk(base64Pcm: string, onLevel?: (level: number) => void) {
    if (!this.audioCtx) {
      this.initContext();
    }
    if (!this.audioCtx) return;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    try {
      // Decode Base64 to ArrayBuffer
      const binary = atob(base64Pcm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Convert 16-bit signed PCM to Float32
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      let sum = 0;
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
        sum += Math.abs(float32[i]);
      }

      if (onLevel) {
        const avg = (sum / int16.length) * 400;
        onLevel(Math.min(100, Math.round(avg)));
      }

      // Create AudioBuffer
      const audioBuffer = this.audioCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;

      if (this.analyser) {
        source.connect(this.analyser);
      } else {
        source.connect(this.audioCtx.destination);
      }

      const currentTime = this.audioCtx.currentTime;
      if (this.nextPlayTime < currentTime) {
        this.nextPlayTime = currentTime + 0.03; // small jitter buffer
      }

      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;

      this.activeSources.push(source);
      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        if (idx !== -1) {
          this.activeSources.splice(idx, 1);
        }
      };
    } catch (err) {
      console.error('PCMPlayer playChunk error:', err);
    }
  }

  // Instant interruption / barge-in flush: stops speech immediately
  stopAndClear() {
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch (e) {}
    }
    this.activeSources = [];
    if (this.audioCtx) {
      this.nextPlayTime = this.audioCtx.currentTime;
    }
  }

  destroy() {
    this.stopAndClear();
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {}
      this.audioCtx = null;
    }
  }
}
