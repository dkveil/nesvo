$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\scripts\ensure-dev-host.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$null)
$prepare = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-HostRuntime' }, $true)
. ([scriptblock]::Create($prepare.Extent.Text))
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('nesvo-runtime-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $hostSource = Join-Path $temporary 'host-source.exe'
    $clientSource = Join-Path $temporary 'client-source.exe'
    Set-Content -LiteralPath $hostSource -Value 'host-one'
    Set-Content -LiteralPath $clientSource -Value 'client-one'
    $first = New-HostRuntime (Join-Path $temporary 'runtime') $hostSource $clientSource
    Set-Content -LiteralPath $clientSource -Value 'client-two'
    $second = New-HostRuntime (Join-Path $temporary 'runtime') $hostSource $clientSource
    if ($first.Host -eq $second.Host -or $first.Client -eq $second.Client) { throw 'Runtime pairs must be immutable per host lifetime' }
    if ((Split-Path -Parent $first.Host) -ne (Split-Path -Parent $first.Client)) { throw 'Host and CLI must be discoverable siblings' }
    if ((Get-Content -LiteralPath $first.Client).Trim() -ne 'client-one') { throw 'New build overwrote existing host CLI' }
    if ((Get-Content -LiteralPath $second.Client).Trim() -ne 'client-two') { throw 'New host did not receive latest CLI' }
    Remove-Item -LiteralPath $clientSource
    if (-not (Test-Path -LiteralPath $first.Client) -or -not (Test-Path -LiteralPath $second.Client)) { throw 'Runtime depended on ephemeral TUI executable' }
    Write-Output 'PASS: matching immutable host/CLI pairs survive TUI removal and subsequent builds'
} finally {
    $resolved = [System.IO.Path]::GetFullPath($temporary)
    $expectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    if ((Split-Path -Parent $resolved) -ne $expectedParent -or -not (Split-Path -Leaf $resolved).StartsWith('nesvo-runtime-')) { throw 'Refusing cleanup outside owned fixture' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
