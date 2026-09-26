import React, { useEffect, useRef } from 'react';

interface AudioWaveformProps {
  userVolume: number;      // 0 - 100
  geminiVolume: number;    // 0 - 100
  isActive: boolean;
  status: 'idle' | 'ringing' | 'connected' | 'speaking' | 'interrupted' | 'ended';
}

export const AudioWaveform: React.FC<AudioWaveformProps> = ({
  userVolume,
  geminiVolume,
  isActive,
  status,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let phase = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const width = canvas.width;
      const height = canvas.height;
      const centerY = height / 2;

      // Draw baseline grid line
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();

      if (!isActive) {
        // Idle flat line with subtle breathing
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();
        return;
      }

      // Draw Gemini Wave (Cyan / Indigo gradient)
      const geminiAmp = Math.max(2, (geminiVolume / 100) * (height / 2.2));
      const geminiGrad = ctx.createLinearGradient(0, 0, width, 0);
      geminiGrad.addColorStop(0, '#06b6d4');
      geminiGrad.addColorStop(0.5, '#6366f1');
      geminiGrad.addColorStop(1, '#a855f7');

      ctx.beginPath();
      ctx.strokeStyle = geminiGrad;
      ctx.lineWidth = 2.5;

      for (let x = 0; x < width; x++) {
        const normalizedX = x / width;
        const envelope = Math.sin(normalizedX * Math.PI); // taper edges
        const wave =
          Math.sin(normalizedX * 12 + phase * 2) * 0.6 +
          Math.sin(normalizedX * 24 + phase * 3.5) * 0.4;
        const y = centerY - wave * geminiAmp * envelope;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Draw User Mic Wave (WhatsApp Emerald green)
      const userAmp = Math.max(2, (userVolume / 100) * (height / 2.2));
      const userGrad = ctx.createLinearGradient(0, 0, width, 0);
      userGrad.addColorStop(0, '#10b981');
      userGrad.addColorStop(0.5, '#22c55e');
      userGrad.addColorStop(1, '#10b981');

      ctx.beginPath();
      ctx.strokeStyle = userGrad;
      ctx.lineWidth = 2.5;

      for (let x = 0; x < width; x++) {
        const normalizedX = x / width;
        const envelope = Math.sin(normalizedX * Math.PI);
        const wave =
          Math.sin(normalizedX * 16 - phase * 2.2) * 0.6 +
          Math.cos(normalizedX * 28 - phase * 4) * 0.4;
        const y = centerY + wave * userAmp * envelope;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      phase += 0.05;
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isActive, userVolume, geminiVolume, status]);

  return (
    <div className="relative w-full rounded-2xl bg-slate-900/80 border border-slate-800/80 p-3 shadow-inner backdrop-blur-sm">
      <div className="flex items-center justify-between text-[11px] font-mono mb-2 px-1">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-emerald-400 font-semibold">Caller (Mic 16kHz)</span>
          <span className="text-slate-500">{userVolume}%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-slate-500">{geminiVolume}%</span>
          <span className="text-cyan-400 font-semibold">Gemini 3.8 Live (24kHz)</span>
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={360}
        height={70}
        className="w-full h-[70px] block rounded-lg"
      />

      <div className="flex justify-between items-center text-[10px] text-slate-500 mt-1.5 px-1 font-mono">
        <span>Bidir WebSocket: /ws/whatsapp-call</span>
        <span>PCM Int16 LE • Buffer ~250ms</span>
      </div>
    </div>
  );
};
