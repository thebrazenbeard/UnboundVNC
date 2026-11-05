# CI-only per-user-shaped folder transaction. No registry, installer, service, firewall, or shortcut effects.
param(
  [Parameter(Mandatory)]
  [ValidateSet('PreviewInstall', 'ApplyTest', 'PreviewUninstall', 'RemoveTest')]
  [string]$Operation,
  [Parameter(Mandatory)][string]$SandboxRoot,
  [switch]$InjectCopyFailure,
  [switch]$InjectRemovalFailure
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

if ($InjectCopyFailure -and $Operation -ne 'ApplyTest') { throw 'Copy injection belongs only to ApplyTest.' }
if ($InjectRemovalFailure -and $Operation -ne 'RemoveTest') { throw 'Removal injection belongs only to RemoveTest.' }

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
      Copy-Item -LiteralPath $source -Destination $pending -Recurse -Force
      Assert-InventoryEqual $sourceInventory (Get-Inventory $pending)
      if ($InjectCopyFailure) { throw 'INTENTIONAL_PREVIEW_COPY_INTERRUPTION' }
      Move-Item -LiteralPath $pending -Destination $appFolder
      $state = [pscustomobject]@{
        schema = 1; id = $id; status = 'installed'
        appRelative = 'User/LocalAppData/Programs/UnboundVNCViewer'
        inventory = $sourceInventory
      }
      Write-State $state
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
