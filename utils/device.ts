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
