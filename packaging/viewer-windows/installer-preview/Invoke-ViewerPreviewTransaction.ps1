# CI-only per-user-shaped folder transaction. No registry, installer, service, firewall, or shortcut effects.
param(
  [Parameter(Mandatory)]
  [ValidateSet('PreviewInstall', 'ApplyTest', 'PreviewUninstall', 'RemoveTest', 'RecoverTest')]
  [string]$Operation,
  [Parameter(Mandatory)][string]$SandboxRoot,
  [switch]$InjectCopyFailure,
  [switch]$InjectRemovalFailure,
  [switch]$CrashPauseAfterCopy,
  [switch]$CrashPauseAfterMove,
  [switch]$PauseWithMutex
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'Preview transaction is restricted to ephemeral GitHub-hosted Windows Actions.'
}

$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
$root = [IO.Path]::GetFullPath($SandboxRoot).TrimEnd('\', '/')
$leaf = [IO.Path]::GetFileName($root)
if ([IO.Path]::GetDirectoryName($root) -ine $runner -or
    $leaf -cnotmatch '^unboundvnc-viewer-preview-[0-9a-f]{32}$') {
  throw 'Preview target must be a direct unique test child of RUNNER_TEMP.'
}
$id = $leaf.Substring('unboundvnc-viewer-preview-'.Length)
$source = Join-Path $runner 'unboundvnc-viewer-desktop-check/UnboundVNCViewer-win32-x64'
$appFolder = Join-Path $root 'User/LocalAppData/Programs/UnboundVNCViewer'
$appParent = [IO.Path]::GetDirectoryName($appFolder)
$pending = Join-Path $appParent '.UnboundVNCViewer.pending'
$removing = Join-Path $appParent '.UnboundVNCViewer.removing'
$recovery = Join-Path $appParent '.UnboundVNCViewer.recovery'
$marker = Join-Path $root '.unboundvnc-viewer-preview-owned'
$receipt = Join-Path $root '.unboundvnc-viewer-preview-receipt.json'
$receiptTemp = Join-Path $root '.unboundvnc-viewer-preview-receipt.tmp'
$journal = Join-Path $root '.unboundvnc-viewer-preview-journal.json'

function Assert-NoReparse([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Reparse root rejected: $path"
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $path -Recurse -Force)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Reparse descendant rejected: $($item.FullName)"
    }
  }
}

function Get-Inventory([string]$folder) {
  Assert-NoReparse $folder
  $files = @(
    Get-ChildItem -LiteralPath $folder -Recurse -File -Force |
      ForEach-Object {
        [pscustomobject]@{
          relative = [IO.Path]::GetRelativePath($folder, $_.FullName)
          size = $_.Length
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
      } | Sort-Object relative
  )
  $dirs = @(
    Get-ChildItem -LiteralPath $folder -Recurse -Directory -Force |
      ForEach-Object { [IO.Path]::GetRelativePath($folder, $_.FullName) } | Sort-Object
  )
  return [pscustomobject]@{ files = $files; dirs = $dirs }
}

function Assert-InventoryEqual($expected, $actual) {
  $left = ConvertTo-Json -InputObject $expected -Depth 10 -Compress
  $right = ConvertTo-Json -InputObject $actual -Depth 10 -Compress
  if ($left -cne $right) { throw 'Unknown, missing, modified or additional application file/directory.' }
}

function Assert-OwnedRoot {
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'No owned preview install root.' }
  Assert-NoReparse $root
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
      (Get-Content -LiteralPath $marker -Raw) -cne $id) {
    throw 'Preview ownership marker absent or mismatched.'
  }
  if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) {
    throw 'Preview receipt absent.'
  }
  $state = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if ($state.schema -ne 1 -or $state.id -cne $id -or $state.appRelative -cne 'User/LocalAppData/Programs/UnboundVNCViewer') {
    throw 'Preview receipt does not own the requested app folder.'
  }
  if ($state.status -notin @('installed', 'removed')) { throw 'Unrecognized preview receipt state.' }
  return $state
}

