import { useEffect, useState, useRef, useMemo, useCallback, type HTMLAttributes } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { motion } from 'motion/react';

const styles = {
  wrapper: {
    display: 'inline-block',
    whiteSpace: 'pre-wrap' as const,
  },
  srOnly: {
    position: 'absolute' as const,
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    border: 0,
  },
};

interface DecryptedTextProps extends HTMLAttributes<HTMLSpanElement> {
  text: string;
  speed?: number;
  maxIterations?: number;
  sequential?: boolean;
  revealDirection?: 'start' | 'end' | 'center';
  useOriginalCharsOnly?: boolean;
  characters?: string;
  className?: string;
  parentClassName?: string;
  encryptedClassName?: string;
  animateOn?: 'view' | 'hover' | 'inViewHover' | 'click';
  clickMode?: 'once' | 'toggle';
}

export default function DecryptedText({
  text,
  speed = 50,
  maxIterations = 10,
  sequential = false,
  revealDirection = 'start',
  useOriginalCharsOnly = false,
  characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+',
  className = '',
  parentClassName = '',
  encryptedClassName = '',
  animateOn = 'hover',
  clickMode = 'once',
  ...props
}: DecryptedTextProps) {
  const [displayText, setDisplayText] = useState(text);
  const [isAnimating, setIsAnimating] = useState(false);
  const [revealedIndices, setRevealedIndices] = useState<Set<number>>(new Set());
  const [hasAnimated, setHasAnimated] = useState(false);
  const [isDecrypted, setIsDecrypted] = useState(animateOn !== 'click');
  const [direction, setDirection] = useState<'forward' | 'reverse'>('forward');
  const reducedMotion = usePrefersReducedMotion();

  const containerRef = useRef<HTMLSpanElement | null>(null);
  const orderRef = useRef<number[]>([]);
  const pointerRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const availableChars = useMemo(() => {
    return useOriginalCharsOnly
      ? Array.from(new Set(text.split(''))).filter(char => char !== ' ')
      : characters.split('');
  }, [characters, text, useOriginalCharsOnly]);

  const shuffleText = useCallback(
    (originalText: string, currentRevealed: Set<number>) => {
      return originalText
        .split('')
        .map((char, index) => {
          if (char === ' ') return ' ';
          if (currentRevealed.has(index)) return originalText[index];
          return availableChars[Math.floor(Math.random() * availableChars.length)] || char;
        })
        .join('');
    },
    [availableChars]
  );

  const computeOrder = useCallback(
    (length: number) => {
      const order: number[] = [];
      if (length <= 0) return order;
      if (revealDirection === 'start') {
        for (let index = 0; index < length; index++) order.push(index);
        return order;
      }
      if (revealDirection === 'end') {
        for (let index = length - 1; index >= 0; index--) order.push(index);
        return order;
      }
      const middle = Math.floor(length / 2);
      let offset = 0;
      while (order.length < length) {
        if (offset % 2 === 0) {
          const index = middle + offset / 2;
          if (index >= 0 && index < length) order.push(index);
        } else {
          const index = middle - Math.ceil(offset / 2);
          if (index >= 0 && index < length) order.push(index);
        }
        offset++;
      }
      return order.slice(0, length);
    },
    [revealDirection]
  );

  const fillAllIndices = useCallback(() => {
    const next = new Set<number>();
    for (let index = 0; index < text.length; index++) next.add(index);
    return next;
  }, [text]);

  const removeRandomIndices = useCallback((set: Set<number>, count: number) => {
    const arr = Array.from(set);
    for (let index = 0; index < count && arr.length > 0; index++) {
      arr.splice(Math.floor(Math.random() * arr.length), 1);
    }
    return new Set(arr);
  }, []);

  const encryptInstantly = useCallback(() => {
    const emptySet = new Set<number>();
    setRevealedIndices(emptySet);
    setDisplayText(shuffleText(text, emptySet));
    setIsDecrypted(false);
  }, [shuffleText, text]);

  const triggerDecrypt = useCallback(() => {
    if (sequential) {
      orderRef.current = computeOrder(text.length);
      pointerRef.current = 0;
    }
    setRevealedIndices(new Set());
    setDirection('forward');
    setIsAnimating(true);
  }, [computeOrder, sequential, text.length]);

  const triggerReverse = useCallback(() => {
    if (sequential) {
      orderRef.current = computeOrder(text.length).slice().reverse();
      pointerRef.current = 0;
    }
    const allIndices = fillAllIndices();
    setRevealedIndices(allIndices);
    setDisplayText(shuffleText(text, allIndices));
    setDirection('reverse');
    setIsAnimating(true);
  }, [computeOrder, fillAllIndices, sequential, shuffleText, text]);

  useEffect(() => {
    if (!isAnimating) return;

    let currentIteration = 0;
    const getNextIndex = (revealedSet: Set<number>) => {
      if (sequential && orderRef.current.length > 0) {
        return orderRef.current[pointerRef.current++] ?? 0;
      }
      switch (revealDirection) {
        case 'end':
          return text.length - 1 - revealedSet.size;
        case 'center': {
          const middle = Math.floor(text.length / 2);
          const offset = Math.floor(revealedSet.size / 2);
          const nextIndex = revealedSet.size % 2 === 0 ? middle + offset : middle - offset - 1;
          if (nextIndex >= 0 && nextIndex < text.length && !revealedSet.has(nextIndex)) return nextIndex;
          for (let index = 0; index < text.length; index++) {
            if (!revealedSet.has(index)) return index;
          }
          return 0;
        }
        default:
          return revealedSet.size;
      }
    };

    intervalRef.current = setInterval(() => {
      setRevealedIndices(prevRevealed => {
        if (direction === 'forward') {
          if (sequential) {
            if (prevRevealed.size < text.length) {
              const nextRevealed = new Set(prevRevealed);
              nextRevealed.add(getNextIndex(prevRevealed));
              setDisplayText(shuffleText(text, nextRevealed));
              return nextRevealed;
            }
          } else {
            setDisplayText(shuffleText(text, prevRevealed));
            currentIteration++;
            if (currentIteration < maxIterations) return prevRevealed;
          }
          if (intervalRef.current) clearInterval(intervalRef.current);
          setIsAnimating(false);
          setDisplayText(text);
          setIsDecrypted(true);
          return fillAllIndices();
        }

        if (sequential) {
          if (pointerRef.current < orderRef.current.length) {
            const nextRevealed = new Set(prevRevealed);
            nextRevealed.delete(orderRef.current[pointerRef.current++]);
            setDisplayText(shuffleText(text, nextRevealed));
            return nextRevealed;
          }
        } else {
          const currentSet = prevRevealed.size === 0 ? fillAllIndices() : prevRevealed;
          const removeCount = Math.max(1, Math.ceil(text.length / Math.max(1, maxIterations)));
          const nextSet = removeRandomIndices(currentSet, removeCount);
          setDisplayText(shuffleText(text, nextSet));
          currentIteration++;
          if (nextSet.size > 0 && currentIteration < maxIterations) return nextSet;
        }
        if (intervalRef.current) clearInterval(intervalRef.current);
        setIsAnimating(false);
        setIsDecrypted(false);
        setDisplayText(shuffleText(text, new Set()));
        return new Set();
      });
    }, speed);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [direction, fillAllIndices, isAnimating, maxIterations, removeRandomIndices, revealDirection, sequential, shuffleText, speed, text]);

  const handleClick = () => {
    if (animateOn !== 'click') return;
    if (clickMode === 'once') {
      if (isDecrypted) return;
      setDirection('forward');
      triggerDecrypt();
    } else if (isDecrypted) {
      triggerReverse();
    } else {
      setDirection('forward');
      triggerDecrypt();
    }
  };

  const triggerHoverDecrypt = useCallback(() => {
    if (isAnimating || reducedMotion) return;
    setRevealedIndices(new Set());
    setIsDecrypted(false);
    setDisplayText(text);
    setDirection('forward');
    setIsAnimating(true);
  }, [isAnimating, text, reducedMotion]);

  const resetToPlainText = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsAnimating(false);
    setRevealedIndices(new Set());
    setDisplayText(text);
    setIsDecrypted(true);
    setDirection('forward');
  }, [text]);

  useEffect(() => {
    if (animateOn !== 'view' && animateOn !== 'inViewHover') return;
    if (reducedMotion) return; // reduced motion: no scramble-on-view, text stays plain
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !hasAnimated) {
          triggerDecrypt();
          setHasAnimated(true);
        }
      });
    }, { threshold: 0.1 });
    const currentRef = containerRef.current;
    if (currentRef) observer.observe(currentRef);
    return () => {
      if (currentRef) observer.unobserve(currentRef);
    };
  }, [animateOn, hasAnimated, triggerDecrypt, reducedMotion]);

  useEffect(() => {
    if (animateOn === 'click' && !reducedMotion) {
      encryptInstantly();
    } else {
      // Non-click, or reduced motion: show the final plain text (no initial scramble).
      setDisplayText(text);
      setIsDecrypted(true);
    }
    setRevealedIndices(new Set());
    setDirection('forward');
  }, [animateOn, encryptInstantly, text, reducedMotion]);

  const animateProps =
    animateOn === 'hover' || animateOn === 'inViewHover'
      ? { onMouseEnter: triggerHoverDecrypt, onMouseLeave: resetToPlainText }
      : animateOn === 'click'
        ? { onClick: handleClick }
        : {};

  return (
    <motion.span className={parentClassName} ref={containerRef} style={styles.wrapper} {...animateProps} {...props}>
      <span style={styles.srOnly}>{displayText}</span>
      <span aria-hidden="true">
        {displayText.split('').map((char, index) => {
          const isRevealedOrDone = revealedIndices.has(index) || (!isAnimating && isDecrypted);
          return (
            <span key={`${char}-${index}`} className={isRevealedOrDone ? className : encryptedClassName}>
              {char}
            </span>
          );
        })}
      </span>
    </motion.span>
  );
}
