import type { Metadata } from 'next';

export const siteMetadata = {
  title: 'Nesvo',
  description:
    'Nesvo is a desktop app for running and supervising AI coding sessions with the Claude Code and Codex CLIs you already use.',
  robots: { index: false, follow: false },
  referrer: 'strict-origin-when-cross-origin',
  formatDetection: { telephone: false, email: false, address: false },
} as const satisfies Metadata;
