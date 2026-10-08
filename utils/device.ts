// iOS Safari / iPadOS detection (incl. iPad masquerading as "MacIntel" with touch). Used to work
// around two WebKit media limitations:
//  • <video> cannot play from a blob: URL (no byte-range support) → use a data: URL instead.
//  • routing an <audio> element through a Web Audio MediaElementSource captures it, breaking
//    pause()/playbackRate → skip the analyser-based visualizer on iOS.
export const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
};

// Coarse-pointer / touch device. Used where CSS :hover is unreliable — on touch
// screens :hover gets "stuck" on after a tap, so hover-reveal overlays must
// become tap-toggles on mobile instead.
export const isTouch = (): boolean => {
  if (typeof window === 'undefined') return false;
  return (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) ||
    (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0);
};
