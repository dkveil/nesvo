export function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues)
    throw new Error('Secure randomness is unavailable. Open the web app on localhost or HTTPS.');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
