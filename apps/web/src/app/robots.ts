import type { MetadataRoute } from 'next';

export const robots = (): MetadataRoute.Robots => ({
  rules: { userAgent: '*', disallow: '/' },
});

export default robots;
