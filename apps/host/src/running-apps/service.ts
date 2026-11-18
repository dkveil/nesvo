import type {
  RunningApp,
  RunningAppList,
  RunningAppQuery,
} from '@nesvo/contracts';
import { providerProcess } from '../process/provider-processes';
import { attributeRunningApps, type SessionFolder } from './attribute';
import { RunningAppsError, scanRunningApps, type ScanResult } from './scan';
import { WebProbes } from './web-probe';

const CACHE_MS = 5_000;

type Snapshot = { scan: ScanResult; at: number };

export class RunningApps {
  private cached: Snapshot | null = null;
  private scanning: Promise<Snapshot> | null = null;
  private readonly probes = new WebProbes();
  private classification = Promise.resolve<unknown>(undefined);
  private readonly pending = new Map<string, Promise<RunningApp[]>>();

  async read(
    sessions: () => readonly SessionFolder[],
    signal: AbortSignal,
    query?: RunningAppQuery,
  ): Promise<RunningAppList> {
    const folders = sessions();
    const sessionId = query?.sessionId;
    if (
      !folders.length ||
      (sessionId && !folders.some(session => session.id === sessionId))
    )
      return { apps: [], observedAt: new Date().toISOString() };
    const { scan, at } = await this.snapshot(signal);
    const apps = attributeRunningApps({
      ...scan,
      sessions: folders,
      sessionId,
      providerProcess,
      caseInsensitivePaths:
        process.platform === 'win32' || process.platform === 'darwin',
    });
    return {
      apps:
        query && apps.length
          ? await this.classify(apps, scan, at, signal)
          : apps,
      observedAt: new Date(at).toISOString(),
    };
  }

  private snapshot(signal: AbortSignal): Promise<Snapshot> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS)
      return Promise.resolve(this.cached);
    this.scanning ??= scanRunningApps(signal)
      .then(scan => {
        this.cached = { at: Date.now(), scan };
        return this.cached;
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  private classify(
    apps: RunningApp[],
    scan: ScanResult,
    at: number,
    signal: AbortSignal,
  ) {
    const key = JSON.stringify([at, apps]);
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 8)
        throw new RunningAppsError(
          'busy',
          'Running apps are busy. Try again shortly.',
        );
      pending = this.classification
        .catch(() => undefined)
        .then(() => this.probes.classify(apps, scan, signal))
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
      this.classification = pending;
    }
    return pending;
  }
}
