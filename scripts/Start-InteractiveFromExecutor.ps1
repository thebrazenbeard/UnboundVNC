# Explicit user-invoked, one-shot session-0 bridge to the currently logged-in desktop.
# Registers a temporary, non-elevated task and unregisters it immediately after startup.
# No unattended screen access: local host still requires Start + Approve.
param([switch]$NoBrowser)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows only.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$childScript = Join-Path $PSScriptRoot 'Start-LocalScreenShare.ps1'
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$interactiveSessions = @(
    Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
        Where-Object { $_.SessionId -gt 0 } |
        ForEach-Object {
            $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
            if (($owner.Domain + '\' + $owner.User) -ieq $currentIdentity) {
                $_.SessionId
            }
        } | Sort-Object -Unique
)
if ($interactiveSessions.Count -ne 1) {
    throw 'Cannot uniquely verify the current account interactive desktop session.'
}
$targetSession = [int]$interactiveSessions[0]
$existing = @(Get-CimInstance Win32_Process -Filter "Name='UnboundVnc.Host.Windows.exe'")
if ($existing.Count -gt 0) {
    throw 'A Windows UnboundVNC host is already running. Refusing duplicate GUI launch.'
}
if (Get-NetTCPConnection -State Listen -LocalPort 5901 -ErrorAction SilentlyContinue) {
    throw 'RFB 5901 already listening. Refusing to proxy an unknown host.'
}
$nonce = [guid]::NewGuid().ToString('N')
$taskName = 'UnboundVNC-TemporaryInteractive-' + $nonce
$marker = Join-Path $env:TEMP ('UnboundVNC-Preview-' + $nonce + '.txt')
$escapedScript = $childScript.Replace("'", "''")
$escapedMarker = $marker.Replace("'", "''")
$option = if ($NoBrowser) { '-NoBrowser' } else { '' }
# The task itself verifies its Windows session. Only the loopback URL is returned.
$payload = '$ErrorActionPreference="Stop"; if((Get-Process -Id $PID).SessionId -ne ' +
    $targetSession + '){exit 71}; & ' + "'" + $escapedScript + "' " + $option +
    ' | ForEach-Object { if([string]$_ -match "^LOCAL_ONLY_VIEWER=(http://127[.]0[.]0[.]1:[0-9]{2,5}/)$"){' +
    '[IO.File]::WriteAllText(' + "'" + $escapedMarker + "'," + '$Matches[1])} }'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -EncodedCommand ' + $encoded)
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$started = $false
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $started = $true
    for ($i=0; $i -lt 160 -and -not (Test-Path -LiteralPath $marker); $i++) {
        Start-Sleep -Milliseconds 250
        $state = (Get-ScheduledTask -TaskName $taskName).State
        if ($state -ne 'Running' -and $i -gt 8) { break }
    }
    if (-not (Test-Path -LiteralPath $marker)) {
        throw 'Interactive preview did not report a viewer URL; do not assume it started.'
    }
    $url = (Get-Content -LiteralPath $marker -Raw).Trim()
    if ($url -notmatch '^http://127[.]0[.]0[.]1:[0-9]{2,5}/$') {
        throw 'Unexpected preview endpoint; refusing receipt.'
    }
    $health = Invoke-RestMethod -Uri ($url + 'api/health') -TimeoutSec 4
    if ($health.remoteAccess -ne $false -or $health.ok -ne $true) {
        throw 'Local-only health policy not verified.'
    }
    Write-Output ('LOCAL_ONLY_VIEWER=' + $url)
    Write-Output ('INTERACTIVE_DESKTOP_SESSION=' + $targetSession)
    Write-Output 'HOST_SHARING_DEFAULT=OFF; each view-only connection requires local human approval'
} finally {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        if (-not (Test-Path -LiteralPath $marker) -and $started) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}