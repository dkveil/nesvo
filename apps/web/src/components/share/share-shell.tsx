import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/site-footer';
import { Wordmark } from '@/components/wordmark';

type ShareShellProps = {
  children: ReactNode;
};

export const ShareShell = ({ children }: ShareShellProps) => (
  <>
    <div className="share-bar">
      <a className="share-home" href="/" aria-label="Nesvo home">
        <Wordmark className="share-wordmark" />
      </a>
    </div>
    <main className="share">{children}</main>
    <SiteFooter />
  </>
);
