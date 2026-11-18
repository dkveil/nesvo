import { isIP } from 'node:net';
import { endianness } from 'node:os';

export type ListeningSocket = { address: string; port: number; pid: number };
export type KernelSocket = Omit<ListeningSocket, 'pid'> & { inode: string };

export function parseSocketAddress(
  value: string,
): { address: string; port: number } | null {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const address = value
    .slice(0, separator)
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  return {
    address: address.toLowerCase().replace(/^::ffff:(?=127\.)/, ''),
    port,
  };
}

export function loopbackHost(address: string): string | null {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '::1';
  if (address === '::1') return address;
  if (address.startsWith('127.') && isIP(address) === 4) return address;
  return null;
}

export function parseNetstat(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of output.split('\n')) {
    const [protocol, local, remote, state, owner] = line.trim().split(/\s+/);
    if (protocol !== 'TCP' || !local || !state || !owner) continue;
    if (remote !== '0.0.0.0:0' && remote !== '[::]:0') continue;
    const endpoint = parseSocketAddress(local);
    const pid = Number(owner);
    if (
      !endpoint ||
      !loopbackHost(endpoint.address) ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    )
      continue;
    sockets.push({ ...endpoint, pid });
  }
  return sockets;
}

export function parseTasklist(output: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (match?.[1]) names.set(Number(match[2]), match[1]);
  }
  return names;
}

function decodeAddress(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  if (endianness() === 'LE')
    for (let offset = 0; offset < bytes.length; offset += 4)
      bytes.writeUInt32BE(bytes.readUInt32LE(offset), offset);
  if (bytes.length === 4) return Array.from(bytes).join('.');
  if (bytes.subarray(0, 15).every(byte => byte === 0))
    return bytes[15] === 0 ? '::' : bytes[15] === 1 ? '::1' : '';
  if (
    bytes.subarray(0, 10).every(byte => byte === 0) &&
    bytes.readUInt16BE(10) === 0xffff
  )
    return Array.from(bytes.subarray(12)).join('.');
  return '';
}

export function parseProcTcp(output: string): KernelSocket[] {
  const sockets: KernelSocket[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || !fields[9] || !/^[1-9]\d*$/.test(fields[9]))
      continue;
    const endpoint = /^([0-9a-f]{8}|[0-9a-f]{32}):([0-9a-f]{4})$/i.exec(
      fields[1] ?? '',
    );
    if (!endpoint) continue;
    const address = decodeAddress(endpoint[1]!);
    const port = Number.parseInt(endpoint[2]!, 16);
    if (port && loopbackHost(address))
      sockets.push({ address, port, inode: fields[9] });
  }
  return sockets;
}
