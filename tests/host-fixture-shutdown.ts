import type { ChildProcess } from 'node:child_process';

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/** Stop only the host spawned by this fixture; let it close its own PTYs. */
export async function stopFixtureHost(host: ChildProcess): Promise<void> {
  if (host.pid === undefined) return;
  if (host.exitCode !== null || host.signalCode !== null) {
    assertCleanExit(host);
    return;
  }
  if (!host.stdin) throw new Error('Fixture host must have piped stdin');
  // A host that exits between the status check and end() can close the pipe first.
  host.stdin.once('error', () => undefined);
  const exited = waitForExit(host, 10_000);
  host.stdin.end();
  if (await exited) {
    assertCleanExit(host);
    return;
  }
  host.kill();
  await waitForExit(host, 3_000);
  throw new Error('Fixture host did not finish PTY cleanup after stdin closed');
}

function assertCleanExit(host: ChildProcess): void {
  if (host.exitCode !== 0 || host.signalCode !== null)
    throw new Error(
      `Fixture host exited before terminal cleanup completed (code ${host.exitCode}, signal ${host.signalCode})`,
    );
}
