import type { RunningAppList } from '@nesvo/contracts';
import { providerProcess } from '../process/provider-processes';
import { attributeRunningApps, type SessionFolder } from './attribute';
import { scanRunningApps } from './scan';

const CACHE_MS = 3_000;

export class RunningApps {
  private cached: { at: number; list: RunningAppList } | null = null;
  private scanning: Promise<RunningAppList> | null = null;

  read(
    sessions: () => readonly SessionFolder[],
    signal: AbortSignal,
  ): Promise<RunningAppList> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS)
      return Promise.resolve(this.cached.list);
    this.scanning ??= scanRunningApps(signal)
      .then(scan => {
        const list: RunningAppList = {
          apps: attributeRunningApps({
            ...scan,
            sessions: sessions(),
            providerProcess,
            caseInsensitivePaths:
              process.platform === 'win32' || process.platform === 'darwin',
          }),
          observedAt: new Date().toISOString(),
        };
        this.cached = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }
}
