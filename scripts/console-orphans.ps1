[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Snapshot')][string]$Snapshot,
    [Parameter(Mandatory = $true, ParameterSetName = 'Check')][string]$Check,
    [Parameter(ParameterSetName = 'Check')][string]$TestBinaryRoot,
    [Parameter(ParameterSetName = 'Check')][ValidateRange(0, 600)][int]$ReleaseSeconds = 5
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$consoleHostFilter = "Name = 'conhost.exe' OR Name = 'OpenConsole.exe'"
$pollIntervalMilliseconds = 250

function ConvertTo-UtcStamp([datetime]$time) {
    return $time.ToUniversalTime().ToString('o')
}

function Get-IdentityKey([int]$id, [string]$startTime) {
    return "$id|$startTime"
}

function Get-ConsoleHostRecords {
    return @(Get-CimInstance -ClassName Win32_Process -Filter $consoleHostFilter | ForEach-Object {
            [pscustomobject]@{
                Id          = [int]$_.ProcessId
                ParentId    = [int]$_.ParentProcessId
                StartTime   = ConvertTo-UtcStamp $_.CreationDate
                CreatedAt   = $_.CreationDate.ToUniversalTime()
                CommandLine = [string]$_.CommandLine
                CpuSeconds  = (([double]$_.KernelModeTime + [double]$_.UserModeTime) / 1e7).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
            }
        })
}

function Get-ProcessIndex {
    $index = @{}
    foreach ($process in Get-CimInstance -ClassName Win32_Process) {
        $index[[int]$process.ProcessId] = $process
    }
    return $index
}

function Write-StepSummary([string[]]$lines) {
    if (-not $env:GITHUB_STEP_SUMMARY) { return }
    $text = ($lines -join "`n") + "`n"
    [System.IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, $text, (New-Object System.Text.UTF8Encoding $false))
}

function Resolve-TestBinaryRoot {
    if ($TestBinaryRoot) { return [System.IO.Path]::GetFullPath($TestBinaryRoot) }
    if ($env:CARGO_TARGET_DIR) { return [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path 'target'))
}

function Test-UnderRoot([string]$path, [string]$root) {
    if (-not $path) { return $false }
    $prefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    return [System.IO.Path]::GetFullPath($path).StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-OwnerKind($consoleHost, $processIndex, [string]$testRoot) {
    $parent = $processIndex[$consoleHost.ParentId]
    if ($null -eq $parent -or $null -eq $parent.CreationDate -or $parent.CreationDate.ToUniversalTime() -gt $consoleHost.CreatedAt) { return 'Gone' }
    if (Test-UnderRoot ([string]$parent.ExecutablePath) $testRoot) { return 'TestBinary' }
    return 'LiveProcess'
}

function Get-NewConsoleHosts($snapshotKeys, [string]$testRoot) {
    $processIndex = Get-ProcessIndex
    return @(Get-ConsoleHostRecords | Where-Object { -not $snapshotKeys.ContainsKey((Get-IdentityKey $_.Id $_.StartTime)) } | ForEach-Object {
            $_ | Add-Member -NotePropertyName Owner -NotePropertyValue (Get-OwnerKind $_ $processIndex $testRoot) -PassThru
        })
}

function Test-ProcessRunning([int]$id, [datetime]$createdAt) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $id"
    return ($null -ne $process -and $null -ne $process.CreationDate -and $process.CreationDate.ToUniversalTime() -le $createdAt)
}

function Wait-TestBinaryOwners($consoleHosts) {
    $waited = @{}
    foreach ($consoleHost in $consoleHosts) {
        if ($waited.ContainsKey($consoleHost.ParentId)) { continue }
        $waited[$consoleHost.ParentId] = $true
        Write-Host "Waiting for test binary $($consoleHost.ParentId) that owns console host $($consoleHost.Id) to exit"
        while (Test-ProcessRunning $consoleHost.ParentId $consoleHost.CreatedAt) {
            Start-Sleep -Milliseconds $pollIntervalMilliseconds
        }
    }
    return $waited.Count
}

function Read-SnapshotKeys([string]$path) {
    $document = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $keys = @{}
    foreach ($record in @($document.consoleHosts)) {
        $keys[(Get-IdentityKey $record.id $record.startTime)] = $true
    }
    return $keys
}

function Invoke-Snapshot([string]$path) {
    $records = @(Get-ConsoleHostRecords | ForEach-Object {
            [ordered]@{ id = $_.Id; parentId = $_.ParentId; startTime = $_.StartTime }
        })
    $document = [ordered]@{ takenAt = ConvertTo-UtcStamp (Get-Date); consoleHosts = $records }
    $directory = Split-Path -Parent ([System.IO.Path]::GetFullPath($path))
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
    ConvertTo-Json -InputObject $document -Depth 4 | Set-Content -LiteralPath $path -Encoding UTF8
    Write-Host "Recorded $($records.Count) console host(s) in $path"
    Write-StepSummary @("Console hosts before tests: $($records.Count)", "")
    return 0
}

function Invoke-Check([string]$path) {
    $snapshotKeys = Read-SnapshotKeys $path
    $testRoot = Resolve-TestBinaryRoot
    $waitedOwners = 0
    do {
        $pending = @(Get-NewConsoleHosts $snapshotKeys $testRoot | Where-Object { $_.Owner -eq 'TestBinary' })
        $waitedOwners += Wait-TestBinaryOwners $pending
    } while ($pending.Count -gt 0)

    $releaseDeadline = (Get-Date).AddSeconds($ReleaseSeconds)
    while ($true) {
        $newHosts = @(Get-NewConsoleHosts $snapshotKeys $testRoot)
        $orphans = @($newHosts | Where-Object { $_.Owner -eq 'Gone' })
        if ($orphans.Count -eq 0 -or (Get-Date) -ge $releaseDeadline) { break }
        Start-Sleep -Milliseconds $pollIntervalMilliseconds
    }

    $owned = @($newHosts | Where-Object { $_.Owner -ne 'Gone' })
    Write-Host "Console hosts in snapshot: $($snapshotKeys.Count); new: $($newHosts.Count); owned by a running process: $($owned.Count); test binaries waited for: $waitedOwners; orphaned: $($orphans.Count)"
    $summary = @(
        "### Console host orphan check",
        "",
        "| Before tests | New | Owned by a running process | Test binaries waited for | Orphaned |",
        "| --- | --- | --- | --- | --- |",
        "| $($snapshotKeys.Count) | $($newHosts.Count) | $($owned.Count) | $waitedOwners | $($orphans.Count) |",
        ""
    )
    if ($orphans.Count -eq 0) {
        Write-StepSummary $summary
        return 0
    }

    $table = $orphans | Sort-Object Id | Select-Object Id, ParentId, StartTime, CpuSeconds, CommandLine
    Write-Host "$($orphans.Count) console host(s) outlived their owning process:"
    Write-Host ($table | Format-Table -AutoSize -Wrap | Out-String -Width 4096)
    $rows = @($table | ForEach-Object { "| $($_.Id) | $($_.ParentId) | $($_.StartTime) | $($_.CpuSeconds) | ``$($_.CommandLine -replace '\|', '\|')`` |" })
    Write-StepSummary ($summary + @("| Id | Parent id | Start time | CPU seconds | Command line |", "| --- | --- | --- | --- | --- |") + $rows)
    return 1
}

if ($PSCmdlet.ParameterSetName -eq 'Snapshot') {
    exit (Invoke-Snapshot $Snapshot)
}
exit (Invoke-Check $Check)
