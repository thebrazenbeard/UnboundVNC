# Real Inno Setup engine, but *only* in a hosted CI-runner-owned disposable folder.
# Deliberately no real LOCALAPPDATA, registry registration, shortcuts, or uploaded installer.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'Native installer experiment refuses user machines and self-hosted runners.'
}

$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\','/')
$guid = [guid]::NewGuid().ToString('N')
$root = Join-Path $runner "unboundvnc-inno-preview-$guid"
$install = Join-Path $root 'User/LocalAppData/Programs/UnboundVNCViewer'
$build = Join-Path $root 'compiler-output'
$source = Join-Path $runner 'unboundvnc-viewer-desktop-check/UnboundVNCViewer-win32-x64'
$fixtureScript = [IO.Path]::GetFullPath('packaging/viewer-windows/tests/ci-rfb-fixture.mjs')
$iss = [IO.Path]::GetFullPath('packaging/viewer-windows/installer-native-preview/UnboundVNCViewer-CI.iss')
$marker = Join-Path $root '.native-ci-owned'
$ownerFile = Join-Path $root '.native-owner-input'
$installedOwner = Join-Path $install '.unboundvnc-ci-installer-owned'
$exe = Join-Path $install 'UnboundVNCViewer.exe'
$fixture = $null
$viewer = $null

function Assert-NoReparse([string]$target) {
  if (-not (Test-Path -LiteralPath $target)) { return }
  foreach($item in @((Get-Item -LiteralPath $target -Force)) + @(Get-ChildItem -LiteralPath $target -Force -Recurse)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing native installer reparse point: $($item.FullName)" }
  }
}

function Get-FileManifest([string]$dir) {
  Assert-NoReparse $dir
  $entries = @{}
  foreach($file in @(Get-ChildItem -LiteralPath $dir -File -Recurse -Force)) {
    $relative = [IO.Path]::GetRelativePath($dir,$file.FullName)
    $entries[$relative] = "$(($file.Length)):$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
  }
  return $entries
}

function Assert-ManifestEqual([hashtable]$expected, [hashtable]$actual) {
  if($expected.Count -eq 0 -or $expected.Count -ne $actual.Count) { throw 'Native installer file inventory count mismatched.' }
  foreach($name in $expected.Keys) {
    if(-not $actual.ContainsKey($name) -or $actual[$name] -cne $expected[$name]) {
      throw "Native installer unknown/missing/modified file: $name"
    }
  }
}

function Must-Refuse([scriptblock]$operation,[string]$case) {
  $refused=$false
  try { & $operation } catch { $refused=$true; Write-Host "EXPECTED INNO PREFLIGHT REFUSAL ($case): $($_.Exception.Message)" }
  if(-not $refused) { throw "Native installer unsafe state accepted: $case" }
}

function Assert-ClosedPort([int]$port) {
  if($port -lt 1 -or $port -gt 65535) { throw 'Invalid listener port.' }
  $socket = [Net.Sockets.TcpClient]::new()
  try {
    $attempt=$socket.ConnectAsync('127.0.0.1',$port)
    try { $open=$attempt.Wait(2000) -and $socket.Connected } catch { $open=$false }
    if($open) { throw "Installed Electron listener stayed open: $port" }
  } finally { $socket.Dispose() }
}

function Get-UninstallKeys {
  $path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  if (-not (Test-Path $path)) { return @() }
  return @(Get-ChildItem $path | ForEach-Object { $_.PSChildName } | Sort-Object)
}

function Assert-SourcePreserved([hashtable]$before) {
  Assert-ManifestEqual $before (Get-FileManifest $source)
}

function Assert-InstallOwned([hashtable]$before) {
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or
      -not (Test-Path -LiteralPath $installedOwner -PathType Leaf) -or
      (Get-Content -LiteralPath $installedOwner -Raw) -cne $guid) {
    throw 'Native Inno install missing actual EXE or exact ownership marker.'
  }
  Assert-NoReparse $install
  $uninstallers = @(Get-ChildItem -LiteralPath $install -Filter 'unins*.exe' -File -Force)
  if ($uninstallers.Count -ne 1) { throw 'Native Inno uninstaller EXE absent or ambiguous.' }
  $installed = Get-FileManifest $install
  foreach($name in $before.Keys) {
    if(-not $installed.ContainsKey($name) -or $installed[$name] -cne $before[$name]) {
      throw "Inno install modified an application file: $name"
    }
    $null=$installed.Remove($name)
  }
  $null=$installed.Remove('.unboundvnc-ci-installer-owned')
  foreach($name in @($installed.Keys)) {
    if($name -notmatch '^unins[0-9]+\.(exe|dat)$') {
      throw "Native Inno install added unknown content: $name"
    }
  }
  if($installed.Count -ne 2) { throw 'Native Inno uninstall metadata is missing or excessive.' }
  foreach($file in @(Get-ChildItem -LiteralPath $install -File -Recurse -Force)) {
    $handle=$null
    try { $handle=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None) }
    catch { throw "Installed file locked/inaccessible: $($file.FullName)" }
    finally { if($handle) { $handle.Dispose() } }
  }
  return $uninstallers[0].FullName
}

