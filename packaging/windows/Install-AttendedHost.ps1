#Requires -Version 5.1
<#
.SYNOPSIS
  Source-only, per-user attended-host file staging. Preview by default.
.NOTES
  Not a released installer. Does not run the host, register persistence or alter firewall.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
    [switch]$LicenseAcknowledged,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$source = Get-Item -LiteralPath $ExePath -Force
if (-not ($source -is [IO.FileInfo]) -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Input must be a regular, non-reparse executable file.'
}
$hash = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
if ($hash -ne $ExpectedSha256.ToUpperInvariant()) { throw 'Source SHA-256 mismatch; nothing staged.' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for per-user installation.' }
$parent = Join-Path $env:LOCALAPPDATA 'UnboundVNC'
$target = Join-Path $parent 'AttendedHost'
$binary = Join-Path $target 'UnboundVNCAttendedHost.exe'
$receipt = Join-Path $target 'install-receipt.json'
if (Test-Path -LiteralPath $target) { throw 'AttendedHost target already exists; refusing overwrite.' }
if (Test-Path -LiteralPath $parent) {
    $parentInfo = Get-Item -LiteralPath $parent -Force
    if (-not ($parentInfo -is [IO.DirectoryInfo]) -or ($parentInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Parent is not a normal directory; refusing staging.'
    }
}
if (-not $Apply) {
    Write-Output "PREVIEW ONLY: stage verified SHA-256 $hash into $target; no changes made."
    return
}
if (-not $LicenseAcknowledged) { throw 'Apply requires explicit -LicenseAcknowledged after reviewing build/dependency licenses.' }
$createdTarget = $false
try {
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    New-Item -ItemType Directory -Path $target | Out-Null
    $createdTarget = $true
    Copy-Item -LiteralPath $source.FullName -Destination $binary -ErrorAction Stop
    $copiedHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($copiedHash -ne $hash) { throw 'Post-copy SHA-256 mismatch.' }
    [ordered]@{
        schema = 1
        mode = 'per-user-attended-source-prototype'
        binary = 'UnboundVNCAttendedHost.exe'
        sha256 = $copiedHash
    } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8 -ErrorAction Stop
    Write-Output "STAGED ONLY: $target (no process or service started)."
} catch {
    if ($createdTarget) {
        foreach ($ownedFile in @($receipt, $binary)) {
            if (Test-Path -LiteralPath $ownedFile) { Remove-Item -LiteralPath $ownedFile -Force }
        }
        Remove-Item -LiteralPath $target -ErrorAction Stop
    }
    throw
}
