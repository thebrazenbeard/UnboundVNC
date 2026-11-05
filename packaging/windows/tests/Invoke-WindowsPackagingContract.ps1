#Requires -Version 5.1
<#
Exercises the source-only staging scripts with inert bytes, never a runnable host.
Must run only on an isolated, ephemeral GitHub-hosted Windows runner.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or -not $env:RUNNER_TEMP) {
    throw 'This contract test is restricted to a GitHub-hosted ephemeral Windows runner.'
}
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Self-hosted runners are prohibited for this staging test.'
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    Write-Host "PASS: $Message"
}
function Assert-Rejected([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected "$Message (rejected)"
}

$scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$installer = Join-Path (Split-Path -Parent $scriptRoot) 'Install-AttendedHost.ps1'
$uninstaller = Join-Path (Split-Path -Parent $scriptRoot) 'Uninstall-AttendedHost.ps1'
$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$sandbox = Join-Path $runnerTemp ('unboundvnc-contract-' + [guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA

New-Item -ItemType Directory -Path $sandbox -ErrorAction Stop | Out-Null
try {
    $env:LOCALAPPDATA = Join-Path $sandbox 'profile'
    New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
    $source = Join-Path $sandbox 'inert-bytes.exe'
    [IO.File]::WriteAllText($source, 'NOT A WINDOWS EXECUTABLE: contract fixture only')
    $sha = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $target = Join-Path (Join-Path $env:LOCALAPPDATA 'UnboundVNC') 'AttendedHost'
    $staged = Join-Path $target 'UnboundVNCAttendedHost.exe'
    $receipt = Join-Path $target 'install-receipt.json'

    $preview = & $installer -ExePath $source -ExpectedSha256 $sha
    Assert-True ($preview -like 'PREVIEW ONLY:*') 'Installer defaults to preview'
    Assert-True (-not (Test-Path -LiteralPath $target)) 'Installer preview creates no target'
    $empty = & $uninstaller
    Assert-True ($empty -eq 'Nothing staged by this prototype.') 'Uninstaller handles absence without changes'

    $badHash = ('0' * 64)
    if ($sha -eq $badHash) { $badHash = ('F' * 64) }
    Assert-Rejected { & $installer -ExePath $source -ExpectedSha256 $badHash } 'Mismatched source hash'
    Assert-Rejected { & $installer -ExePath $sandbox -ExpectedSha256 $sha } 'Directory supplied as executable'
    Assert-Rejected { & $installer -ExePath $source -ExpectedSha256 $sha -Apply } 'Missing license acknowledgement'
    Assert-True (-not (Test-Path -LiteralPath $target)) 'Failed preflight leaves no installation'

    $result = & $installer -ExePath $source -ExpectedSha256 $sha -LicenseAcknowledged -Apply
    Assert-True ($result -like 'STAGED ONLY:*') 'Explicit apply only stages a file'
    Assert-True ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -eq $sha) 'Staged bytes match hash'
    $meta = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    Assert-True ($meta.schema -eq 1 -and $meta.sha256 -eq $sha -and $meta.binary -eq 'UnboundVNCAttendedHost.exe') 'Receipt records verified staging'
    Assert-Rejected { & $installer -ExePath $source -ExpectedSha256 $sha -LicenseAcknowledged -Apply } 'Reinstall cannot overwrite a target'
    $removePreview = & $uninstaller
    Assert-True ($removePreview -like 'PREVIEW ONLY:*') 'Uninstaller defaults to preview'
    Assert-True ((Test-Path -LiteralPath $staged) -and (Test-Path -LiteralPath $receipt)) 'Uninstaller preview preserves both files'

    $unknown = Join-Path $target 'user-note.txt'
    [IO.File]::WriteAllText($unknown, 'must not delete unowned files')
    Assert-Rejected { & $uninstaller -Apply } 'Uninstaller rejects unknown content'
    Assert-True (Test-Path -LiteralPath $unknown) 'Unknown content survives failed uninstall'
    Remove-Item -LiteralPath $unknown

    $priorReceipt = [IO.File]::ReadAllBytes($receipt)
    [IO.File]::WriteAllText($receipt, '{"schema":999}')
    Assert-Rejected { & $uninstaller -Apply } 'Uninstaller rejects altered receipt'
    Assert-True (Test-Path -LiteralPath $staged) 'Altered receipt does not delete binary'
    [IO.File]::WriteAllBytes($receipt, $priorReceipt)

    [IO.File]::AppendAllText($staged, 'tampered')
    Assert-Rejected { & $uninstaller -Apply } 'Uninstaller rejects modified binary'
    Copy-Item -LiteralPath $source -Destination $staged -Force
    $removed = & $uninstaller -Apply
    Assert-True ($removed -like 'REMOVED:*') 'Explicit uninstall removes verified staging'
    Assert-True (-not (Test-Path -LiteralPath $target)) 'Uninstaller removed only owned target'
    Assert-True (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'UnboundVNC')) 'Parent directory remains'

    # Simulate interrupted file staging: missing receipt must never be auto-cleaned.
    New-Item -ItemType Directory -Path $target | Out-Null
    Copy-Item -LiteralPath $source -Destination $staged
    Assert-Rejected { & $uninstaller -Apply } 'Incomplete/interrupted staging cannot be uninstalled blindly'
    Assert-Rejected { & $installer -ExePath $source -ExpectedSha256 $sha -LicenseAcknowledged -Apply } 'Incomplete target cannot be overwritten'
    Assert-True (Test-Path -LiteralPath $staged) 'Orphaned bytes remain for manual review'
    Remove-Item -LiteralPath $staged
    Remove-Item -LiteralPath $target

    $parent = Join-Path $env:LOCALAPPDATA 'UnboundVNC'
    Remove-Item -LiteralPath $parent
    [IO.File]::WriteAllText($parent, 'not a directory')
    Assert-Rejected { & $installer -ExePath $source -ExpectedSha256 $sha -LicenseAcknowledged -Apply } 'Unsafe parent path is rejected'
    Assert-True ((Get-Content -LiteralPath $parent -Raw) -eq 'not a directory') 'Unsafe parent is not modified'
    Write-Host 'PASS: All isolated Windows staging and rollback contract checks completed.'
}
finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    # Only the exact random test directory created directly under RUNNER_TEMP.
    if ((Split-Path -Parent $sandbox) -eq $runnerTemp -and
        (Split-Path -Leaf $sandbox) -match '^unboundvnc-contract-[0-9a-f]{32}$' -and
        (Test-Path -LiteralPath $sandbox -PathType Container)) {
        Remove-Item -LiteralPath $sandbox -Recurse -Force
    }
}
