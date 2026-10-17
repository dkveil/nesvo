$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\scripts\ensure-dev-host.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$null)
$probe = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-CompatibleHost' }, $true)
. ([scriptblock]::Create($probe.Extent.Text))
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('nesvo-probe-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $pairingFile = Join-Path $temporary 'pairing.json'
    $ClientExe = Join-Path $temporary 'probe.cmd'
    Set-Content -LiteralPath $pairingFile -Value '{}'
    Set-Content -LiteralPath $ClientExe -Value "@echo off`r`necho Host unavailable 1>&2`r`nexit /b 1" -Encoding Ascii
    if (Test-CompatibleHost) { throw 'Failed native probe was accepted' }
    if ($ErrorActionPreference -ne 'Stop') { throw 'Probe changed caller error handling' }
    Set-Content -LiteralPath $ClientExe -Value "@echo off`r`nexit /b 0" -Encoding Ascii
    if (-not (Test-CompatibleHost)) { throw 'Successful native probe was rejected' }
    Remove-Item -LiteralPath $pairingFile
    if (Test-CompatibleHost) { throw 'Missing pairing file was accepted' }
    Write-Output 'PASS: failed stderr probe, successful probe, missing pairing, caller isolation'
} finally {
    Remove-Item -LiteralPath $ClientExe -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pairingFile -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporary
}
