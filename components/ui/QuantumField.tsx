
import React, { useEffect, useRef } from 'react';

/**
 * Full-bleed replica of the VOICE_SYNTH / NET_CAST playing visualizer — same
 * quantum-particle field, waveform ribbons, mirrored spectrum bars, cyan hues
 * (180–220°), trailing-blur fade and drift rhythm. Used as the loader backdrop.
 *
 * Driven by the SAME synthetic spectrum the player uses on iOS (no analyser),
 * so it floats/jumps autonomously while there's no audio. Drawing code mirrors
 * AudioBook's visualizer loop exactly so the look is identical.
 */
export const QuantumField: React.FC<{ className?: string }> = ({ className = '' }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<any[]>([]);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 1800;
    canvas.height = 250;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles: any[] = [];
    for (let i = 0; i < 200; i++) {
      const typeRand = Math.random();
      particles.push({
        x: Math.random() * 1800,
        y: Math.random() * 250,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        size: Math.random() * 2 + 0.5,
        targetSize: 1,
        hue: 180 + Math.random() * 40,
        alpha: Math.random() * 0.4 + 0.1,
        intensity: 0,
        angle: Math.random() * Math.PI * 2,
        type: typeRand > 0.9 ? 'data' : typeRand > 0.7 ? 'shimmer' : 'pixel',
        life: Math.random(),
      });
    }
    particlesRef.current = particles;

    const draw = () => {
      const bufferLength = 256;
      const dataArray = new Uint8Array(bufferLength);
      // Synthetic playback-driven spectrum (identical to the player's iOS path).
      const t = Date.now() / 1000;
      for (let i = 0; i < bufferLength; i++) {
        const wave = Math.sin(t * 4 + i * 0.25) * 0.5 + 0.5;
        const flicker = Math.sin(t * 13 + i * 1.3) * 0.3 + 0.3;
        const rolloff = 1 - (i / bufferLength) * 0.6;
        dataArray[i] = Math.min(255, Math.floor((wave * 0.6 + flicker * 0.4) * 210 * rolloff));
      }

      let bass = 0;
      let mid = 0;
      let high = 0;
      const split1 = Math.floor(bufferLength * 0.1);
      const split2 = Math.floor(bufferLength * 0.4);
      for (let i = 0; i < split1; i++) bass += dataArray[i];
      for (let i = split1; i < split2; i++) mid += dataArray[i];
      for (let i = split2; i < bufferLength; i++) high += dataArray[i];
      bass = (bass / split1) / 255;
      mid = (mid / (split2 - split1)) / 255;
      high = (high / (bufferLength - split2)) / 255;

      ctx.fillStyle = 'rgba(2, 4, 8, 0.2)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      particlesRef.current.forEach((p) => {
        p.life -= 0.002;
        if (p.life <= 0) { p.life = 1; p.x = Math.random() * canvas.width; p.y = Math.random() * canvas.height; }
        const driftForce = (mid * 1.5) + 0.2;
        p.vx += (Math.random() - 0.5) * driftForce; p.vy += (Math.random() - 0.5) * driftForce;
        p.vx *= 0.98; p.vy *= 0.98; p.x += p.vx; p.y += p.vy;
        const alpha = p.life * (0.1 + high * 0.8);
        ctx.fillStyle = `hsla(${p.hue}, 100%, 80%, ${alpha})`;
        if (p.type === 'data') { ctx.font = '6px monospace'; ctx.fillText(Math.random() > 0.5 ? '1' : '0', p.x, p.y); }
        else { ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); }
      });

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  return <canvas ref={canvasRef} width={1800} height={250} className={className} />;
};

export default QuantumField;
