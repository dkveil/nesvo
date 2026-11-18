import type { Metadata } from 'next';

export const siteMetadata = {
  title: 'Nesvo',
  description:
    'Vibe with full control. Nesvo runs Claude Code and Codex sessions in parallel on your computers, with workflows, reviews and approvals you configure.',
  robots: { index: false, follow: false },
  referrer: 'strict-origin-when-cross-origin',
  formatDetection: { telephone: false, email: false, address: false },
} as const satisfies Metadata;
