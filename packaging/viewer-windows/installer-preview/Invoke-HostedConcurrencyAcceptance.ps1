# Only synthetic, GUID-owned RUNNER_TEMP folders. Baseline deliberately demonstrates prior live-recovery race.
param([ValidateSet('Baseline','Verify')][string]$Mode='Verify')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'Preview concurrency acceptance is restricted to GitHub-hosted Windows Actions.'
}
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\','/')
$source = Join-Path $runner 'unboundvnc-viewer-desktop-check/UnboundVNCViewer-win32-x64'
$transaction = [IO.Path]::GetFullPath('packaging/viewer-windows/installer-preview/Invoke-ViewerPreviewTransaction.ps1')
$manifestBefore = @(
  Get-ChildItem -LiteralPath $source -Recurse -File -Force | Sort-Object FullName |
    ForEach-Object { [pscustomobject]@{ relative=[IO.Path]::GetRelativePath($source,$_.FullName); hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }
)

function New-TestRoot { return (Join-Path $runner ('unboundvnc-viewer-preview-' + [guid]::NewGuid().ToString('N'))) }

function Assert-SourceUnchanged {
  $after = @(Get-ChildItem -LiteralPath $source -Recurse -File -Force | Sort-Object FullName)
  if ($after.Count -ne $manifestBefore.Count) { throw 'Concurrent transaction changed source count.' }
  for($i=0;$i -lt $after.Count;$i++) {
    $relative = [IO.Path]::GetRelativePath($source,$after[$i].FullName)
    if ($manifestBefore[$i].relative -cne $relative -or
        $manifestBefore[$i].hash -cne (Get-FileHash -LiteralPath $after[$i].FullName -Algorithm SHA256).Hash) {
      throw "Concurrent transaction changed source SHA: $relative"
    }
  }
}

function Must-RefuseLocked([scriptblock]$operation, [string]$case) {
  $refused = $false
  try { & $operation } catch {
    if ($_.Exception.Message -notlike '*Concurrent preview transaction refused*') { throw }
    $refused = $true
    Write-Host "CONCURRENT OPERATION REFUSED ($case): $($_.Exception.Message)"
  }
  if (-not $refused) { throw "Concurrent same-root operation was accepted: $case" }
}

function Stop-Owned([object]$process) {
  if ($process -and -not $process.HasExited) {
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw 'Owned PowerShell child did not terminate.' }
  }
}

function Remove-OwnedTestRoot([string]$root) {
  if (-not (Test-Path -LiteralPath $root)) { return }
  $leaf = [IO.Path]::GetFileName($root)
  if ([IO.Path]::GetDirectoryName($root) -ine $runner -or
      $leaf -cnotmatch '^unboundvnc-viewer-preview-[0-9a-f]{32}$') { throw 'Unsafe final root cleanup.' }
  $marker = Join-Path $root '.unboundvnc-viewer-preview-owned'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
      (Get-Content -LiteralPath $marker -Raw) -cne $leaf.Substring('unboundvnc-viewer-preview-'.Length)) {
    throw 'Refusing cleanup without exact owned marker.'
  }
  foreach($item in @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup of reparse test root.' }
  }
  Remove-Item -LiteralPath $root -Recurse -Force
  if (Test-Path -LiteralPath $root) { throw 'Owned test root still present after cleanup.' }
}

