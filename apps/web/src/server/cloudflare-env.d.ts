import type { SiteDatabase } from './database';

declare global {
  interface CloudflareEnv {
    DB?: SiteDatabase;
    NESVO_RELEASE_REPO?: string;
    NESVO_RELEASE_API_ORIGIN?: string;
  }
}

export {};