if (Test-Path -LiteralPath $root) { throw 'Fresh Inno test root unexpectedly exists.' }
$before = Get-FileManifest $source
$registryBefore = @(Get-UninstallKeys)
try {
  $null=New-Item -ItemType Directory -Path $build -Force
  Set-Content -LiteralPath $marker -Value $guid -NoNewline
  Set-Content -LiteralPath $ownerFile -Value $guid -NoNewline

  $compiler = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
  if(-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Pinned runner Inno Setup 6 compiler unavailable; no unverified download allowed.' }
  Write-Host "HOSTED BUILD TOOL: $(Get-Item -LiteralPath $compiler | Select-Object -ExpandProperty VersionInfo | Select-Object -ExpandProperty ProductVersion)"
  $compilerArgs = @(
    '--no-ide-signtools','--no-signing',
    "--define=CI_Source=$source","--define=CI_Target=$install",
    "--define=CI_Output=$build","--define=CI_OwnerFile=$ownerFile",
    "--define=CI_Guid=$guid",$iss
  )
  & $compiler @compilerArgs
  if($LASTEXITCODE -ne 0) { throw 'CI-only Inno setup compilation failed.' }
  $setup = Join-Path $build 'UnboundVNCViewer-CI-ONLY-Setup.exe'
  if(-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Compiled Inno setup EXE absent.' }
  if((Get-AuthenticodeSignature -LiteralPath $setup).Status -ne 'NotSigned') { throw 'Unexpected signing state of CI-only setup.' }
  Write-Host "HOSTED BUILD ONLY: unsigned Inno setup SHA256=$((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash); no artifact upload."

  # Explicit /DIR override is rejected by Inno PrepareToInstall; adversarial
  # destination remains entirely within this exact test-owned root.
  $override = Join-Path $root 'override-must-remain-empty'
  $denied = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',"/DIR=$override") -PassThru -Wait
  if($denied.ExitCode -eq 0 -or (Test-Path -LiteralPath (Join-Path $override 'UnboundVNCViewer.exe'))) {
    throw 'CI-only Inno setup accepted unsafe /DIR override.'
  }
  Write-Host "NATIVE INSTALL PATH GUARD PASS: /DIR override refused, exit=$($denied.ExitCode)."

  $installed = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-') -PassThru -Wait
  if($installed.ExitCode -ne 0) { throw "Inno native setup exited $($installed.ExitCode)." }
  $uninstaller = Assert-InstallOwned $before
  if((@(Get-UninstallKeys) -join '|') -cne ($registryBefore -join '|')) {
    throw 'Native installer changed current-user Add/Remove Programs keys.'
  }
  Write-Host "NATIVE INSTALL TEST PASS: actual Inno setup engine staged $($before.Count) SHA256-matched Electron files with owned uninstaller, no HKCU ARP delta."

  $secondInstall=Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-') -PassThru -Wait
  if($secondInstall.ExitCode -eq 0) { throw 'Native Inno setup accepted a pre-existing destination.' }
  $null=Assert-InstallOwned $before
  Write-Host "NATIVE INSTALL COLLISION GUARD PASS: second setup refused occupied directory, exit=$($secondInstall.ExitCode); original payload remains intact."

  # Launch actual Inno-installed EXE. Its CI smoke enforces 2x2 16 RGBA
  # framebuffer oracle and returns dashboard after explicit disconnect.
  $env:RUNNER_TEMP=$root
  $fixtureReceipt=Join-Path $root 'unboundvnc-viewer-fixture-port.txt'
  $fixture=Start-Process -FilePath 'node.exe' -ArgumentList $fixtureScript -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while(-not (Test-Path -LiteralPath $fixtureReceipt) -and [DateTime]::UtcNow -lt $deadline) {
    if($fixture.HasExited) { throw 'Synthetic RFB fixture exited before opening loopback.' }
    Start-Sleep -Milliseconds 100
  }
  if(-not (Test-Path -LiteralPath $fixtureReceipt)) { throw 'No synthetic RFB fixture port.' }
  $fixturePort=[int](Get-Content -LiteralPath $fixtureReceipt -Raw)
  $env:UNBOUNDVNC_DESKTOP_CI_SMOKE='1'
  $env:UNBOUNDVNC_CI_FIXTURE_PORT=[string]$fixturePort
  $viewer=Start-Process -FilePath $exe -PassThru
  if(-not $viewer.WaitForExit(45000) -or $viewer.ExitCode -ne 0) {
    $errPath=Join-Path $root 'unboundvnc-viewer-smoke-error.txt'
    if(Test-Path -LiteralPath $errPath) { Write-Host (Get-Content -LiteralPath $errPath -Raw) }
    throw 'Inno-installed Electron EXE did not render and exit successfully.'
  }
  $smoke=Join-Path $root 'unboundvnc-viewer-desktop-smoke.json'
  $profile=Join-Path $root 'unboundvnc-viewer-ci-empty-profile'
  if(-not (Test-Path -LiteralPath $smoke) -or -not (Test-Path -LiteralPath $profile -PathType Container)) { throw 'No renderer receipt or isolated profile.' }
  $result=Get-Content -LiteralPath $smoke -Raw | ConvertFrom-Json
  if($result.renderer -ne 'loaded' -or $result.session -ne 'synthetic-rfb-connected') { throw 'No strict Electron framebuffer oracle receipt.' }
  if($fixture -and -not $fixture.HasExited) { $fixture.Kill(); $null=$fixture.WaitForExit(5000) }
  foreach($uri in @($result.url,$result.gatewayUrl)) {
    $ep=[uri]$uri
    if($ep.Host -ne '127.0.0.1' -or $ep.Scheme -ne 'http') { throw 'Non-loopback installed viewer endpoint.' }
    Assert-ClosedPort ([int]$ep.Port)
  }
  Assert-ClosedPort $fixturePort
  $env:RUNNER_TEMP=$runner
  Remove-Item Env:UNBOUNDVNC_DESKTOP_CI_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:UNBOUNDVNC_CI_FIXTURE_PORT -ErrorAction SilentlyContinue
  Write-Host 'NATIVE INSTALLED RUNTIME PASS: actual Inno-installed Electron EXE, renderer 2x2/16 RGBA RFB fixture, explicit disconnect, process exit and three loopback ports closed.'

  $unknown=Join-Path $install 'unknown-user-data.txt'
  Set-Content -LiteralPath $unknown -Value 'test-owned unknown' -NoNewline
  Must-Refuse { $null=Assert-InstallOwned $before } 'unknown file before uninstall'
  if(-not (Test-Path -LiteralPath $unknown)) { throw 'Ownership preflight removed unknown file.' }
  Remove-Item -LiteralPath $unknown

  $lockedFile=Join-Path $install 'resources/app.asar'
  $held=[IO.File]::Open($lockedFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  try { Must-Refuse { $null=Assert-InstallOwned $before } 'locked installed app.asar' }
  finally { $held.Dispose() }

  $junctionTarget=Join-Path $root 'junction-target-owned'
  $junction=Join-Path $install 'junction-must-be-refused'
  $null=New-Item -ItemType Directory -Path $junctionTarget
  try {
    $null=New-Item -ItemType Junction -Path $junction -Target $junctionTarget
    Must-Refuse { $null=Assert-InstallOwned $before } 'nested junction'
  } finally {
    if(Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction -Force }
    if(Test-Path -LiteralPath $junction) { throw 'Unsafe junction remains before cleanup.' }
    Remove-Item -LiteralPath $junctionTarget -Recurse -Force
  }

  $uninstaller=Assert-InstallOwned $before
  $removed=Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -PassThru -Wait
  if($removed.ExitCode -ne 0) { throw "Native Inno uninstaller returned $($removed.ExitCode)." }
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  while((Test-Path -LiteralPath $install) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if(Test-Path -LiteralPath $install) { throw 'Native Inno uninstall did not remove its installed folder.' }
  if(-not (Test-Path -LiteralPath $profile -PathType Container)) { throw 'Native uninstaller removed separate profile unexpectedly.' }
  if((@(Get-UninstallKeys) -join '|') -cne ($registryBefore -join '|')) { throw 'Uninstaller modified current-user ARP registry keys.' }
  Assert-SourcePreserved $before
  Write-Host "NATIVE UNINSTALL TEST PASS: actual Inno uninstaller removed $($before.Count) app files; separate profile retained; all source SHA256 unchanged; no HKCU ARP delta."
} finally {
  if($viewer -and -not $viewer.HasExited) { $viewer.Kill(); $null=$viewer.WaitForExit(5000) }
  if($fixture -and -not $fixture.HasExited) { $fixture.Kill(); $null=$fixture.WaitForExit(5000) }
  $env:RUNNER_TEMP=$runner
  Remove-Item Env:UNBOUNDVNC_DESKTOP_CI_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:UNBOUNDVNC_CI_FIXTURE_PORT -ErrorAction SilentlyContinue
  if(Test-Path -LiteralPath $root) {
    if(-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Get-Content -LiteralPath $marker -Raw) -cne $guid) {
      throw 'Refusing test-root cleanup of missing/altered marker.'
    }
    Assert-NoReparse $root
    Remove-Item -LiteralPath $root -Recurse -Force
  }
  if(Test-Path -LiteralPath $root) { throw 'Native test-only root cleanup failed.' }
  Write-Host 'TEST SANDBOX CLEANUP PASS: compiled unsigned setup, installed copy, preserved test-only profile and receipts all deleted from GUID-owned RUNNER_TEMP; no artifact upload.'
}
