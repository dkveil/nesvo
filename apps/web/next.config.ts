import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import type { NextConfig } from 'next';

import { buildSiteHeaders } from './src/server/security-headers';

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@nesvo/contracts'],
  headers: async () => [
    {
      source: '/:path*',
      headers: buildSiteHeaders(process.env.NODE_ENV === 'production'),
    },
  ],
};

if (process.env.NODE_ENV === 'development') {
  void initOpenNextCloudflareForDev();
}

export default nextConfig;
