import { useRef, useState, useEffect, type CSSProperties } from 'react';
import Matter from 'matter-js';
import './FallingText.css';

interface FallingTextProps {
  className?: string;
  text: string;
  highlightWords?: string[];
  highlightClass?: string;
  trigger?: 'click' | 'hover' | 'auto' | 'scroll';
  backgroundColor?: string;
  wireframes?: boolean;
  gravity?: number;
  mouseConstraintStiffness?: number;
  fontSize?: string;
  wordSpacing?: string;
  startDelayMs?: number;
  style?: CSSProperties;
}

export default function FallingText({
  className = '',
  text,
  highlightWords = [],
  highlightClass = 'highlighted',
  trigger = 'auto',
  backgroundColor = 'transparent',
  wireframes = false,
  gravity = 1,
  mouseConstraintStiffness = 0.2,
  fontSize = '1rem',
  wordSpacing = '2px',
  startDelayMs = 0,
  style,
}: FallingTextProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [effectStarted, setEffectStarted] = useState(false);

  useEffect(() => {
    if (trigger === 'auto') {
      if (startDelayMs <= 0) {
        setEffectStarted(true);
        return;
      }

      const timer = window.setTimeout(() => setEffectStarted(true), startDelayMs);
      return () => window.clearTimeout(timer);
    }

    if (trigger === 'scroll' && containerRef.current) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            setEffectStarted(true);
            observer.disconnect();
          }
        },
        { threshold: 0.1 }
      );
      observer.observe(containerRef.current);
      return () => observer.disconnect();
    }
  }, [startDelayMs, trigger]);

  useEffect(() => {
    if (!effectStarted || !containerRef.current || !textRef.current || !canvasContainerRef.current) return;

    const { Engine, Render, World, Bodies, Runner, Mouse, MouseConstraint, Body } = Matter;
    const container = containerRef.current;
    const textTarget = textRef.current;
    const canvasContainer = canvasContainerRef.current;
    const containerRect = container.getBoundingClientRect();
    const width = containerRect.width;
    const height = containerRect.height;
    if (width <= 0 || height <= 0) return;

    const engine = Engine.create();
    engine.world.gravity.y = gravity;

    const render = Render.create({
      element: canvasContainer,
      engine,
      options: {
        width,
        height,
        background: backgroundColor,
        wireframes,
      },
    });

    const boundaryOptions = { isStatic: true, render: { fillStyle: 'transparent' } };
    const floor = Bodies.rectangle(width / 2, height + 25, width, 50, boundaryOptions);
    const leftWall = Bodies.rectangle(-25, height / 2, 50, height, boundaryOptions);
    const rightWall = Bodies.rectangle(width + 25, height / 2, 50, height, boundaryOptions);
    const ceiling = Bodies.rectangle(width / 2, -25, width, 50, boundaryOptions);

    const wordSpans = Array.from(textTarget.querySelectorAll<HTMLElement>('.falling-text-word'));
    const wordBodies = wordSpans.map(elem => {
      const rect = elem.getBoundingClientRect();
      const x = rect.left - containerRect.left + rect.width / 2;
      const y = rect.top - containerRect.top + rect.height / 2;
      const body = Bodies.rectangle(x, y, rect.width, rect.height, {
        render: { fillStyle: 'transparent' },
        restitution: 0.8,
        frictionAir: 0.012,
        friction: 0.2,
      });

      Body.setVelocity(body, { x: (Math.random() - 0.5) * 4, y: 0 });
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.05);
      elem.style.position = 'absolute';
      elem.style.left = `${x}px`;
      elem.style.top = `${y}px`;
      elem.style.transform = 'translate(-50%, -50%)';
      return { elem, body };
    });

    const mouse = Mouse.create(container);
    const mouseConstraint = MouseConstraint.create(engine, {
      mouse,
      constraint: {
        stiffness: mouseConstraintStiffness,
        render: { visible: false },
      },
    });
    render.mouse = mouse;

    World.add(engine.world, [floor, leftWall, rightWall, ceiling, mouseConstraint, ...wordBodies.map(wb => wb.body)]);

    const runner = Runner.create();
    Runner.run(runner, engine);
    Render.run(render);

    const updateLoop = () => {
      wordBodies.forEach(({ body, elem }) => {
        elem.style.left = `${body.position.x}px`;
        elem.style.top = `${body.position.y}px`;
        elem.style.transform = `translate(-50%, -50%) rotate(${body.angle}rad)`;
      });
      frameRef.current = requestAnimationFrame(updateLoop);
    };
    updateLoop();

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      Render.stop(render);
      Runner.stop(runner);
      if (render.canvas && canvasContainer.contains(render.canvas)) {
        canvasContainer.removeChild(render.canvas);
      }
      World.clear(engine.world, false);
      Engine.clear(engine);
    };
  }, [backgroundColor, effectStarted, gravity, mouseConstraintStiffness, wireframes]);

  const handleTrigger = () => {
    if (!effectStarted && (trigger === 'click' || trigger === 'hover')) {
      setEffectStarted(true);
    }
  };

  const words = text.split(' ');

  return (
    <div
      ref={containerRef}
      className={`falling-text-container ${className}`}
      onClick={trigger === 'click' ? handleTrigger : undefined}
      onMouseEnter={trigger === 'hover' ? handleTrigger : undefined}
      style={style}
    >
      <div ref={textRef} className="falling-text-target" style={{ fontSize, lineHeight: 1.4 }}>
        {words.map((word, index) => {
          const normalized = word.replace(/[^\w-]/g, '');
          const isHighlighted = highlightWords.some(highlight => normalized.toLowerCase().startsWith(highlight.toLowerCase()));
          return (
            <span
              className={`falling-text-word ${isHighlighted ? highlightClass : ''}`}
              style={{ marginInline: wordSpacing }}
              key={`${word}-${index}`}
            >
              {word}
            </span>
          );
        })}
      </div>
      <div ref={canvasContainerRef} className="falling-text-canvas" />
    </div>
  );
}
