const SHARE_ID_BYTES = 24;
const REVOKE_TOKEN_BYTES = 32;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

export const createShareId = (): string =>
  toBase64Url(randomBytes(SHARE_ID_BYTES));

export const createRevokeToken = (): string =>
  toBase64Url(randomBytes(REVOKE_TOKEN_BYTES));

export const hashSecret = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

export const isSameHash = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};
