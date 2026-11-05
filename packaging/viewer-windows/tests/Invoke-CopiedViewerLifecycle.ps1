# Hosted-Windows-only disposable-folder acceptance. Nothing here installs software.
param(
  [ValidateSet('full', 'guard', 'abort-after-copy')]
  [string]$Mode = 'full'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw 'Refusing lifecycle test outside a GitHub-hosted Windows Actions runner.'
}

$originalRunnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
$source = [IO.Path]::GetFullPath((Join-Path $originalRunnerTemp 'unboundvnc-viewer-desktop-check/UnboundVNCViewer-win32-x64'))
$markerName = '.unboundvnc-viewer-lifecycle-test-owned'

function Assert-TestOwnedRoot([string]$candidate) {
  $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
  $parent = [IO.Path]::GetDirectoryName($full)
  $leaf = [IO.Path]::GetFileName($full)
  if ($parent -ine $originalRunnerTemp -or $leaf -cnotmatch '^unboundvnc-viewer-lifecycle-[0-9a-f]{32}$') {
    throw "Unsafe lifecycle cleanup target rejected: $candidate"
  }
  if ((Test-Path -LiteralPath $full) -and
      ((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Lifecycle root cannot be a symlink or other reparse point.'
  }
  return $full
}

function Assert-CopiedPayload([string]$original, [string]$copy) {
  Assert-NoReparseDescendants $original
  Assert-NoReparseDescendants $copy
  $originalFiles = @(Get-ChildItem -LiteralPath $original -File -Recurse -Force)
  $copyFiles = @(Get-ChildItem -LiteralPath $copy -File -Recurse -Force)
  if ($originalFiles.Count -eq 0 -or $originalFiles.Count -ne $copyFiles.Count) {
    throw 'Copied desktop payload has a missing/extra file.'
  }
  foreach ($file in $originalFiles) {
    $relative = [IO.Path]::GetRelativePath($original, $file.FullName)
    $other = Join-Path $copy $relative
    if (-not (Test-Path -LiteralPath $other -PathType Leaf)) {
      throw "Copied desktop file missing: $relative"
    }
    if ((Get-Item -LiteralPath $other).Length -ne $file.Length -or
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne
          (Get-FileHash -LiteralPath $other -Algorithm SHA256).Hash) {
      throw "Copied desktop file SHA256 mismatch: $relative"
    }
  }
  foreach ($relative in @('UnboundVNCViewer.exe', 'resources/app.asar')) {
    if (-not (Test-Path -LiteralPath (Join-Path $copy $relative) -PathType Leaf)) {
      throw "Copied desktop critical payload missing: $relative"
    }
  }
  Write-Host "COPY INTEGRITY: $($originalFiles.Count) files matched SHA256, including EXE and app.asar."
}

function Assert-NoReparseDescendants([string]$root) {
  $items = @(Get-ChildItem -LiteralPath $root -Recurse -Force)
  foreach ($item in $items) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Reparse point refused in lifecycle payload: $($item.FullName)"
    }
  }
}

function Get-PayloadManifest([string]$root) {
  $files = @(Get-ChildItem -LiteralPath $root -File -Recurse -Force)
  $manifest = @{}
  foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($root, $file.FullName)
    $manifest[$relative] = "$(($file.Length)):$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
  }
  return $manifest
}

function Assert-ManifestUnchanged([hashtable]$before, [hashtable]$after) {
  if ($before.Count -eq 0 -or $before.Count -ne $after.Count) {
    throw 'Original build manifest file count changed during lifecycle test.'
  }
  foreach ($relative in $before.Keys) {
    if (-not $after.ContainsKey($relative) -or $before[$relative] -cne $after[$relative]) {
      throw "Original build was modified during lifecycle test: $relative"
    }
  }
}

function Assert-ClosedPort([int]$port) {
  if ($port -lt 1 -or $port -gt 65535) { throw "Invalid port $port" }
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $attempt = $client.ConnectAsync('127.0.0.1', $port)
    try { $open = $attempt.Wait(2000) -and $client.Connected } catch { $open = $false }
    if ($open) { throw "CI listener remained open after process exit: 127.0.0.1:$port" }
  } finally { $client.Dispose() }
}

