import { decodeServerMessage } from './messages';
import { randomBytes } from './random';
import type {
  ClientCommand,
  HostEvent,
  InboxFeatures,
  InboxMark,
  Pairing,
  PushKind,
  SessionControl,
  SessionGroup,
  SessionLaunchOptions,
} from './types';
import { decodeFrame, encodeFrame, keyBytes, MAX_FRAME_BYTES, parsePairing } from './wire';

export { parsePairing } from './wire';
export type {
  HostEvent,
  Pairing,
  TerminalSession,
  SessionGroup,
  SessionControl,
  HostCapabilities,
  SessionProgram,
  SessionLaunchOptions,
  SessionStatus,
  SessionStatusSource,
  SessionStatusState,
} from './types';

const NO_INBOX_FEATURES: InboxFeatures = {
  attentionInbox: false,
  decisions: false,
  jobPages: false,
};
const INBOX_PUSH_KINDS: PushKind[] = ['decisionPending', 'resultReady'];
const MAX_INBOX_MARKS = 32;

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
  private identity: number | null = null;
  private controls = new Map<string, SessionControl>();
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private features: InboxFeatures = NO_INBOX_FEATURES;

  get clientId(): number | null {
    return this.identity;
  }
  get isConnected(): boolean {
    return this.ready;
  }
  get inboxFeatures(): InboxFeatures {
    return this.features;
  }
  getControl(sessionId: string): SessionControl | undefined {
    return this.controls.get(sessionId);
  }
  hasControl(sessionId: string): boolean {
    const control = this.controls.get(sessionId);
    return this.ready && control?.controllerId === this.identity && !!control?.leaseId;
  }

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
      this.clientNonce = Array.from(randomBytes(32), byte =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      this.incomingSeq = 0;
      this.outgoingSeq = 0;
      this.features = NO_INBOX_FEATURES;
      const socket = new WebSocket(validated.url);
      this.socket = socket;
      this.authTimer = setTimeout(() => {
        if (this.socket !== socket || this.ready) return;
        this.emit({
          type: 'error',
          message: 'Connection timed out. Check that the host is running and reachable.',
        });
        socket.close();
      }, 10000);
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_BYTES)
            throw new Error('Invalid host message.');
          if (!this.challenge) {
            const hello = JSON.parse(event.data);
            if (
              hello.type !== 'challenge' ||
              hello.version !== 1 ||
              typeof hello.challenge !== 'string' ||
              !/^[a-f0-9]{64}$/.test(hello.challenge)
            ) {
              throw new Error('Invalid host handshake.');
            }
            this.challenge = hello.challenge;
            this.send({ type: 'auth', clientNonce: this.clientNonce }, true);
            return;
          }
          const payload = decodeFrame(
            event.data,
            this.key!,
            this.challenge,
            'host-to-client',
            this.incomingSeq + 1,
          );
          if (
            payload &&
            typeof payload === 'object' &&
            'type' in payload &&
            payload.type === 'connected' &&
            (!('protocolVersion' in payload) || payload.protocolVersion !== 2)
          ) {
            this.emit({
              type: 'error',
              message: 'This host needs an update. Run the latest Rust host and reconnect.',
            });
            socket.close();
            return;
          }
          const message = decodeServerMessage(payload);
          this.incomingSeq++;
          if (!message || typeof message !== 'object' || typeof message.type !== 'string')
            throw new Error('Invalid host event.');
          if (!this.ready && message.type !== 'connected')
            throw new Error('Host has not authenticated.');
          if (message.type === 'connected') {
            if (this.ready) throw new Error('Repeated authentication response.');
            // The host must prove it saw this connection's fresh client nonce.
            // A server-chosen challenge alone permits replaying a recorded host.
            if (message.clientNonce !== this.clientNonce)
              throw new Error('Stale host authentication response.');
            if (message.protocolVersion !== 2 || !Number.isSafeInteger(message.clientId)) {
              this.emit({
                type: 'error',
                message: 'This host needs an update. Run the latest Rust host and reconnect.',
              });
              socket.close();
              return;
            }
            this.identity = message.clientId;
            this.ready = true;
            clearTimeout(this.authTimer);
          }
          if (message.type === 'control') {
            if (message.leaseId && message.controllerId !== this.identity)
              throw new Error('Unexpected control lease.');
            this.controls.set(message.sessionId, message);
          }
          if (message.type === 'capabilities') {
            this.features = {
              attentionInbox: message.attentionInbox === true,
              decisions: message.decisions === true,
              jobPages: message.jobPages === true,
            };
          }
          if (message.type === 'sessions') {
            const ids = new Set(message.sessions.map(session => session.id));
            for (const id of this.controls.keys()) if (!ids.has(id)) this.controls.delete(id);
          }
          this.emit(
            message.type === 'connected'
              ? { type: 'connected', clientId: message.clientId, protocolVersion: 2 }
              : message,
          );
          if (message.type === 'connected') this.requestCapabilities();
        } catch {
          this.emit({
            type: 'error',
            message:
              'Could not authenticate the host. Scan the current pairing code and reconnect.',
          });
          socket.close();
        }
      };
      socket.onerror = () => {
        if (this.socket === socket)
          this.emit({
            type: 'error',
            message: 'Connection failed. Check the address, network and host firewall.',
          });
      };
      socket.onclose = event => {
        if (this.socket !== socket) return;
        clearTimeout(this.authTimer);
        this.socket = null;
        this.ready = false;
        this.identity = null;
        this.controls.clear();
        this.features = NO_INBOX_FEATURES;
        this.key = null;
        this.clientNonce = '';
        this.emit({
          type: 'disconnected',
          reason:
            event.reason ||
            (event.code === 4003
              ? 'Pairing authentication failed.'
              : 'Disconnected. Sessions remain on the host.'),
        });
      };
    } catch (error) {
      this.emit({
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not connect.',
      });
    }
  }

  disconnect(): void {
    clearTimeout(this.authTimer);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.identity = null;
    this.controls.clear();
    this.features = NO_INBOX_FEATURES;
    this.key = null;
    this.clientNonce = '';
    if (socket) {
      socket.close();
      this.emit({ type: 'disconnected', reason: 'Disconnected. Sessions remain on the host.' });
    }
  }

  private send(payload: ClientCommand, handshake = false): void {
    const requestId = 'requestId' in payload ? payload.requestId : undefined;
    if (
      !this.socket ||
      this.socket.readyState !== 1 ||
      !this.key ||
      !this.challenge ||
      (!handshake && !this.ready)
    ) {
      this.emit({ type: 'error', message: 'Connect to a host first.', requestId });
      return;
    }
    if (this.socket.bufferedAmount > 256 * 1024) {
      this.emit({
        type: 'error',
        message: 'Connection is too slow. Input was not sent; reconnect before continuing.',
      });
      this.disconnect();
      return;
    }
    try {
      const frame = encodeFrame(
        payload,
        this.key,
        this.challenge,
        'client-to-host',
        this.outgoingSeq + 1,
        randomBytes,
      );
      this.socket.send(frame);
      this.outgoingSeq++;
    } catch (error) {
      this.emit({
        type: 'error',
        message: error instanceof Error ? error.message : 'Message could not be sent.',
        requestId,
      });
    }
  }

  registerPush(token: string, enabled: boolean, requestId: string) {
    this.send(
      enabled && this.features.decisions
        ? { type: 'registerPush', token, enabled, requestId, kinds: INBOX_PUSH_KINDS }
        : { type: 'registerPush', token, enabled, requestId },
    );
  }
  requestAttentionInbox(page: number, limit?: number, requestId = this.requestId()) {
    if (!this.ready || !this.features.attentionInbox) return null;
    this.send({ type: 'attentionInbox', page, limit, requestId });
    return requestId;
  }
  acknowledgeInbox(items: InboxMark[], requestId = this.requestId()) {
    if (!this.ready || !this.features.attentionInbox) return null;
    if (items.length === 0 || items.length > MAX_INBOX_MARKS) return null;
    this.send({ type: 'acknowledgeInbox', items, requestId });
    return requestId;
  }
  requestDecisions(page: number, requestId = this.requestId()) {
    if (!this.ready || !this.features.decisions) return null;
    this.send({ type: 'decisions', page, requestId });
    return requestId;
  }
  decide(decisionId: string, choice: string, note?: string, requestId = this.requestId()) {
    if (!this.ready || !this.features.decisions) return null;
    this.send({ type: 'decide', decisionId, choice, note: note || undefined, requestId });
    return requestId;
  }
  acknowledgeAttention(sessionId: string, sequence: number) {
    this.send({ type: 'acknowledgeAttention', sessionId, sequence });
  }
  muteSession(sessionId: string, muted: boolean) {
    this.send({ type: 'muteSession', sessionId, muted });
  }
  listSessions(): void {
    this.send({ type: 'list' });
  }
  requestCapabilities(): void {
    this.send({ type: 'getCapabilities', sessionFreshness: true });
  }
  createSession(
    name: string,
    groupId: string | null = null,
    requestId = this.requestId(),
    options: SessionLaunchOptions = {},
  ): string {
    this.send({
      type: 'create',
      name,
      groupId,
      requestId,
      cwd: options.cwd,
      program: options.program,
    });
    return requestId;
  }
  requestId(): string {
    return Array.from(randomBytes(16), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  createGroup(name: string, parentId: string | null, expectedRevision: number): void {
    this.send({ type: 'createGroup', name, parentId, expectedRevision });
  }
  updateGroup(group: SessionGroup, expectedRevision: number): void {
    this.send({
      type: 'updateGroup',
      groupId: group.id,
      name: group.name,
      parentId: group.parentId,
      order: group.order,
      expectedRevision,
    });
  }
  deleteGroup(groupId: string, expectedRevision: number): void {
    this.send({ type: 'deleteGroup', groupId, expectedRevision });
  }
  moveSession(sessionId: string, groupId: string | null, expectedRevision: number): void {
    this.send({ type: 'moveSession', sessionId, groupId, expectedRevision });
  }
  subscribeSession(sessionId: string): void {
    this.send({ type: 'subscribe', sessionId });
  }
  unsubscribeSession(sessionId: string): void {
    if (!this.ready) return;
    this.releaseControl(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }
  acquireControl(sessionId: string, cols: number, rows: number, takeOver = false): void {
    this.send({ type: 'acquireControl', sessionId, ...this.dimensions(cols, rows), takeOver });
  }
  releaseControl(sessionId: string): void {
    const leaseId = this.controls.get(sessionId)?.leaseId;
    if (!leaseId || !this.hasControl(sessionId)) return;
    // Clear locally before writing so stale renderer callbacks cannot send input.
    this.controls.delete(sessionId);
    this.send({ type: 'releaseControl', sessionId, leaseId });
  }
  attachSession(sessionId: string, cols = 80, rows = 24): void {
    this.send({ type: 'attach', sessionId, cols, rows });
  }
  sendInput(sessionId: string, data: string): void {
    const control = this.controls.get(sessionId);
    if (!this.ready || control?.controllerId !== this.identity || !control?.leaseId) return;
    this.send({ type: 'input', sessionId, data, leaseId: control.leaseId });
  }
  resizeSession(sessionId: string, cols: number, rows: number): void {
    const control = this.controls.get(sessionId);
    if (!this.ready || control?.controllerId !== this.identity || !control?.leaseId) return;
    this.send({
      type: 'resize',
      sessionId,
      ...this.dimensions(cols, rows),
      leaseId: control.leaseId,
    });
  }
  private dimensions(cols: number, rows: number) {
    return {
      cols: Math.max(10, Math.min(300, Math.floor(cols))),
      rows: Math.max(2, Math.min(150, Math.floor(rows))),
    };
  }
  closeSession(sessionId: string): void {
    this.send({ type: 'close', sessionId });
  }
}