function Assert-AppClean($state) {
  Assert-AppInstalledState $state
  Assert-NoReparse $root
  if ((Test-Path -LiteralPath $pending) -or (Test-Path -LiteralPath $removing) -or
      (Test-Path -LiteralPath $recovery) -or (Test-Path -LiteralPath $receiptTemp)) {
    throw 'Unexpected pending/rollback transaction state.'
  }
  Assert-InventoryEqual $state.inventory (Get-Inventory $appFolder)
}

function Assert-AppInstalledState($state) {
  if ($state.status -ne 'installed' -or -not (Test-Path -LiteralPath $appFolder -PathType Container)) {
    throw 'Preview app is not installed in its test-owned folder.'
  }
}

function Assert-AppUnlocked {
  foreach ($file in @(Get-ChildItem -LiteralPath $appFolder -File -Recurse -Force)) {
    $handle = $null
    try { $handle = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
    catch { throw "Locked or inaccessible installed file: $($file.FullName)" }
    finally { if ($handle) { $handle.Dispose() } }
  }
}

function Write-State($state) {
  if (Test-Path -LiteralPath $receiptTemp) { throw 'Refusing unexpected receipt temp file.' }
  Set-Content -LiteralPath $receiptTemp -Value (ConvertTo-Json -InputObject $state -Depth 12) -NoNewline
  Move-Item -LiteralPath $receiptTemp -Destination $receipt -Force
}

function Write-Journal([string]$phase, $inventory) {
  $entry = [pscustomobject]@{
    schema = 1; id = $id; phase = $phase
    appRelative = 'User/LocalAppData/Programs/UnboundVNCViewer'
    inventory = $inventory
  }
  # A temporary journal update plus rename prevents truncated JSON on a killed writer.
  $next = Join-Path $root '.unboundvnc-viewer-preview-journal.next'
  Set-Content -LiteralPath $next -Value (ConvertTo-Json -InputObject $entry -Depth 12) -NoNewline
  Move-Item -LiteralPath $next -Destination $journal -Force
}

function Wait-ForTestCrash([string]$phase) {
  Write-Host "CRASH CHECKPOINT READY: $phase. Awaiting test-controller process termination."
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  while ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  throw 'Crash checkpoint was not terminated by the hosted test controller.'
}

function Assert-RecoveryLayout([string]$payload) {
  Assert-NoReparse $root
  $allowedFiles = @($marker, $journal)
  foreach ($file in @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)) {
    $inPayload = $file.FullName.StartsWith($payload + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    if (-not $inPayload -and $file.FullName -notin $allowedFiles) {
      throw "Recovery refuses unknown outside-payload file: $($file.FullName)"
    }
  }
  $parents = @(
    (Join-Path $root 'User'),
    (Join-Path $root 'User/LocalAppData'),
    (Join-Path $root 'User/LocalAppData/Programs'),
    $appParent,
    $payload
  )
  foreach ($dir in @(Get-ChildItem -LiteralPath $root -Recurse -Directory -Force)) {
    $inPayload = $dir.FullName.StartsWith($payload + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    if (-not $inPayload -and $dir.FullName -notin $parents) {
      throw "Recovery refuses unknown outside-payload directory: $($dir.FullName)"
    }
  }
}

if ($InjectCopyFailure -and $Operation -ne 'ApplyTest') { throw 'Copy injection belongs only to ApplyTest.' }
if ($InjectRemovalFailure -and $Operation -ne 'RemoveTest') { throw 'Removal injection belongs only to RemoveTest.' }
if (($CrashPauseAfterCopy -or $CrashPauseAfterMove) -and $Operation -ne 'ApplyTest') {
  throw 'Crash checkpoints belong only to ApplyTest.'
}
if ($CrashPauseAfterCopy -and $CrashPauseAfterMove) { throw 'Select only one crash checkpoint.' }
if ($PauseWithMutex -and $Operation -ne 'RemoveTest') { throw 'Mutex hold fixture belongs only to RemoveTest.' }

# A named Windows kernel mutex is keyed by the validated test-owned GUID, not
# by a file inside the folder that another operation could delete. The OS
# releases ownership when a process is killed, so journal recovery can resume.
$mutex = [Threading.Mutex]::new($false, "Local\UnboundVNC-Preview-$id")
$mutexOwned = $false
try {
  try { $mutexOwned = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] {
    $mutexOwned = $true
    Write-Host 'ABANDONED TEST MUTEX: prior owner terminated; strict journal/receipt validation still required.'
  }
  if (-not $mutexOwned) { throw 'Concurrent preview transaction refused: same test-owned root has a live operation.' }
  if ($PauseWithMutex) {
    $ready = Join-Path $runner "unboundvnc-viewer-mutex-ready-$id.txt"
    if (Test-Path -LiteralPath $ready) { throw 'Refusing pre-existing mutex fixture marker.' }
    Set-Content -LiteralPath $ready -Value $id -NoNewline
    Wait-ForTestCrash 'mutex-owned-removal'
  }

switch ($Operation) {
  'PreviewInstall' {
    if (Test-Path -LiteralPath $root) { throw 'Preview refuses pre-existing destination.' }
    if (-not (Test-Path -LiteralPath (Join-Path $source 'UnboundVNCViewer.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $source 'resources/app.asar') -PathType Leaf)) {
      throw 'Built unsigned Electron app folder missing.'
    }
    $inventory = Get-Inventory $source
    Write-Host "PREVIEW INSTALL ONLY (NO WRITES): $($inventory.files.Count) files; destination $appFolder; per-user-shaped temp layout; no shortcuts, registry, service, firewall or actual user install."
  }
  'ApplyTest' {
    if (Test-Path -LiteralPath $root) { throw 'Apply refuses pre-existing destination.' }
    $sourceInventory = Get-Inventory $source
    if ($sourceInventory.files.Count -lt 2) { throw 'Empty source payload refused.' }
    $created = $false
    try {
      $null = New-Item -ItemType Directory -Path $appParent -Force
      $created = $true
      Set-Content -LiteralPath $marker -Value $id -NoNewline
      Write-Journal 'copying' $sourceInventory
      Copy-Item -LiteralPath $source -Destination $pending -Recurse -Force
      Assert-InventoryEqual $sourceInventory (Get-Inventory $pending)
      Write-Journal 'pending-verified' $sourceInventory
      if ($CrashPauseAfterCopy) { Wait-ForTestCrash 'pending-verified' }
      if ($InjectCopyFailure) { throw 'INTENTIONAL_PREVIEW_COPY_INTERRUPTION' }
      Move-Item -LiteralPath $pending -Destination $appFolder
      Write-Journal 'app-moved' $sourceInventory
      if ($CrashPauseAfterMove) { Wait-ForTestCrash 'app-moved' }
      $state = [pscustomobject]@{
        schema = 1; id = $id; status = 'installed'
        appRelative = 'User/LocalAppData/Programs/UnboundVNCViewer'
        inventory = $sourceInventory
      }
      Write-State $state
      Remove-Item -LiteralPath $journal
      Assert-AppClean (Assert-OwnedRoot)
      Write-Host "PREVIEW APPLY TEST PASS: $($sourceInventory.files.Count) source files match hashes in isolated test-only per-user-shaped app folder."
    } catch {
      $failure = $_
      if ($created -and (Test-Path -LiteralPath $root)) {
        Assert-NoReparse $root
        if ((Test-Path -LiteralPath $marker) -and (Get-Content -LiteralPath $marker -Raw) -cne $id) {
          throw 'Refusing rollback of altered ownership marker.'
        }
        # This root did not exist before the transaction, and is wholly test-owned.
        Remove-Item -LiteralPath $root -Recurse -Force
      }
      if (Test-Path -LiteralPath $root) { throw 'Preview apply rollback did not remove its own root.' }
      if ($InjectCopyFailure -and $failure.Exception.Message -eq 'INTENTIONAL_PREVIEW_COPY_INTERRUPTION') {
        Write-Host 'PREVIEW APPLY ROLLBACK PASS: injected copy failure left no app, receipt or sandbox.'
      } else { throw $failure }
    }
  }
  'RecoverTest' {
    if (-not (Test-Path -LiteralPath $root -PathType Container) -or
        -not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -cne $id) {
      throw 'Recovery refuses absent or mismatched owner marker.'
    }
    if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { throw 'No interrupted test transaction journal.' }
    if ((Test-Path -LiteralPath $receipt) -or (Test-Path -LiteralPath $receiptTemp)) {
      throw 'Recovery refuses committed/ambiguous receipt; preserving state for review.'
    }
    $entry = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
    if ($entry.schema -ne 1 -or $entry.id -cne $id -or
        $entry.appRelative -cne 'User/LocalAppData/Programs/UnboundVNCViewer' -or
        $entry.phase -notin @('pending-verified', 'app-moved')) {
      throw 'Recovery refuses unknown or incomplete transaction phase.'
    }
    $sourceInventory = Get-Inventory $source
    Assert-InventoryEqual $sourceInventory $entry.inventory
    $hasPending = Test-Path -LiteralPath $pending -PathType Container
    $hasApp = Test-Path -LiteralPath $appFolder -PathType Container
    if ($hasPending -eq $hasApp) { throw 'Recovery requires exactly one pending or moved payload.' }
    if (($entry.phase -eq 'pending-verified' -and -not $hasPending) -or
        ($entry.phase -eq 'app-moved' -and -not $hasApp)) {
      throw 'Recovery journal phase/payload location mismatch; preserving ambiguous state.'
    }
    $payload = if ($hasPending) { $pending } else { $appFolder }
    Assert-InventoryEqual $entry.inventory (Get-Inventory $payload)
    Assert-RecoveryLayout $payload
    Remove-Item -LiteralPath $root -Recurse -Force
    if (Test-Path -LiteralPath $root) { throw 'Owned incomplete sandbox still exists after recovery.' }
    Write-Host "CRASH RECOVERY PASS: $($entry.phase) journal verified; interrupted test-only payload rolled back without touching source or user profile."
  }
  'PreviewUninstall' {
    $state = Assert-OwnedRoot
    Assert-AppInstalledState $state
    Assert-AppUnlocked
    Assert-AppClean $state
    Write-Host "PREVIEW UNINSTALL ONLY (NO WRITES): $($state.inventory.files.Count) exact owned app files eligible for test-only removal; profile/data retained; no user-machine changes."
  }
  'RemoveTest' {
    $state = Assert-OwnedRoot
    Assert-AppInstalledState $state
    Assert-AppUnlocked
    Assert-AppClean $state
    $moved = $false
    try {
      Copy-Item -LiteralPath $appFolder -Destination $recovery -Recurse -Force
      Assert-InventoryEqual $state.inventory (Get-Inventory $recovery)
      Move-Item -LiteralPath $appFolder -Destination $removing
      $moved = $true
      if ($InjectRemovalFailure) { throw 'INTENTIONAL_PREVIEW_UNINSTALL_INTERRUPTION' }
      Remove-Item -LiteralPath $removing -Recurse -Force
      $state.status = 'removed'
      Write-State $state
      Remove-Item -LiteralPath $recovery -Recurse -Force
      if ((Test-Path -LiteralPath $appFolder) -or (Test-Path -LiteralPath $recovery) -or
          (Test-Path -LiteralPath $removing)) { throw 'Preview uninstall residual app files.' }
      Write-Host "PREVIEW UNINSTALL TEST PASS: $($state.inventory.files.Count) app files removed; receipt and separate userData untouched."
    } catch {
      $failure = $_
      if ($moved -and -not (Test-Path -LiteralPath $appFolder)) {
        # Recovery source is independent of potentially partially removed folder.
        Copy-Item -LiteralPath $recovery -Destination $appFolder -Recurse -Force
      }
      if (Test-Path -LiteralPath $appFolder) {
        Assert-InventoryEqual $state.inventory (Get-Inventory $appFolder)
      } else { throw 'Preview uninstall recovery failed to restore application files.' }
      $state.status = 'installed'
      if (Test-Path -LiteralPath $receiptTemp) { Remove-Item -LiteralPath $receiptTemp -Force }
      Write-State $state
      if (Test-Path -LiteralPath $removing) { Remove-Item -LiteralPath $removing -Recurse -Force }
      if (Test-Path -LiteralPath $recovery) { Remove-Item -LiteralPath $recovery -Recurse -Force }
      if ($InjectRemovalFailure -and $failure.Exception.Message -eq 'INTENTIONAL_PREVIEW_UNINSTALL_INTERRUPTION') {
        Write-Host 'PREVIEW UNINSTALL ROLLBACK PASS: injected pre-delete interruption restored all app SHA256 and receipt remains installed.'
      } else { throw $failure }
    }
  }
}
} finally {
  if ($mutexOwned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
