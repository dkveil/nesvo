param(
    [Parameter(Mandatory = $true)][string]$PairingPath,
    [Parameter(Mandatory = $true)][string]$ClientExe,
    [Parameter(Mandatory = $true)][string]$HostExe,
    [Parameter(Mandatory = $true)][string]$Workspace
)

$ErrorActionPreference = 'Stop'
$pairingFile = [System.IO.Path]::GetFullPath($PairingPath)
$workspaceRoot = [System.IO.Path]::GetFullPath($Workspace)
$localPairingRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot 'host\.local'))
$pairingDirectory = Split-Path -Parent $pairingFile

function Test-PortAvailable([int]$port) {
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

function Test-CompatibleHost {
    if (-not (Test-Path -LiteralPath $pairingFile)) { return $false }
    & $ClientExe --pairing $pairingFile --check-host *> $null
    return $LASTEXITCODE -eq 0
}

if (Test-CompatibleHost) {
    Write-Host 'Using the running development host.'
    exit 0
}

if (-not $pairingFile.StartsWith($localPairingRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Error "The paired host is unavailable. Automatic startup is only supported for pairing files under $localPairingRoot."
    exit 1
}

if (Test-Path -LiteralPath $pairingFile) {
    try {
        $pairing = Get-Content -LiteralPath $pairingFile -Raw | ConvertFrom-Json
        $uri = [Uri]$pairing.url
        $port = [int]$uri.Port
    } catch {
        Write-Error 'The development pairing file is invalid.'
        exit 1
    }
    if (-not (Test-PortAvailable $port)) {
        Write-Error "Port $port is occupied by a host that cannot authenticate or is incompatible. Existing sessions were left untouched."
        exit 1
    }
} else {
    $port = 8793..8899 | Where-Object { Test-PortAvailable $_ } | Select-Object -First 1
    if (-not $port) {
        Write-Error 'No free development host port was found between 8793 and 8899.'
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $pairingDirectory | Out-Null
$runtimeDirectory = Join-Path $workspaceRoot 'target\nesvo-dev\host-runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$runtimeHost = Join-Path $runtimeDirectory ("nesvo-host-{0}.exe" -f [Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath $HostExe -Destination $runtimeHost
$hostLog = Join-Path $runtimeDirectory 'host.stdout.log'
$hostErrorLog = Join-Path $runtimeDirectory 'host.stderr.log'
Write-Host "Starting development host on port $port..."
$process = Start-Process -FilePath $runtimeHost -ArgumentList @('--port', [string]$port, '--pairing-dir', ('"' + $pairingDirectory + '"'), '--workspace', ('"' + $workspaceRoot + '"'), '--lan') -WorkingDirectory $workspaceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $hostLog -RedirectStandardError $hostErrorLog

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-CompatibleHost) {
        Write-Host 'Development host connected.'
        exit 0
    }
    if ($process.HasExited) { break }
}
Write-Error "Development host did not become available. See $hostErrorLog."
exit 1
