# Run only on an ephemeral GitHub-hosted Windows runner with a source-built Electron app folder.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'Hosted preview acceptance is forbidden on user machines or self-hosted runners.'
}
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
$root = Join-Path $runner ('unboundvnc-viewer-preview-' + [guid]::NewGuid().ToString('N'))
$id = [IO.Path]::GetFileName($root).Substring('unboundvnc-viewer-preview-'.Length)
$transaction = [IO.Path]::GetFullPath('packaging/viewer-windows/installer-preview/Invoke-ViewerPreviewTransaction.ps1')
$fixtureScript = [IO.Path]::GetFullPath('packaging/viewer-windows/tests/ci-rfb-fixture.mjs')
$app = Join-Path $root 'User/LocalAppData/Programs/UnboundVNCViewer'
$exe = Join-Path $app 'UnboundVNCViewer.exe'
$source = Join-Path $runner 'unboundvnc-viewer-desktop-check/UnboundVNCViewer-win32-x64'
$marker = Join-Path $root '.unboundvnc-viewer-preview-owned'
$profile = Join-Path $root 'unboundvnc-viewer-ci-empty-profile'
$fixture = $null
$viewer = $null

function Must-Refuse([scriptblock]$block, [string]$reason, [string]$expectedError = '') {
  $refused = $false
  try { & $block } catch {
    $actualError = $_.Exception.Message
    if ($expectedError -and $actualError -cne $expectedError) {
      throw "NEGATIVE ORACLE FAILURE ($reason): expected '$expectedError'; observed '$actualError'."
    }
    $refused = $true
    Write-Host "EXPECTED REFUSAL ($reason): $actualError"
  }
  if (-not $refused) { throw "Unsafe preview operation was accepted: $reason" }
}

function Assert-Closed([int]$port) {
  if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid received localhost port.' }
  $socket = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $socket.ConnectAsync('127.0.0.1', $port)
    try { $open = $connect.Wait(2000) -and $socket.Connected } catch { $open = $false }
    if ($open) { throw "Preview listener remained open: 127.0.0.1:$port" }
  } finally { $socket.Dispose() }
}

# Electron on Windows can retain child process/file mappings briefly after the
# parent PID exits. This is a test-owned *read-only* readiness probe, never a
# replacement for Invoke-ViewerPreviewTransaction's strict Assert-AppUnlocked.
function Wait-ForViewerQuiescence([string]$phase, [int[]]$ports) {
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $nextReport = [DateTime]::MinValue
  $stableSamples = 0
  while ([DateTime]::UtcNow -lt $deadline) {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='UnboundVNCViewer.exe'")
    $owned = @($processes | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $exe })
    # A same-name PID whose executable path cannot be read is ambiguous here.
    # CI owns an isolated runner, so do not silently assume it is unrelated.
    $ambiguous = @($processes | Where-Object { -not $_.ExecutablePath })
    $locked = @()
    if (Test-Path -LiteralPath $app -PathType Container) {
      foreach ($file in @(Get-ChildItem -LiteralPath $app -File -Recurse -Force)) {
        $handle = $null
        try { $handle = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
        catch { $locked += $file.FullName }
        finally { if ($handle) { $handle.Dispose() } }
      }
    }
    $openPorts = @()
    foreach ($port in $ports) {
      if ($port -lt 1 -or $port -gt 65535) { throw "Invalid quiescence loopback port: $port" }
      $socket = [Net.Sockets.TcpClient]::new()
      try {
        $connect = $socket.ConnectAsync('127.0.0.1', $port)
        try { $open = $connect.Wait(250) -and $socket.Connected } catch { $open = $false }
        if ($open) { $openPorts += $port }
      } finally { $socket.Dispose() }
    }
    if ($owned.Count -eq 0 -and $ambiguous.Count -eq 0 -and $locked.Count -eq 0 -and $openPorts.Count -eq 0) {
      $stableSamples++
      if ($stableSamples -ge 3) {
        Write-Host "QUIESCENCE PASS ($phase): three consecutive samples, no same-path Electron descendants, no exclusive file locks, and no owned loopback listeners."
        return
      }
    } else { $stableSamples = 0 }
    $now = [DateTime]::UtcNow
    if ($now -ge $nextReport) {
      $ownedDetails = @($owned | ForEach-Object { "PID=$($_.ProcessId)/PPID=$($_.ParentProcessId)" }) -join ','
      $ambiguousIds = @($ambiguous | ForEach-Object { $_.ProcessId }) -join ','
      Write-Host "QUIESCENCE WAIT ($phase): descendants=[$ownedDetails], ambiguous PIDs=[$ambiguousIds], locked files=$($locked.Count) [$($locked -join ', ')], open ports=[$($openPorts -join ',')]."
      $nextReport = $now.AddSeconds(5)
    }
    Start-Sleep -Milliseconds 350
  }
  throw "Quiescence timed out ($phase): refusing preview uninstall or cleanup while an app file, process or port may remain live."
}

