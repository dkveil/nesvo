'use client';

import { useEffect, useState, type MouseEvent } from 'react';

const DOWNLOAD_START_MS = 1500;

export type DownloadFeedbackState = 'idle' | 'downloading' | 'started';

const isPlainClick = (event: MouseEvent) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

export const useDownloadFeedback = () => {
  const [state, setState] = useState<DownloadFeedbackState>('idle');

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

  return { state, handleClick };
};
