# One-command attended local screen-sharing preview. No service, relay or firewall change.
param([switch]$NoBrowser)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Only Windows interactive desktop preview is supported.'
}
$npm = Get-Command npm.cmd -ErrorAction Stop
$node = Get-Command node.exe -ErrorAction Stop
$dotnet = Get-Command dotnet.exe -ErrorAction Stop
$viewer = Join-Path $root 'apps\viewer'
$hostProject = Join-Path $root 'apps\host-windows\UnboundVnc.Host.Windows.csproj'
Write-Host 'Installing pinned viewer dependencies without dependency lifecycle scripts...'
& $npm.Source ci --prefix $viewer --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Viewer dependency installation failed; no sharing launched.' }
Write-Host 'Building local browser viewer...'
& $npm.Source run build --prefix $viewer
if ($LASTEXITCODE -ne 0) { throw 'Viewer build failed; no sharing launched.' }
Write-Host 'Building attended Windows host...'
& $dotnet.Source build $hostProject --configuration Release --nologo --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'Host build failed; no sharing launched.' }
Write-Host 'Starting local-only preview. Host starts with sharing OFF.'
$argsForNode = @((Join-Path $root 'scripts\start-local-preview.mjs'))
if (-not $NoBrowser) { $argsForNode += '--open-browser' }
& $node.Source @argsForNode
if ($LASTEXITCODE -ne 0) { throw 'Local preview exited with a failure.' }