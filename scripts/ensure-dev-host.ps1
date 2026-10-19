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
    # Windows PowerShell converts redirected native stderr into error records.
    # A stopped host is an expected probe failure, not a launcher failure.
    $ErrorActionPreference = 'SilentlyContinue'
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        $output = & $ClientExe --pairing $pairingFile --check-host 2>$null
        $connected = $LASTEXITCODE -eq 0
        if ($connected) {
            try { $script:hostCapabilities = ($output -join "`n") | ConvertFrom-Json } catch { $script:hostCapabilities = $null }
        }
        return $connected
    } catch {
        return $false
    }
}

function New-HostRuntime([string]$RuntimeRoot, [string]$HostBinary, [string]$ClientBinary) {
    # One immutable pair per host lifetime. Building again never overwrites a live MCP client.
    $runtimeScope = Join-Path $RuntimeRoot ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $runtimeScope | Out-Null
    $hostTarget = Join-Path $runtimeScope 'nesvo-host.exe'
    $clientTarget = Join-Path $runtimeScope 'nesvo.exe'
    Copy-Item -LiteralPath $HostBinary -Destination $hostTarget
    Copy-Item -LiteralPath $ClientBinary -Destination $clientTarget
    return @{ Host = $hostTarget; Client = $clientTarget }
}

if (Test-CompatibleHost) {
    $expectedBuild = & $HostExe --build-id
    if ($hostCapabilities.buildId -ne $expectedBuild) {
        Write-Warning 'The running host uses an older or different build. Current sessions are preserved. Save work and stop that host before restarting nesvo-dev to enable all new host features.'
    }
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
$runtime = New-HostRuntime $runtimeDirectory $HostExe $ClientExe
$runtimeHost = $runtime.Host
$hostLog = Join-Path $runtimeDirectory 'host.stdout.log'
$hostErrorLog = Join-Path $runtimeDirectory 'host.stderr.log'
Write-Host "Starting development host on port $port..."
$previousClientBinary = $env:NESVO_CLIENT_BINARY
try {
    $env:NESVO_CLIENT_BINARY = $runtime.Client
    $process = Start-Process -FilePath $runtimeHost -ArgumentList @('--port', [string]$port, '--pairing-dir', ('"' + $pairingDirectory + '"'), '--workspace', ('"' + $workspaceRoot + '"'), '--lan') -WorkingDirectory $workspaceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $hostLog -RedirectStandardError $hostErrorLog
} finally {
    $env:NESVO_CLIENT_BINARY = $previousClientBinary
}

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
