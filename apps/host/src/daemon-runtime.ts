import { randomUUID } from 'node:crypto';
import {
  type HostMessage,
  type HostRequest,
  type HostResponse,
} from '@nesvo/contracts';
import { runHost } from './host';

class RequestQueue implements AsyncIterable<HostRequest> {
  private items: HostRequest[] = [];
  private waiting: ((item: IteratorResult<HostRequest>) => void) | undefined;
  private closed = false;

  push(request: HostRequest) {
    if (this.closed) return false;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting({ done: false, value: request });
    } else this.items.push(request);
    return true;
  }

  close() {
    this.closed = true;
    this.items = [];
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<HostRequest> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ done: false, value: item });
        if (this.closed)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => {
          this.waiting = resolve;
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

export class DaemonRuntime {
  readonly done: Promise<void>;
  private readonly queue = new RequestQueue();
  private readonly pending = new Map<
    string,
    { id: string; reply?: (response: HostResponse) => void }
  >();

  constructor(directory: string, publish: (event: HostMessage) => void) {
    this.done = runHost({
      directory,
      incoming: this.queue,
      send: async message => {
        if ('id' in message) {
          if (!message.id) return;
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          pending?.reply?.({ ...message, id: pending.id });
        } else publish(message);
      },
    }).finally(() => {
      this.queue.close();
      this.pending.clear();
    });
  }

  submit(request: HostRequest, reply: (response: HostResponse) => void) {
    if (this.pending.size >= 128) return undefined;
    const id = randomUUID();
    const pending = {
      id: request.id,
      reply: reply as typeof reply | undefined,
    };
    this.pending.set(id, pending);
    if (!this.queue.push({ ...request, id })) {
      this.pending.delete(id);
      return undefined;
    }
    return () => {
      pending.reply = undefined;
    };
  }

  async health() {
    const response = new Promise<HostResponse>((resolve, reject) => {
      if (!this.submit({ id: randomUUID(), method: 'health' }, resolve))
        reject(new Error('The host is not accepting requests.'));
    });
    const result = await Promise.race([
      response,
      this.done.then(() => {
        throw new Error('The host stopped before becoming ready.');
      }),
    ]);
    if (result.type !== 'health') throw new Error('The host is not ready.');
    return result.health;
  }

  async stop() {
    this.queue.close();
    await this.done;
  }
}