if ($Mode -eq 'guard') {
  $good = Join-Path $originalRunnerTemp ('unboundvnc-viewer-lifecycle-' + ('a' * 32))
  if ((Assert-TestOwnedRoot $good) -ne [IO.Path]::GetFullPath($good)) { throw 'Guard rejected safe direct child.' }
  foreach ($bad in @(
    $originalRunnerTemp,
    [IO.Path]::GetDirectoryName($originalRunnerTemp),
    (Join-Path $originalRunnerTemp 'unboundvnc-viewer-lifecycle-not-a-guid'),
    (Join-Path $originalRunnerTemp ('nested/unboundvnc-viewer-lifecycle-' + ('a' * 32))),
    (Join-Path $originalRunnerTemp ('unboundvnc-viewer-lifecycle-' + ('a' * 32) + '/..'))
  )) {
    $rejected = $false
    try { $null = Assert-TestOwnedRoot $bad } catch { $rejected = $true }
    if (-not $rejected) { throw "Cleanup path guard accepted unsafe target: $bad" }
  }
  Write-Host 'GUARD PASS: runner root, parent, forged name, nested path, and traversal all rejected.'

  # A junction inside a disposable fixture proves that recursive cleanup will
  # reject descendant reparse points. Nothing points outside this owned fixture.
  $probe = Assert-TestOwnedRoot (Join-Path $originalRunnerTemp ('unboundvnc-viewer-lifecycle-' + [guid]::NewGuid().ToString('N')))
  $null = New-Item -ItemType Directory -Path $probe
  $target = Join-Path $probe 'private-target'
  $junction = Join-Path $probe 'junction'
  $null = New-Item -ItemType Directory -Path $target
  try {
    try { $null = New-Item -ItemType Junction -Path $junction -Target $target -ErrorAction Stop }
    catch { Write-Host "REPARSE FIXTURE UNAVAILABLE (not a pass): $($_.Exception.Message)" }
    if (Test-Path -LiteralPath $junction) {
      $rejected = $false
      try { Assert-NoReparseDescendants $probe } catch { $rejected = $true }
      if (-not $rejected) { throw 'Descendant junction escaped reparse guard.' }
      Write-Host 'REPARSE GUARD PASS: nested directory junction was rejected.'
    }
  } finally {
    if (Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction -Force }
    if (Test-Path -LiteralPath $junction) { throw 'Could not unlink test-owned junction; refusing recursive cleanup.' }
    Assert-NoReparseDescendants $probe
    Remove-Item -LiteralPath $probe -Recurse -Force
  }
  return
}

if (-not (Test-Path -LiteralPath (Join-Path $source 'UnboundVNCViewer.exe') -PathType Leaf)) {
  throw 'Built Windows viewer source folder is missing; no synthetic substitute allowed.'
}
Assert-NoReparseDescendants $source
$beforeManifest = Get-PayloadManifest $source
$stageId = [guid]::NewGuid().ToString('N')
$stage = Assert-TestOwnedRoot (Join-Path $originalRunnerTemp "unboundvnc-viewer-lifecycle-$stageId")
$copy = Join-Path $stage 'UnboundVNCViewer-win32-x64'
$exe = Join-Path $copy 'UnboundVNCViewer.exe'
$viewer = $null
$fixture = $null
$fixturePort = 0
$appPorts = @()
$completed = $false
if (Test-Path -LiteralPath $stage) { throw 'Refusing pre-existing lifecycle stage.' }

