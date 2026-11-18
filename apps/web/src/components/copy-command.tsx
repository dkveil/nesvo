'use client';

import { useEffect, useRef, useState } from 'react';

const COPIED_RESET_MS = 2000;

type CopyState = 'idle' | 'copied' | 'failed';

type CopyCommandProps = {
  command: string;
  label: string;
};

export const CopyCommand = ({ command, label }: CopyCommandProps) => {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const commandRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(
      () => setCopyState('idle'),
      COPIED_RESET_MS,
    );
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const selectCommand = () => {
    const element = commandRef.current;
    const selection = window.getSelection();
    if (!element || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState('copied');
    } catch {
      selectCommand();
      setCopyState('failed');
    }
  };

  return (
    <div className="command" role="group" aria-label={label}>
      <code ref={commandRef} className="command-text">
        <span className="command-prompt" aria-hidden="true">
          $
        </span>
        {command}
      </code>
      <button
        type="button"
        className="command-copy"
        onClick={handleCopy}
        data-state={copyState}
      >
        {copyState === 'copied'
          ? 'Copied'
          : copyState === 'failed'
            ? 'Press ⌘C'
            : 'Copy'}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copyState === 'copied' ? 'Command copied' : ''}
      </span>
    </div>
  );
};
