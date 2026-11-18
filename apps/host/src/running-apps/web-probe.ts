import { get } from 'node:http';
import type { RunningApp } from '@nesvo/contracts';
import { loopbackHost, type ListeningSocket } from './listeners';
import type { ScanResult } from './scan';

const TIMEOUT_MS = 750;
const WEB_TTL_MS = 30_000;
const OTHER_TTL_MS = 10_000;
const CONCURRENCY = 24;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function probeWebPort(
  address: string,
  port: number,
  signal: AbortSignal,
): Promise<boolean> {
  const hostname = loopbackHost(address);
  if (!hostname || signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = get(
      {
        hostname,
        port,
        path: '/',
        agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers: {
          Host: 'localhost:' + port,
          Accept: 'text/html, application/xhtml+xml',
        },
      },
      response => {
        const status = response.statusCode ?? 0;
        const mediaType = response.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        const html =
          mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
        const location = response.headers.location?.trim();
        const redirect =
          REDIRECTS.has(status) && location
            ? URL.parse(location, 'http://localhost:' + port)
            : null;
        resolve(
          (status >= 200 && status < 300 && html) ||
            redirect?.protocol === 'http:' ||
            redirect?.protocol === 'https:',
        );
        response.destroy();
      },
    );
    request.once('error', () => resolve(false));
  });
}

function probeTargets(sockets: ListeningSocket[], app: RunningApp): string[] {
  const addresses = new Set([
    app.address,
    ...sockets
      .filter(socket => socket.pid === app.pid)
      .map(socket => socket.address),
  ]);
  return [...addresses].filter(address => {
    const host = loopbackHost(address);
    return (
      host &&
      !sockets.some(
        socket =>
          socket.pid !== app.pid &&
          (socket.address === host || socket.address === address),
      )
    );
  });
}

export class WebProbes {
  private readonly cache = new Map<string, { web: boolean; until: number }>();

  async classify(
    apps: RunningApp[],
    scan: ScanResult,
    signal: AbortSignal,
  ): Promise<RunningApp[]> {
    const sockets = new Map<number, ListeningSocket[]>();
    for (const socket of scan.sockets) {
      const group = sockets.get(socket.port);
      if (group) group.push(socket);
      else sockets.set(socket.port, [socket]);
    }
    const next = new Map<string, { web: boolean; until: number }>();
    const classified: RunningApp[] = [];
    for (let start = 0; start < apps.length; start += CONCURRENCY) {
      signal.throwIfAborted();
      const batch = await Promise.all(
        apps.slice(start, start + CONCURRENCY).map(async app => {
          const startedAt = scan.processes.get(app.pid)?.startedAt;
          for (const address of probeTargets(
            sockets.get(app.port) ?? [],
            app,
          )) {
            const key = JSON.stringify([
              app.sessionId,
              app.pid,
              startedAt,
              address,
              app.port,
            ]);
            const cached = this.cache.get(key);
            const web =
              cached && cached.until > Date.now()
                ? cached.web
                : await probeWebPort(address, app.port, signal);
            if (startedAt != null)
              next.set(
                key,
                cached && cached.until > Date.now()
                  ? cached
                  : {
                      web,
                      until: Date.now() + (web ? WEB_TTL_MS : OTHER_TTL_MS),
                    },
              );
            if (web) return { ...app, address, web: true };
          }
          return { ...app, web: false };
        }),
      );
      classified.push(...batch);
    }
    for (const [key, value] of this.cache)
      if (value.until > Date.now() && next.size < 1024 && !next.has(key))
        next.set(key, value);
    this.cache.clear();
    for (const [key, value] of next) this.cache.set(key, value);
    return classified;
  }
}
