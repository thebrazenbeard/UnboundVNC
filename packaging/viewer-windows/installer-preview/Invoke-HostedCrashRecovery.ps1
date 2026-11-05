# Kills only test-owned PowerShell child processes on an ephemeral Windows Actions runner.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or -not $env:RUNNER_TEMP) {
  throw 'Crash recovery acceptance is forbidden outside hosted Windows Actions.'
}
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
$source = Join-Path $runner 'unboundvnc-viewer-desktop-check/UnboundVNCViewer-win32-x64'
$transaction = [IO.Path]::GetFullPath('packaging/viewer-windows/installer-preview/Invoke-ViewerPreviewTransaction.ps1')
$sourceBefore = @(
  Get-ChildItem -LiteralPath $source -File -Recurse -Force | Sort-Object FullName |
    ForEach-Object { [pscustomobject]@{ relative=[IO.Path]::GetRelativePath($source,$_.FullName); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }
)

function Must-Refuse([scriptblock]$operation, [string]$case) {
  $refused = $false
  try { & $operation } catch { $refused = $true; Write-Host "EXPECTED CRASH-RECOVERY REFUSAL ($case): $($_.Exception.Message)" }
  if (-not $refused) { throw "Recovery accepted unsafe state: $case" }
}

function Assert-SourceUnchanged {
  $after = @(Get-ChildItem -LiteralPath $source -File -Recurse -Force | Sort-Object FullName)
  if ($after.Count -ne $sourceBefore.Count) { throw 'Crash recovery changed source count.' }
  for ($i=0;$i -lt $after.Count;$i++) {
    $relative = [IO.Path]::GetRelativePath($source,$after[$i].FullName)
    if ($sourceBefore[$i].relative -cne $relative -or
        $sourceBefore[$i].sha256 -cne (Get-FileHash -LiteralPath $after[$i].FullName -Algorithm SHA256).Hash) {
      throw "Crash recovery modified source file: $relative"
    }
  }
}

foreach ($checkpoint in @('AfterCopy','AfterMove')) {
  $root = Join-Path $runner ('unboundvnc-viewer-preview-' + [guid]::NewGuid().ToString('N'))
  $id = [IO.Path]::GetFileName($root).Substring('unboundvnc-viewer-preview-'.Length)
  $journal = Join-Path $root '.unboundvnc-viewer-preview-journal.json'
  $marker = Join-Path $root '.unboundvnc-viewer-preview-owned'
  $pending = Join-Path $root 'User/LocalAppData/Programs/.UnboundVNCViewer.pending'
  $installed = Join-Path $root 'User/LocalAppData/Programs/UnboundVNCViewer'
  $payload = if ($checkpoint -eq 'AfterCopy') { $pending } else { $installed }
  $process = $null
  try {
    if (Test-Path -LiteralPath $root) { throw 'Refusing pre-existing crash fixture root.' }
    $args = @('-NoProfile','-NonInteractive','-File', $transaction, '-Operation','ApplyTest','-SandboxRoot',$root,"-CrashPause$checkpoint")
    $process = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $args -PassThru
    $phase = if ($checkpoint -eq 'AfterCopy') { 'pending-verified' } else { 'app-moved' }
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($process.HasExited) { throw "Crash child exited before $phase checkpoint." }
      if (Test-Path -LiteralPath $journal) {
        try {
          $state = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
          $ready = $state.phase -eq $phase -and (Test-Path -LiteralPath $payload -PathType Container)
        } catch { $ready = $false }
      }
      if ($ready) { break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw "No durable $phase crash checkpoint appeared." }
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw 'Owned crash-child process did not terminate.' }
    Write-Host "CRASH INJECTION PASS: force-terminated exact owned PowerShell PID $($process.Id) after journal phase $phase."

    # A forged or torn phase must never authorize deletion even if the payload
    # hashes are correct; phase determines the only admissible physical slot.
    $savedJournal = Get-Content -LiteralPath $journal -Raw
    try {
      $changed = $savedJournal | ConvertFrom-Json
      $changed.phase = if ($phase -eq 'pending-verified') { 'app-moved' } else { 'pending-verified' }
      Set-Content -LiteralPath $journal -Value (ConvertTo-Json -InputObject $changed -Depth 12) -NoNewline
      Must-Refuse { & $transaction -Operation RecoverTest -SandboxRoot $root } 'forged swapped journal phase'
      if (-not (Test-Path -LiteralPath $payload)) { throw 'Phase mismatch deleted a valid payload.' }
    } finally { Set-Content -LiteralPath $journal -Value $savedJournal -NoNewline }

    $unknown = Join-Path $payload 'unrecognized-crash-file.txt'
    Set-Content -LiteralPath $unknown -Value 'not in inventory' -NoNewline
    Must-Refuse { & $transaction -Operation RecoverTest -SandboxRoot $root } 'unknown staged file'
    if (-not (Test-Path -LiteralPath $unknown)) { throw 'Refused recovery deleted unknown file.' }
    Remove-Item -LiteralPath $unknown

    Set-Content -LiteralPath $marker -Value 'wrong-owner' -NoNewline
    try { Must-Refuse { & $transaction -Operation RecoverTest -SandboxRoot $root } 'changed ownership marker' }
    finally { Set-Content -LiteralPath $marker -Value $id -NoNewline }

    $linkTarget = Join-Path $root 'private-junction-target'
    $link = Join-Path $payload 'reparse-junction-test'
    $null = New-Item -ItemType Directory -Path $linkTarget
    try {
      $null = New-Item -ItemType Junction -Path $link -Target $linkTarget
      Must-Refuse { & $transaction -Operation RecoverTest -SandboxRoot $root } 'nested junction'
    } finally {
      if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
      if (Test-Path -LiteralPath $link) { throw 'Junction still present; unsafe to clean test root.' }
      Remove-Item -LiteralPath $linkTarget -Recurse -Force
    }

    $spurious = Join-Path $root 'unknown-empty-directory'
    $null = New-Item -ItemType Directory -Path $spurious
    Must-Refuse { & $transaction -Operation RecoverTest -SandboxRoot $root } 'unowned extra directory'
    Remove-Item -LiteralPath $spurious

    $fakeReceipt = Join-Path $root '.unboundvnc-viewer-preview-receipt.json'
    Set-Content -LiteralPath $fakeReceipt -Value '{}' -NoNewline
    Must-Refuse { & $transaction -Operation RecoverTest -SandboxRoot $root } 'ambiguous receipt or committed state'
    Remove-Item -LiteralPath $fakeReceipt

    & $transaction -Operation RecoverTest -SandboxRoot $root
    if (Test-Path -LiteralPath $root) { throw 'Crash recovery did not remove incomplete owned root.' }
    Assert-SourceUnchanged
  } finally {
    if ($process -and -not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
    if (Test-Path -LiteralPath $root) {
      if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
          (Get-Content -LiteralPath $marker -Raw) -cne $id) {
        throw 'Refusing test cleanup of altered owner marker.'
      }
      foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
          throw 'Refusing test cleanup containing reparse descendants.'
        }
      }
      Remove-Item -LiteralPath $root -Recurse -Force
      if (Test-Path -LiteralPath $root) { throw 'Test-only crash root cleanup failed.' }
    }
  }
}
Write-Host "HOSTED CRASH JOURNAL PASS: both abrupt-copy and abrupt-rename checkpoints recovered; swapped journal phases, unknown files, forged marker, junction, extra directory and committed receipt refused; all $($sourceBefore.Count) source files retained SHA256."
