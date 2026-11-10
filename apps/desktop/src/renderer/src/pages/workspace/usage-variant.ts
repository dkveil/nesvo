export type UsageVariant = 'a' | 'b';

export function readUsageVariant(): UsageVariant {
  try {
    return localStorage.getItem('nesvo.usage-variant.proposal') === 'b'
      ? 'b'
      : 'a';
  } catch {
    return 'a';
  }
}
