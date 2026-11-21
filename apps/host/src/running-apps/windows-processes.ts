const MAX_ANCESTRY_DEPTH = 32;

export type WindowsProcess = {
  pid: number;
  parent: number;
  name: string;
  startedAt: number | null;
};

export const WINDOWS_PROCESS_SNAPSHOT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$processes = @(
  Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate |
    ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId
        parent = [int]$_.ParentProcessId
        name = [string]$_.Name
        startedAt = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }
      }
    }
)
ConvertTo-Json -InputObject $processes -Compress
`;

export function selectListenerAncestry(
  processes: readonly WindowsProcess[],
  listeners: readonly number[],
): WindowsProcess[] {
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  const visited = new Set<number>();
  const owners: WindowsProcess[] = [];
  for (const listener of listeners) {
    let pid = listener;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && pid !== 0; depth++) {
      const entry = byPid.get(pid);
      if (!entry) break;
      if (!visited.has(pid)) {
        visited.add(pid);
        owners.push(entry);
      }
      pid = entry.parent;
    }
  }
  return owners;
}
