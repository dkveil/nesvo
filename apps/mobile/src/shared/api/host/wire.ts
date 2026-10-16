import { Buffer } from 'buffer';
import nacl from 'tweetnacl';

import type { Pairing } from './types';

export const MAX_FRAME_BYTES = 128 * 1024;
export const MAX_PLAINTEXT_BYTES = 64 * 1024;
type Direction = 'client-to-host' | 'host-to-client';
type Envelope = { challenge: string; direction: Direction; seq: number; payload: unknown };

export function parsePairing(value: string): Pairing {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid pairing code.');
  const pairing = parsed as Pairing;
  if (
    pairing.version !== 1 ||
    typeof pairing.url !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(pairing.key)
  ) {
    throw new Error('This pairing code is invalid or uses an unsupported version.');
  }
  const url = new URL(pairing.url);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(
      'Pairing requires a ws:// or wss:// host address without credentials or query parameters.',
    );
  }
  return { version: 1, url: pairing.url, key: pairing.key.toLowerCase() };
}

export function keyBytes(key: string): Uint8Array {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Invalid pairing key.');
  return new Uint8Array(Buffer.from(key, 'hex'));
}

export function encodeFrame(
  payload: unknown,
  key: Uint8Array,
  challenge: string,
  direction: Direction,
  seq: number,
  randomBytes: (length: number) => Uint8Array,
): string {
  const message = Buffer.from(JSON.stringify({ challenge, direction, seq, payload }), 'utf8');
  if (message.length > MAX_PLAINTEXT_BYTES) throw new Error('Message is too large.');
  const nonce = randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(new Uint8Array(message), nonce, key);
  return JSON.stringify({
    nonce: Buffer.from(nonce).toString('base64'),
    box: Buffer.from(box).toString('base64'),
  });
}

export function decodeFrame(
  data: string,
  key: Uint8Array,
  challenge: string,
  direction: Direction,
  expectedSeq: number,
): unknown {
  if (data.length > MAX_FRAME_BYTES) throw new Error('Frame is too large.');
  const frame = JSON.parse(data) as { nonce?: unknown; box?: unknown };
  if (
    typeof frame.nonce !== 'string' ||
    typeof frame.box !== 'string' ||
    frame.nonce.length !== 32 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.box)
  ) {
    throw new Error('Invalid encrypted frame.');
  }
  const nonce = new Uint8Array(Buffer.from(frame.nonce, 'base64'));
  const box = new Uint8Array(Buffer.from(frame.box, 'base64'));
  if (
    nonce.length !== nacl.secretbox.nonceLength ||
    box.length > MAX_PLAINTEXT_BYTES + nacl.secretbox.overheadLength
  ) {
    throw new Error('Invalid encrypted frame size.');
  }
  const opened = nacl.secretbox.open(box, nonce, key);
  if (!opened) throw new Error('Authentication failed.');
  const envelope = JSON.parse(Buffer.from(opened).toString('utf8')) as Envelope;
  if (
    envelope.challenge !== challenge ||
    envelope.direction !== direction ||
    !Number.isSafeInteger(envelope.seq) ||
    envelope.seq !== expectedSeq
  ) {
    throw new Error('Invalid connection context or replayed frame.');
  }
  return envelope.payload;
}
