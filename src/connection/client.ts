import { decodeFrame, encodeFrame, keyBytes, MAX_FRAME_BYTES, parsePairing } from './wire';
import { randomBytes } from './random';
import type { ClientCommand, HostEvent, Pairing, ServerMessage } from './types';

export { parsePairing } from './wire';
export type { HostEvent, Pairing, TerminalSession } from './types';

/** Sessions live on the host. Reconnect is explicit: input is never queued or replayed. */
export class HostClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<(event: HostEvent) => void>();
  private key: Uint8Array | null = null;
  private challenge = '';
  private clientNonce = '';
  private incomingSeq = 0;
  private outgoingSeq = 0;
  private ready = false;
  private authTimer: ReturnType<typeof setTimeout> | undefined;

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  connect(pairing: Pairing): void {
    this.disconnect();
    try {
      const validated = parsePairing(JSON.stringify(pairing));
      this.key = keyBytes(validated.key);
      this.challenge = '';
      this.clientNonce = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('');
      this.incomingSeq = 0;
      this.outgoingSeq = 0;
      const socket = new WebSocket(validated.url);
      this.socket = socket;
      this.authTimer = setTimeout(() => {
        if (this.socket !== socket || this.ready) return;
        this.emit({ type: 'error', message: 'Connection timed out. Check that the host is running and reachable.' });
        socket.close();
      }, 10000);
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_BYTES) throw new Error('Invalid host message.');
          if (!this.challenge) {
            const hello = JSON.parse(event.data);
            if (hello.type !== 'challenge' || hello.version !== 1 || typeof hello.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(hello.challenge)) {
              throw new Error('Invalid host handshake.');
            }
            this.challenge = hello.challenge;
            this.send({ type: 'auth', clientNonce: this.clientNonce }, true);
            return;
          }
          const message = decodeFrame(event.data, this.key!, this.challenge, 'host-to-client', this.incomingSeq + 1) as ServerMessage;
          this.incomingSeq++;
          if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('Invalid host event.');
          if (!this.ready && message.type !== 'connected') throw new Error('Host has not authenticated.');
          if (message.type === 'connected') {
            if (this.ready) throw new Error('Repeated authentication response.');
            // The host must prove it saw this connection's fresh client nonce.
            // A server-chosen challenge alone permits replaying a recorded host.
            if (message.clientNonce !== this.clientNonce) throw new Error('Stale host authentication response.');
            this.ready = true;
            clearTimeout(this.authTimer);
          }
          this.emit(message.type === 'connected' ? { type: 'connected' } : message);
        } catch {
          this.emit({ type: 'error', message: 'Could not authenticate the host. Scan the current pairing code and reconnect.' });
          socket.close();
        }
      };
      socket.onerror = () => {
        if (this.socket === socket) this.emit({ type: 'error', message: 'Connection failed. Check the address, network and host firewall.' });
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        clearTimeout(this.authTimer);
        this.socket = null;
        this.ready = false;
        this.key = null;
        this.clientNonce = '';
        this.emit({ type: 'disconnected', reason: event.reason || (event.code === 4003 ? 'Pairing authentication failed.' : 'Disconnected. Sessions remain on the host.') });
      };
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : 'Could not connect.' });
    }
  }

  disconnect(): void {
    clearTimeout(this.authTimer);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.key = null;
    this.clientNonce = '';
    if (socket) {
      socket.close();
      this.emit({ type: 'disconnected', reason: 'Disconnected. Sessions remain on the host.' });
    }
  }

  private send(payload: ClientCommand, handshake = false): void {
    if (!this.socket || this.socket.readyState !== 1 || !this.key || !this.challenge || (!handshake && !this.ready)) {
      this.emit({ type: 'error', message: 'Connect to a host first.' });
      return;
    }
    if (this.socket.bufferedAmount > 256 * 1024) {
      this.emit({ type: 'error', message: 'Connection is too slow. Input was not sent; reconnect before continuing.' });
      this.disconnect();
      return;
    }
    try {
      const frame = encodeFrame(payload, this.key, this.challenge, 'client-to-host', this.outgoingSeq + 1, randomBytes);
      this.socket.send(frame);
      this.outgoingSeq++;
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : 'Message could not be sent.' });
    }
  }

  listSessions(): void { this.send({ type: 'list' }); }
  createSession(name: string): void { this.send({ type: 'create', name }); }
  attachSession(sessionId: string, cols = 80, rows = 24): void { this.send({ type: 'attach', sessionId, cols, rows }); }
  sendInput(sessionId: string, data: string): void { this.send({ type: 'input', sessionId, data }); }
  resizeSession(sessionId: string, cols: number, rows: number): void { this.send({ type: 'resize', sessionId, cols, rows }); }
  closeSession(sessionId: string): void { this.send({ type: 'close', sessionId }); }
}
