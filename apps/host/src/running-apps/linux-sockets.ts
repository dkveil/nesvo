import { opendirSync, readdirSync, readlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseProcTcp, type ListeningSocket } from './listeners';

const PROC_DIRECTORY = '/proc';
const MAX_PIDS_PER_SCAN = 1024;
const MAX_FDS_PER_SCAN = 16_384;
const MAX_FDS_PER_PID = 1024;
const MAX_MISSED_SCANS = 3;

type Descriptor = { pid: number; path: string };
type SocketOwner = { descriptor: Descriptor } | { misses: number };

function descriptorInode(path: string): string | undefined {
  try {
    return /^socket:\[(\d+)\]$/.exec(readlinkSync(path))?.[1];
  } catch {
    return undefined;
  }
}

export class LinuxSockets {
  private readonly owners = new Map<string, SocketOwner>();
  private nextPid = 0;

  constructor(private readonly root = PROC_DIRECTORY) {}

  async read(signal: AbortSignal): Promise<ListeningSocket[]> {
    const options = { encoding: 'utf8', signal } as const;
    const [tcp, tcp6] = await Promise.all([
      readFile(this.root + '/net/tcp', options),
      readFile(this.root + '/net/tcp6', options).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      }),
    ]);
    const sockets = [...parseProcTcp(tcp), ...parseProcTcp(tcp6)];
    const inodes = new Set(sockets.map(socket => socket.inode));
    for (const inode of this.owners.keys())
      if (!inodes.has(inode)) this.owners.delete(inode);
    const needed = new Set<string>();
    for (const inode of inodes) {
      const cached = this.owners.get(inode);
      if (
        cached &&
        'descriptor' in cached &&
        descriptorInode(cached.descriptor.path) === inode
      )
        continue;
      if (cached && 'misses' in cached && cached.misses > 0) {
        cached.misses--;
        continue;
      }
      this.owners.delete(inode);
      needed.add(inode);
    }
    if (needed.size > 0) this.findOwners(needed);
    return sockets.map(({ inode, ...socket }) => {
      const owner = this.owners.get(inode);
      return {
        ...socket,
        pid: owner && 'descriptor' in owner ? owner.descriptor.pid : 0,
      };
    });
  }

  private findOwners(needed: Set<string>) {
    const pids = readdirSync(this.root)
      .filter(name => /^[1-9]\d*$/.test(name))
      .map(Number)
      .sort((left, right) => left - right);
    const start = Math.max(
      0,
      pids.findIndex(pid => pid >= this.nextPid),
    );
    let budget = MAX_FDS_PER_SCAN;
    let index = 0;
    for (
      ;
      index < Math.min(pids.length, MAX_PIDS_PER_SCAN) &&
      budget > 0 &&
      needed.size > 0;
      index++
    ) {
      const pid = pids[(start + index) % pids.length]!;
      budget -= this.findInProcess(
        pid,
        needed,
        Math.min(budget, MAX_FDS_PER_PID),
      );
    }
    this.nextPid = pids[(start + index) % pids.length] ?? 0;
    if (index === pids.length)
      for (const inode of needed)
        this.owners.set(inode, { misses: MAX_MISSED_SCANS });
  }

  private findInProcess(
    pid: number,
    needed: Set<string>,
    limit: number,
  ): number {
    const path = this.root + '/' + pid + '/fd';
    let visited = 0;
    try {
      const directory = opendirSync(path);
      try {
        while (visited < limit && needed.size > 0) {
          const entry = directory.readSync();
          if (!entry) break;
          visited++;
          const fd = path + '/' + entry.name;
          const inode = descriptorInode(fd);
          if (inode && needed.delete(inode))
            this.owners.set(inode, { descriptor: { pid, path: fd } });
        }
      } finally {
        directory.closeSync();
      }
    } catch {
      return visited;
    }
    return visited;
  }
}
