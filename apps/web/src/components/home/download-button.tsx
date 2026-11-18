'use client';

import { useDownloadFeedback } from './use-download-feedback';

const FEEDBACK_TEXT = {
  downloading: { label: 'Starting download…', detail: 'From GitHub Releases' },
  started: { label: 'Download started', detail: 'Check your downloads folder' },
} as const;

type DownloadButtonProps = {
  href: string;
  label: string;
  detail: string;
};

export const DownloadButton = ({
  href,
  label,
  detail,
}: DownloadButtonProps) => {
  const {
    state,
    buttonRef,
    handleClick,
    handlePointerMove,
    handlePointerLeave,
  } = useDownloadFeedback();
  const text = state === 'idle' ? { label, detail } : FEEDBACK_TEXT[state];

  return (
    <a
      ref={buttonRef}
      className="download-button"
      href={href}
      data-state={state}
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <span className="download-glow" aria-hidden="true" />
      <span className="download-tile" aria-hidden="true">
        <svg className="glyph" viewBox="0 0 64 64" focusable="false">
          <g className="glyph-mark" fill="currentColor">
            <path className="glyph-stem" d="M0 0H20V64H0Z" />
            <path className="glyph-arch" d="M20 0H40L64 24V32H44L32 20H20Z" />
            <path className="glyph-leg" d="M44 32H64V64H44Z" />
          </g>
          <path
            className="glyph-arrow"
            fill="currentColor"
            d="M22 4H42V34H56L32 58L8 34H22Z"
          />
        </svg>
      </span>
      <span
        key={state}
        className="download-text"
        data-swapping={state !== 'idle'}
      >
        <span className="download-label">{text.label}</span>
        <span className="download-detail">{text.detail}</span>
      </span>
      <span className="download-sweep" aria-hidden="true" />
    </a>
  );
};
