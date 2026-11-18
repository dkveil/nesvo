import { z } from 'zod';

export const DEFAULT_RELEASE_REPOSITORY = 'dkveil/nesvo';
export const DEFAULT_RELEASE_API_ORIGIN = 'https://api.github.com';

const siteConfigSchema = z.object({
  releaseRepository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .catch(DEFAULT_RELEASE_REPOSITORY),
  releaseApiOrigin: z
    .url({ protocol: /^https?$/ })
    .transform(value => value.replace(/\/+$/, ''))
    .catch(DEFAULT_RELEASE_API_ORIGIN),
});

export type SiteConfig = z.infer<typeof siteConfigSchema>;

type SiteConfigEnv = {
  NESVO_RELEASE_REPO?: string;
  NESVO_RELEASE_API_ORIGIN?: string;
};

export const readSiteConfig = (env: SiteConfigEnv): SiteConfig =>
  siteConfigSchema.parse({
    releaseRepository: env.NESVO_RELEASE_REPO ?? DEFAULT_RELEASE_REPOSITORY,
    releaseApiOrigin:
      env.NESVO_RELEASE_API_ORIGIN ?? DEFAULT_RELEASE_API_ORIGIN,
  });
