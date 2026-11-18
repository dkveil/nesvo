import { getCloudflareContext } from '@opennextjs/cloudflare';

import type { SiteDatabase } from './database';
import { readSiteConfig, type SiteConfig } from './site-config';

export type SiteContext = {
  db: SiteDatabase | null;
  config: SiteConfig;
};

export const getSiteContext = async (): Promise<SiteContext> => {
  const { env } = await getCloudflareContext({ async: true });
  return { db: env.DB ?? null, config: readSiteConfig(env) };
};