# Defect reproduction: original RecoverTest trusted a completed journal while
# the actual ApplyTest owner was alive and paused. It then deleted the live root.
$root = New-TestRoot
$holder = $null
try {
  $holder = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
    '-NoProfile','-NonInteractive','-File',$transaction,'-Operation','ApplyTest',
    '-SandboxRoot',$root,'-CrashPauseAfterCopy'
  ) -PassThru
  $journal = Join-Path $root '.unboundvnc-viewer-preview-journal.json'
  $deadline = [DateTime]::UtcNow.AddSeconds(40)
  $ready = $false
  while([DateTime]::UtcNow -lt $deadline) {
    if($holder.HasExited) { throw 'ApplyTest child exited before held-copy checkpoint.' }
    if(Test-Path -LiteralPath $journal) {
      try { $ready = (Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json).phase -eq 'pending-verified' }
      catch { $ready = $false }
    }
    if($ready) { break }
    Start-Sleep -Milliseconds 100
  }
  if(-not $ready) { throw 'No live transaction journal appeared.' }
  if($Mode -eq 'Baseline') {
    $deleted = $false
    try { & $transaction -Operation RecoverTest -SandboxRoot $root; $deleted = -not (Test-Path -LiteralPath $root) }
    catch { Write-Host "BASELINE REJECTED (not defect reproduction): $($_.Exception.Message)" }
    if($deleted -and -not $holder.HasExited) {
      Write-Host 'BASELINE RACE REPRODUCED: RecoverTest deleted live ApplyTest sandbox while original child PID was still running.'
      throw 'LIVE_OWNER_TOCTOU_DEFECT_REPRODUCED'
    }
    throw 'Baseline did not reproduce live-owner recovery race.'
  }

  Must-RefuseLocked { & $transaction -Operation RecoverTest -SandboxRoot $root } 'recovery while ApplyTest alive'
  Must-RefuseLocked { & $transaction -Operation ApplyTest -SandboxRoot $root } 'duplicate ApplyTest while owner alive'
  Must-RefuseLocked { & $transaction -Operation RemoveTest -SandboxRoot $root } 'uninstall while ApplyTest alive'
  if (-not (Test-Path -LiteralPath $root)) { throw 'Concurrent operation removed live owned root.' }
  Stop-Owned $holder
  & $transaction -Operation RecoverTest -SandboxRoot $root
  if (Test-Path -LiteralPath $root) { throw 'Abandoned owner lock prevented recovery or left root.' }
  Write-Host 'LIVE APPLY SERIALIZATION PASS: all three competing operations refused until exact owner PID was killed; then verified recovery completed.'
} finally {
  Stop-Owned $holder
  Remove-OwnedTestRoot $root
}

if($Mode -eq 'Verify') {
  # Hold a real installed-folder RemoveTest before preflight. Concurrent
  # Apply/Recover/second Remove must reject a live owner even on valid receipt.
  $root = New-TestRoot
  $holder = $null
  $readyFile = Join-Path $runner ('unboundvnc-viewer-mutex-ready-' + [IO.Path]::GetFileName($root).Substring('unboundvnc-viewer-preview-'.Length) + '.txt')
  try {
    & $transaction -Operation ApplyTest -SandboxRoot $root
    $holder = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
      '-NoProfile','-NonInteractive','-File',$transaction,'-Operation','RemoveTest',
      '-SandboxRoot',$root,'-PauseWithMutex'
    ) -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while(-not (Test-Path -LiteralPath $readyFile) -and [DateTime]::UtcNow -lt $deadline) {
      if($holder.HasExited) { throw 'RemoveTest owner exited before mutex hold.' }
      Start-Sleep -Milliseconds 100
    }
    if(-not (Test-Path -LiteralPath $readyFile)) { throw 'RemoveTest holder never acquired mutex.' }
    Must-RefuseLocked { & $transaction -Operation RemoveTest -SandboxRoot $root } 'second uninstall while owner alive'
    Must-RefuseLocked { & $transaction -Operation RecoverTest -SandboxRoot $root } 'recovery while uninstall alive'
    Must-RefuseLocked { & $transaction -Operation ApplyTest -SandboxRoot $root } 'apply while uninstall alive'
    Stop-Owned $holder
    Remove-Item -LiteralPath $readyFile
    & $transaction -Operation PreviewUninstall -SandboxRoot $root
    & $transaction -Operation RemoveTest -SandboxRoot $root
    $state = Get-Content -LiteralPath (Join-Path $root '.unboundvnc-viewer-preview-receipt.json') -Raw | ConvertFrom-Json
    if ($state.status -ne 'removed') { throw 'Uninstall did not finalize after abandoned owner lock.' }
    Write-Host 'LIVE UNINSTALL SERIALIZATION PASS: three concurrent operations rejected while RemoveTest held mutex; after owner kill, normal uninstall removed app and kept receipt.'
  } finally {
    Stop-Owned $holder
    if(Test-Path -LiteralPath $readyFile) { Remove-Item -LiteralPath $readyFile }
    Remove-OwnedTestRoot $root
  }
  Assert-SourceUnchanged
  Write-Host "HOSTED CONCURRENCY PASS: no live-owner recovery/double Apply/double Remove; abandoned mutex recovered; all $($manifestBefore.Count) source SHA256 unchanged."
}
