const MAX_ANCESTRY_DEPTH = 32;

export type WindowsProcess = {
  pid: number;
  parent: number;
  name: string;
  startedAt: number | null;
};

export const WINDOWS_PROCESS_SNAPSHOT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$searcher = [wmisearcher]'SELECT ProcessId, ParentProcessId, Name, CreationDate FROM Win32_Process'
$builder = [Text.StringBuilder]::new()
[void]$builder.Append('[')
$first = $true
foreach ($item in $searcher.Get()) {
  if (-not $first) { [void]$builder.Append(',') }
  $first = $false
  $started = 'null'
  if ($item['CreationDate']) {
    try {
      $started = ([DateTimeOffset][Management.ManagementDateTimeConverter]::ToDateTime($item['CreationDate'])).ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)
    } catch {
      $started = 'null'
    }
  }
  $name = [regex]::Replace(([string]$item['Name']).Replace('\', '\\').Replace('"', '\"'), '[\x00-\x1f]', '')
  [void]$builder.Append('{"pid":' + [int]$item['ProcessId'] + ',"parent":' + [int]$item['ParentProcessId'] + ',"name":"' + $name + '","startedAt":' + $started + '}')
}
[void]$builder.Append(']')
[Console]::Out.Write($builder.ToString())
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
