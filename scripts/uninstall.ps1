# Removes the scheduled task and the settings.json entry. Tokens are kept unless -PurgeTokens.
param(
  [string]$Store = (Join-Path $HOME '.claude\account-switcher'),
  [string]$Settings = (Join-Path $HOME '.claude\settings.json'),
  [switch]$PurgeTokens
)
$ErrorActionPreference = 'Continue'
Unregister-ScheduledTask -TaskName 'ClaudeAccountRelay' -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path "$Store\relay.alive") { $hb = Get-Content "$Store\relay.alive" -Raw | ConvertFrom-Json; $p = Get-Process -Id $hb.pid -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match '^python') { Stop-Process -Id $p.Id -Force } }
if (Test-Path $Settings) {
  $py = (Get-Command python -ErrorAction SilentlyContinue).Source
  $helper = Join-Path $PSScriptRoot 'settings_env.py'
  if ($py -and (Test-Path $helper)) { & $py -I $helper remove $Settings | Out-Null }
  else { Write-Warning "python or settings_env.py not found: remove env.CLAUDE_CODE_PLUGIN_DIRS from $Settings by hand" }
}
Remove-Item "$Store\plugin" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Store\relay.py", "$Store\relay.alive", "$Store\relay.pid" -Force -ErrorAction SilentlyContinue
if ($PurgeTokens) { Remove-Item "$Store\tokens.json" -Force -ErrorAction SilentlyContinue }
Write-Host "Uninstalled. Tokens $(if ($PurgeTokens) {'removed'} else {'kept in ' + $Store})."
