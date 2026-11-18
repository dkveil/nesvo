'use client';

import { useDownloadFeedback } from './use-download-feedback';

const FEEDBACK_LABEL = {
  downloading: 'Starting download…',
  started: 'Download started',
} as const;

const DownloadArrow = () => (
  <svg
    className="download-arrow"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M8 2.5v9M3.75 7.5 8 11.75l4.25-4.25M3 14h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
    />
  </svg>
);

type DownloadButtonProps = {
  href: string;
  label: string;
};

export const DownloadButton = ({ href, label }: DownloadButtonProps) => {
  const { state, handleClick } = useDownloadFeedback();

  return (
    <a
      className="download-button"
      href={href}
      data-state={state}
      onClick={handleClick}
    >
      <DownloadArrow />
      <span>{state === 'idle' ? label : FEEDBACK_LABEL[state]}</span>
    </a>
  );
};

type InactiveDownloadButtonProps = {
  label: string;
};

export const InactiveDownloadButton = ({
  label,
}: InactiveDownloadButtonProps) => (
  <span className="download-button" aria-disabled="true">
    <DownloadArrow />
    <span>{label}</span>
  </span>
);