try {
  $null = New-Item -ItemType Directory -Path $stage -ErrorAction Stop
  Set-Content -LiteralPath (Join-Path $stage $markerName) -Value $stageId -NoNewline
  Copy-Item -LiteralPath $source -Destination $copy -Recurse -ErrorAction Stop
  Assert-CopiedPayload $source $copy

  if ($Mode -eq 'abort-after-copy') {
    throw 'INTENTIONAL_CI_INTERRUPTION_AFTER_COPY'
  }

  # Only child processes see this fresh profile/receipt root. No actual user profile is opened.
  $env:RUNNER_TEMP = $stage
  $profile = Join-Path $stage 'unboundvnc-viewer-ci-empty-profile'
  if (Test-Path -LiteralPath $profile) { throw 'Fresh smoke profile was not empty.' }
  $fixtureFile = Join-Path $stage 'unboundvnc-viewer-fixture-port.txt'
  $fixtureScript = [IO.Path]::GetFullPath('packaging/viewer-windows/tests/ci-rfb-fixture.mjs')
  $fixture = Start-Process -FilePath 'node.exe' -ArgumentList $fixtureScript -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $fixtureFile) -and [DateTime]::UtcNow -lt $deadline) {
    if ($fixture.HasExited) { throw 'Synthetic RFB fixture exited before listening.' }
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $fixtureFile)) { throw 'Synthetic RFB fixture never listened.' }
  $fixturePort = [int](Get-Content -LiteralPath $fixtureFile -Raw)
  if ($fixturePort -lt 1 -or $fixturePort -gt 65535) { throw 'Synthetic RFB fixture wrote an invalid port.' }
  $env:UNBOUNDVNC_DESKTOP_CI_SMOKE = '1'
  $env:UNBOUNDVNC_CI_FIXTURE_PORT = [string]$fixturePort
  $viewer = Start-Process -FilePath $exe -PassThru
  if (-not $viewer.WaitForExit(45000)) { throw 'Copied Electron executable timed out.' }
  if ($viewer.ExitCode -ne 0) {
    $errorPath = Join-Path $stage 'unboundvnc-viewer-smoke-error.txt'
    if (Test-Path -LiteralPath $errorPath) { Write-Host "Smoke failure: $(Get-Content -LiteralPath $errorPath -Raw)" }
    throw "Copied Electron executable returned $($viewer.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $profile -PathType Container)) {
    throw 'Electron did not create the isolated disposable profile.'
  }
  $receiptPath = Join-Path $stage 'unboundvnc-viewer-desktop-smoke.json'
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
    throw 'Copied Electron app did not emit a renderer/viewport receipt.'
  }
  $result = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  if ($result.renderer -ne 'loaded' -or $result.session -ne 'synthetic-rfb-connected') {
    throw 'Renderer strict 2x2 RGBA pixel oracle did not complete.'
  }
  foreach ($uri in @($result.url, $result.gatewayUrl)) {
    $endpoint = [uri]$uri
    if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -ne '127.0.0.1') {
      throw 'Unexpected non-loopback desktop listener receipt.'
    }
    $appPorts += [int]$endpoint.Port
  }
  $events = Join-Path $stage 'unboundvnc-viewer-fixture-protocol.txt'
  if (-not (Test-Path -LiteralPath $events) -or
      -not ((Get-Content -LiteralPath $events -Raw) -match 'RFB_MESSAGE framebuffer-request')) {
    throw 'No synthetic RFB framebuffer request from actual Electron renderer.'
  }
  if ($fixture -and -not $fixture.HasExited) {
    $fixture.Kill()
    if (-not $fixture.WaitForExit(5000)) { throw 'Synthetic fixture would not stop.' }
  }
  foreach ($port in @($appPorts + $fixturePort)) { Assert-ClosedPort $port }
  $completed = $true
  Write-Host 'HOSTED RUNTIME PASS: copied unsigned app folder launched with fresh profile; actual Electron renderer checked all 16 expected 2x2 RGBA bytes, disconnected to dashboard, exited; app HTTP, gateway HTTP/WS and RFB fixture loopback ports closed.'
} catch {
  if ($Mode -ne 'abort-after-copy' -or $_.Exception.Message -ne 'INTENTIONAL_CI_INTERRUPTION_AFTER_COPY') { throw }
  Write-Host 'EXPECTED FAILURE INJECTION: copied folder was staged, then simulated work interruption before any launch.'
} finally {
  if ($viewer -and -not $viewer.HasExited) { $viewer.Kill(); $null = $viewer.WaitForExit(5000) }
  if ($fixture -and -not $fixture.HasExited) { $fixture.Kill(); $null = $fixture.WaitForExit(5000) }
  Remove-Item Env:UNBOUNDVNC_DESKTOP_CI_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:UNBOUNDVNC_CI_FIXTURE_PORT -ErrorAction SilentlyContinue
  $env:RUNNER_TEMP = $originalRunnerTemp
  if (Test-Path -LiteralPath $stage) {
    $null = Assert-TestOwnedRoot $stage
    $marker = Join-Path $stage $markerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -cne $stageId) {
      throw 'Refusing cleanup: unique stage ownership marker absent or modified.'
    }
    Assert-NoReparseDescendants $stage
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $stage) { throw 'Uninstall-style cleanup failed to remove copied folder, receipts and isolated profile.' }
  Assert-NoReparseDescendants $source
  Assert-ManifestUnchanged $beforeManifest (Get-PayloadManifest $source)
  Write-Host "REVERSIBLE TEST COPY CLEANUP PASS: only uniquely marked runner-temp sandbox removed; all $($beforeManifest.Count) original build files retained identical SHA256. No registry, services, firewall, startup, machine install or release changed."
}
if ($Mode -eq 'full' -and -not $completed) { throw 'Lifecycle acceptance did not complete.' }
