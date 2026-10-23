# Installs claude-account-switcher for the current Windows user:
#   1. copies the plugin and the relay into ~/.claude/account-switcher
#   2. adds CLAUDE_CODE_PLUGIN_DIRS to the env block of ~/.claude/settings.json (backup kept)
#   3. registers the per-user scheduled task ClaudeAccountRelay (starts at logon, self-recovers)
#   4. starts the relay now and verifies its heartbeat
# Idempotent: re-run after pulling a new version.
param(
  [string]$Store = (Join-Path $HOME '.claude\account-switcher'),
  [string]$Settings = (Join-Path $HOME '.claude\settings.json'),
  [string]$Python = (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\pythonw.exe')
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# Find pythonw.exe: the given path, then the py launcher's Python 3, then PATH. The WindowsApps
# "python" aliases are Store stubs (they open the Store when no Python is installed), so skip them.
if (-not (Test-Path $Python)) {
  $Python = $null
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $exe = & py -3 -c "import sys; print(sys.executable)" 2>$null
    if ($exe) { $w = Join-Path (Split-Path -Parent $exe) 'pythonw.exe'; if (Test-Path $w) { $Python = $w } }
  }
  if (-not $Python) {
    $Python = Get-Command pythonw -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch '\\WindowsApps\\' } |
      Select-Object -First 1 -ExpandProperty Source
  }
}
if (-not $Python) { throw "pythonw.exe not found; install Python 3.8+ from python.org (not the Store alias) and re-run" }
$PythonCli = Join-Path (Split-Path -Parent $Python) 'python.exe'
if (-not (Test-Path $PythonCli)) { throw "python.exe not found beside $Python" }
& $PythonCli -I -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"
if ($LASTEXITCODE -ne 0) { throw "$PythonCli is older than Python 3.8" }
Write-Host "Using $Python"

# 1. files
New-Item -ItemType Directory -Force "$Store\plugin", "$Store\scripts" | Out-Null
Copy-Item "$repo\plugin\*" "$Store\plugin" -Recurse -Force
Copy-Item "$repo\relay\relay.py" "$Store\relay.py" -Force
Copy-Item "$repo\scripts\*" "$Store\scripts" -Force
# Only this user (and SYSTEM) may read the store: tokens.json lives here.
& icacls $Store /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Store" }
& icacls "$Store\*" /reset /T /Q | Out-Null   # children inherit exactly the store's ACL
if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed under $Store" }
Write-Host "Installed files into $Store (access limited to $env:USERNAME)"

# 2. settings.json env (keeps every other key; one timestamped backup). Python edits it: UTF-8 in and
#    out with no BOM, which Windows PowerShell's Get-Content / Set-Content -Encoding utf8 can't promise.
if (Test-Path $Settings) { Copy-Item $Settings "$Settings.bak-account-switcher-$(Get-Date -Format yyyyMMdd-HHmmss)" }
$pluginDir = "$Store\plugin"
& $PythonCli -I "$repo\scripts\settings_env.py" add $Settings $pluginDir | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not update $Settings" }
$check = & $PythonCli -I -c "import json,sys; print(json.load(open(sys.argv[1],encoding='utf-8'))['env']['CLAUDE_CODE_PLUGIN_DIRS'])" $Settings
if ($check -notmatch [regex]::Escape($pluginDir)) { throw "settings.json did not take CLAUDE_CODE_PLUGIN_DIRS" }
Write-Host "settings.json env.CLAUDE_CODE_PLUGIN_DIRS = $check"

# 3. scheduled task (logon + 5-minute recovery; a second start exits at once because the port is held)
$taskName = 'ClaudeAccountRelay'
$action = New-ScheduledTaskAction -Execute $Python -Argument "`"$Store\relay.py`"" -WorkingDirectory $Store
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$recover = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $recover) -Settings $taskSettings -Principal $principal -Force | Out-Null
Write-Host "Registered scheduled task $taskName"

# 4. start now and verify the heartbeat (stop a hand-started relay first, by pid file)
# The running relay's pid is in its heartbeat (relay.py writes no pid file): stop it so an update's
# relay.py takes over. The heartbeat file stays: while it is fresh, open sessions keep their route
# through the restart (a request in the gap is retried) instead of falling back to the window login.
# The check below waits for a heartbeat from a different process.
$aliveFile = "$Store\relay.alive"
$oldPid = $null
if (Test-Path $aliveFile) {
  try { $prev = Get-Content $aliveFile -Raw | ConvertFrom-Json; $old = Get-Process -Id $prev.pid -ErrorAction SilentlyContinue } catch { $old = $null }
  if ($old -and $old.ProcessName -match '^python') { $oldPid = $old.Id; Stop-Process -Id $old.Id -Force; Start-Sleep -Milliseconds 300 }
}
Start-ScheduledTask -TaskName $taskName
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Test-Path $aliveFile)) { continue }
  try { $hb = Get-Content $aliveFile -Raw | ConvertFrom-Json } catch { continue }
  if ($hb.pid -ne $oldPid -and ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $hb.at) -lt 30) { $ok = $true; break }
}
if (-not $ok) { throw "relay did not start (no fresh heartbeat in $Store\relay.alive)" }
Write-Host "Relay running: pid $($hb.pid), port $($hb.port), accounts: $($hb.accounts -join ', ')"
Write-Host "Done. Add accounts with scripts\add-account.ps1 -Name <name>; open a new Claude Code session, or type /reload-plugins in an open one, to load the plugin."
