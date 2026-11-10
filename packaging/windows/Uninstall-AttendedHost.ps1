#Requires -Version 5.1
# Removes only an unchanged, receipt-owned prototype staging directory. Preview by default.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required.' }
$target = Join-Path (Join-Path $env:LOCALAPPDATA 'UnboundVNC') 'AttendedHost'
if (-not (Test-Path -LiteralPath $target)) { Write-Output 'Nothing staged by this prototype.'; return }
$targetInfo = Get-Item -LiteralPath $target -Force
if (-not ($targetInfo -is [IO.DirectoryInfo]) -or ($targetInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Target is not a normal directory; manual review required.'
}
$binary = Join-Path $target 'UnboundVNCAttendedHost.exe'
$receipt = Join-Path $target 'install-receipt.json'
$items = @(Get-ChildItem -LiteralPath $target -Force)
if ($items.Count -ne 2 -or -not (Test-Path -LiteralPath $binary) -or -not (Test-Path -LiteralPath $receipt)) {
    throw 'Unknown or missing target content; refusing removal.'
}
foreach ($item in $items) {
    if (-not ($item -is [IO.FileInfo]) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($item.Name -notin @('UnboundVNCAttendedHost.exe', 'install-receipt.json'))) {
        throw 'Unowned item or reparse point; refusing removal.'
    }
}
$meta = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
if ($meta.schema -ne 1 -or $meta.mode -ne 'per-user-attended-source-prototype' -or
    $meta.binary -ne 'UnboundVNCAttendedHost.exe' -or $meta.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'Unrecognized receipt; refusing removal.'
}
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $meta.sha256) {
    throw 'Binary changed since staging; refusing removal.'
}
if (Get-Process -Name 'UnboundVNCAttendedHost' -ErrorAction SilentlyContinue) {
    throw 'Attended host process appears to be running; close it before uninstall.'
}
if (-not $Apply) { Write-Output "PREVIEW ONLY: remove two verified files and empty directory $target; no changes made."; return }
Remove-Item -LiteralPath $binary -ErrorAction Stop
Remove-Item -LiteralPath $receipt -ErrorAction Stop
Remove-Item -LiteralPath $target -ErrorAction Stop
Write-Output "REMOVED: verified prototype staging at $target; parent directory retained."