function Test-DeterministicHeldExeQuiescence {
  $ready = Join-Path $root '.owned-exe-lock-fixture-ready'
  # Start-Job is built into the hosted pwsh image; ThreadJob is not installed.
  # Its child pwsh is scoped to this one EXE handle and a bounded test duration.
  $job = Start-Job -ArgumentList @($exe,$ready) -ScriptBlock {
    param([string]$ownedExe,[string]$receipt)
    $ErrorActionPreference = 'Stop'
    $hold = [IO.File]::Open($ownedExe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
      Set-Content -LiteralPath $receipt -Value 'exclusive-EXE-handle-held' -NoNewline
      Start-Sleep -Seconds 3
    } finally { $hold.Dispose() }
  }
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline) {
      if ($job.State -eq 'Failed') { throw 'Held-EXE fixture failed before acquiring its handle.' }
      Start-Sleep -Milliseconds 50
    }
    if (-not (Test-Path -LiteralPath $ready)) { throw 'Held-EXE fixture did not prove its exclusive handle was acquired.' }
    Must-Refuse { & $transaction -Operation PreviewUninstall -SandboxRoot $root } 'deterministic held viewer EXE' "Locked or inaccessible installed file: $exe"
    $start = [DateTime]::UtcNow
    Wait-ForViewerQuiescence 'deterministic 3-second held EXE' @()
    $elapsed = ([DateTime]::UtcNow - $start).TotalMilliseconds
    if ($elapsed -lt 1500) { throw "Quiescence did not wait for the deliberately held EXE handle: $elapsed ms." }
    Write-Host "DETERMINISTIC EXE HANDLE PASS: preview uninstall refused exactly the held EXE, then read-only quiescence waited $([int]$elapsed) ms for its release."
  } finally {
    $done = Wait-Job -Job $job -Timeout 10
    if (-not $done) { Stop-Job -Job $job; throw 'Test-owned held-EXE thread did not finish within ten seconds.' }
    try { $null = Receive-Job -Job $job -ErrorAction Stop }
    finally { Remove-Job -Job $job; if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready } }
  }
}

function Assert-SourceUnchanged([object]$before) {
  $after = @(Get-ChildItem -LiteralPath $source -Recurse -File -Force | Sort-Object FullName)
  if ($before.Count -ne $after.Count) { throw 'Preview transaction changed source payload count.' }
  for ($i=0; $i -lt $after.Count; $i++) {
    $relative = [IO.Path]::GetRelativePath($source, $after[$i].FullName)
    $digest = (Get-FileHash -LiteralPath $after[$i].FullName -Algorithm SHA256).Hash
    if ($before[$i].relative -cne $relative -or $before[$i].sha256 -cne $digest) {
      throw "Preview transaction changed source payload: $relative"
    }
  }
  Write-Host "SOURCE IMMUTABILITY PASS: all $($before.Count) original files retained SHA256."
}

