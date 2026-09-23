import React, { useRef } from 'react';
import { motion, useMotionValue, useSpring } from 'motion/react';

const springValues = {
  damping: 30,
  stiffness: 100,
  mass: 2,
};

interface TiltedCardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  scaleOnHover?: number;
  rotateAmplitude?: number;
}

// Adapted from the ReactBits TiltedCard. The original tilts an <img>; this variant tilts arbitrary
// children (used here for the landing demo videos) toward the cursor. Self-contained — no CSS file.
export default function TiltedCard({
  children,
  className = '',
  style,
  scaleOnHover = 1.06,
  rotateAmplitude = 10,
}: TiltedCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const rotateX = useSpring(useMotionValue(0), springValues);
  const rotateY = useSpring(useMotionValue(0), springValues);
  const scale = useSpring(1, springValues);

  function handleMouse(e: React.MouseEvent) {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left - rect.width / 2;
    const offsetY = e.clientY - rect.top - rect.height / 2;
    rotateX.set((offsetY / (rect.height / 2)) * -rotateAmplitude);
    rotateY.set((offsetX / (rect.width / 2)) * rotateAmplitude);
  }

  function handleMouseEnter() {
    scale.set(scaleOnHover);
  }

  function handleMouseLeave() {
    scale.set(1);
    rotateX.set(0);
    rotateY.set(0);
  }

  return (
    <div
      ref={ref}
      className={className}
      style={{ perspective: '900px', ...style }}
      onMouseMove={handleMouse}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <motion.div style={{ width: '100%', rotateX, rotateY, scale, transformStyle: 'preserve-3d' }}>
        {children}
      </motion.div>
    </div>
  );
}
