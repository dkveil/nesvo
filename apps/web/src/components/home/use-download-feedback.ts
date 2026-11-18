'use client';

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';

const DOWNLOAD_START_MS = 1500;
const MAGNET_X_PX = 6;
const MAGNET_Y_PX = 4;

export type DownloadFeedbackState = 'idle' | 'downloading' | 'started';

const isPlainClick = (event: MouseEvent) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const useDownloadFeedback = () => {
  const [state, setState] = useState<DownloadFeedbackState>('idle');
  const buttonRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (state !== 'downloading') return;
    const timer = window.setTimeout(
      () => setState('started'),
      DOWNLOAD_START_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    setState('downloading');
  };

  const handlePointerMove = (event: PointerEvent<HTMLAnchorElement>) => {
    const button = buttonRef.current;
    if (!button || event.pointerType !== 'mouse') return;
    const rect = button.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    button.style.setProperty('--glow-x', `${x}px`);
    button.style.setProperty('--glow-y', `${y}px`);
    if (prefersReducedMotion()) return;
    const shiftX = (x / rect.width - 0.5) * 2 * MAGNET_X_PX;
    const shiftY = (y / rect.height - 0.5) * 2 * MAGNET_Y_PX;
    button.style.setProperty('--shift-x', `${shiftX.toFixed(2)}px`);
    button.style.setProperty('--shift-y', `${shiftY.toFixed(2)}px`);
  };

  const handlePointerLeave = () => {
    buttonRef.current?.style.setProperty('--shift-x', '0px');
    buttonRef.current?.style.setProperty('--shift-y', '0px');
  };

  return {
    state,
    buttonRef,
    handleClick,
    handlePointerMove,
    handlePointerLeave,
  };
};
