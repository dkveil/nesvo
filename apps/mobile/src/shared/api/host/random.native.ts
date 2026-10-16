import { getRandomValues } from 'expo-crypto';

export function randomBytes(length: number): Uint8Array {
  // getRandomBytes may fall back to Math.random in development/debug sessions.
  // This API requires native cryptographic randomness and fails if unavailable.
  return getRandomValues(new Uint8Array(length));
}