if (Test-Path -LiteralPath $root) { throw 'Refusing pre-existing preview sandbox.' }
$sourceBefore = @(
  Get-ChildItem -LiteralPath $source -Recurse -File -Force | Sort-Object FullName |
    ForEach-Object { [pscustomobject]@{ relative=[IO.Path]::GetRelativePath($source, $_.FullName); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }
)
$ended = $false
try {
  & $transaction -Operation PreviewInstall -SandboxRoot $root
  if (Test-Path -LiteralPath $root) { throw 'PreviewInstall unexpectedly wrote to destination.' }
  Must-Refuse { & $transaction -Operation PreviewInstall -SandboxRoot $runner } 'runner temp cannot be install destination'

  & $transaction -Operation ApplyTest -SandboxRoot $root -InjectCopyFailure
  if (Test-Path -LiteralPath $root) { throw 'Interrupted apply did not roll back all test files.' }
  & $transaction -Operation ApplyTest -SandboxRoot $root
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Preview test apply did not stage launchable EXE.' }
  Must-Refuse { & $transaction -Operation ApplyTest -SandboxRoot $root } 'overwrite of existing test install'
  & $transaction -Operation PreviewUninstall -SandboxRoot $root
  Test-DeterministicHeldExeQuiescence
  & $transaction -Operation PreviewUninstall -SandboxRoot $root

  # Launch the actually installed-like copy with its own fresh profile/receipt path.
  $env:RUNNER_TEMP = $root
  $fixtureReceipt = Join-Path $root 'unboundvnc-viewer-fixture-port.txt'
  $fixture = Start-Process -FilePath 'node.exe' -ArgumentList $fixtureScript -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $fixtureReceipt) -and [DateTime]::UtcNow -lt $deadline) {
    if ($fixture.HasExited) { throw 'Synthetic RFB fixture exited before listening.' }
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $fixtureReceipt)) { throw 'Synthetic fixture did not publish loopback port.' }
  $fixturePort = [int](Get-Content -LiteralPath $fixtureReceipt -Raw)
  $env:UNBOUNDVNC_DESKTOP_CI_SMOKE = '1'
  $env:UNBOUNDVNC_CI_FIXTURE_PORT = [string]$fixturePort
  $viewer = Start-Process -FilePath $exe -PassThru
  if (-not $viewer.WaitForExit(45000) -or $viewer.ExitCode -ne 0) {
    $errorPath = Join-Path $root 'unboundvnc-viewer-smoke-error.txt'
    if (Test-Path -LiteralPath $errorPath) { Write-Host (Get-Content -LiteralPath $errorPath -Raw) }
    throw 'Test-staged Electron viewer failed to launch, render and exit.'
  }
  $smoke = Join-Path $root 'unboundvnc-viewer-desktop-smoke.json'
  if (-not (Test-Path -LiteralPath $smoke) -or -not (Test-Path -LiteralPath $profile -PathType Container)) {
    throw 'No renderer proof or isolated profile from preview-staged executable.'
  }
  $result = Get-Content -LiteralPath $smoke -Raw | ConvertFrom-Json
  if ($result.renderer -ne 'loaded' -or $result.session -ne 'synthetic-rfb-connected') {
    throw 'Actual Electron framebuffer oracle did not complete.'
  }
  $events = Join-Path $root 'unboundvnc-viewer-fixture-protocol.txt'
  if (-not (Test-Path -LiteralPath $events) -or
      -not ((Get-Content -LiteralPath $events -Raw) -match 'RFB_MESSAGE framebuffer-request')) {
    throw 'No actual renderer RFB framebuffer request.'
  }
  if ($fixture -and -not $fixture.HasExited) { $fixture.Kill(); $null=$fixture.WaitForExit(5000) }
  $ownedPorts = @($fixturePort)
  foreach ($uri in @($result.url,$result.gatewayUrl)) {
    $endpoint = [uri]$uri
    if ($endpoint.Host -ne '127.0.0.1' -or $endpoint.Scheme -ne 'http') { throw 'Unexpected viewer listener authority.' }
    $ownedPorts += [int]$endpoint.Port
  }
  Wait-ForViewerQuiescence 'after Electron renderer exit' $ownedPorts
  foreach ($port in $ownedPorts) { Assert-Closed $port }
  Write-Host 'PREVIEW-STAGED RUNTIME PASS: copied unsigned EXE launched with fresh profile; Electron renderer strict 2x2/16 RGBA synthetic RFB oracle, disconnected, exited, and all known loopback ports closed.'
  $env:RUNNER_TEMP = $runner
  Remove-Item Env:UNBOUNDVNC_DESKTOP_CI_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:UNBOUNDVNC_CI_FIXTURE_PORT -ErrorAction SilentlyContinue

  $unknown = Join-Path $app 'unlisted-user-file.txt'
  Set-Content -LiteralPath $unknown -Value 'test-only unknown file' -NoNewline
  Must-Refuse { & $transaction -Operation RemoveTest -SandboxRoot $root } 'unknown installed file must be preserved' 'Unknown, missing, modified or additional application file/directory.'
  if (-not (Test-Path -LiteralPath $unknown)) { throw 'Unknown-file guard changed user file.' }
  Remove-Item -LiteralPath $unknown

  Set-Content -LiteralPath $marker -Value 'wrong-test-owner' -NoNewline
  try { Must-Refuse { & $transaction -Operation RemoveTest -SandboxRoot $root } 'altered ownership marker' 'Preview ownership marker absent or mismatched.' }
  finally { Set-Content -LiteralPath $marker -Value $id -NoNewline }

  $lockedFile = Join-Path $app 'resources/app.asar'
  $held = [IO.File]::Open($lockedFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  try {
    Must-Refuse { & $transaction -Operation RemoveTest -SandboxRoot $root } 'locked app.asar file handle' "Locked or inaccessible installed file: $lockedFile"
  } finally { $held.Dispose() }

  $junctionTarget = Join-Path $root 'owned-junction-target'
  $junctionPath = Join-Path $app 'owned-junction-fixture'
  $null = New-Item -ItemType Directory -Path $junctionTarget
  try {
    $null = New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget
    Must-Refuse { & $transaction -Operation RemoveTest -SandboxRoot $root } 'nested junction under installed app' "Reparse descendant rejected: $junctionPath"
    Write-Host 'PREVIEW REPARSE GUARD PASS: test-owned nested junction refused.'
  } finally {
    if (Test-Path -LiteralPath $junctionPath) { Remove-Item -LiteralPath $junctionPath -Force }
    if (Test-Path -LiteralPath $junctionPath) { throw 'Refusing cleanup while junction remains.' }
    Remove-Item -LiteralPath $junctionTarget -Recurse -Force
  }

  Wait-ForViewerQuiescence 'before rollback and clean removal' @()

  & $transaction -Operation RemoveTest -SandboxRoot $root -InjectRemovalFailure
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Uninstall injection did not restore the installed executable.' }
  & $transaction -Operation PreviewUninstall -SandboxRoot $root
  & $transaction -Operation RemoveTest -SandboxRoot $root
  if ((Test-Path -LiteralPath $app) -or -not (Test-Path -LiteralPath $profile)) {
    throw 'Uninstall failed to remove app while preserving isolated userData.'
  }
  $state = Get-Content -LiteralPath (Join-Path $root '.unboundvnc-viewer-preview-receipt.json') -Raw | ConvertFrom-Json
  if ($state.status -ne 'removed') { throw 'Uninstall did not preserve removed-state receipt.' }
  Must-Refuse { & $transaction -Operation RemoveTest -SandboxRoot $root } 'already removed app must not be removed again'
  Assert-SourceUnchanged $sourceBefore
  $ended = $true
} finally {
  if ($viewer -and -not $viewer.HasExited) { $viewer.Kill(); $null = $viewer.WaitForExit(5000) }
  if ($fixture -and -not $fixture.HasExited) { $fixture.Kill(); $null = $fixture.WaitForExit(5000) }
  $env:RUNNER_TEMP = $runner
  Remove-Item Env:UNBOUNDVNC_DESKTOP_CI_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:UNBOUNDVNC_CI_FIXTURE_PORT -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $root) {
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -cne $id) {
      throw 'Refusing final test cleanup: ownership marker changed.'
    }
    if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Refusing final test cleanup of reparse root.'
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing final test cleanup while descendant reparse remains.'
      }
    }
    if (Test-Path -LiteralPath $app -PathType Container) {
      Wait-ForViewerQuiescence 'before owned test root cleanup' @()
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $root -File -Recurse -Force)) {
      $handle = $null
      try { $handle = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
      catch { throw "Refusing test-root cleanup of locked or inaccessible file: $($file.FullName)" }
      finally { if ($handle) { $handle.Dispose() } }
    }
    Remove-Item -LiteralPath $root -Recurse -Force
  }
  if (Test-Path -LiteralPath $root) { throw 'Final unique test sandbox cleanup failed.' }
  Write-Host 'TEST SANDBOX CLEANUP PASS: isolated userData/profile and receipts deleted solely because fresh GUID-owned CI sandbox was explicitly retired; no user profile affected.'
}
if (-not $ended) { throw 'Preview transaction acceptance did not finish.' }
