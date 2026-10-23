# claude-code-desktop-account-switcher

在**同一个** Claude Code desktop（或终端）里，让不同的会话用不同的 Claude 订阅账号计费。不用登出、不用重启。

这是 [SmelterLabs/claude-account-switcher](https://github.com/SmelterLabs/claude-account-switcher)（MIT，作者 Casey Russell）的 fork，在它的基础上：

- **输入框上方是一个下拉框**：选账号就切换，每个账号后面带着它最近的 5 小时 / 7 天用量；旁边一行是当前账号的用量和重置倒计时（`↻3小时`）。每 15 秒刷新一次。
- **relay 加固**：只接受本机 Claude Code 的请求（检查 `Host`，拒绝带 `Origin` / `Sec-Fetch-*` 的浏览器请求，防 DNS rebinding 借用额度），账号名和请求体大小也做了检查。
- **Windows 安装修好了**：`settings.json` 用 Python 读写（UTF-8、不加 BOM，原来的 PowerShell 写法会加 BOM、读中文会乱码）；存 token 的目录只有当前用户能读；`add-account.ps1` 能找到 npm 装的 `claude.cmd`；安装脚本能通过 `py` 启动器找到 Python，并跳过 Store 的假 `python`。

## 在另一台 Windows 电脑上安装

先准备：Claude Code desktop（或 `claude` 命令行）、[Python 3.8+](https://www.python.org/downloads/)（python.org 的安装包，不是 Microsoft Store 版）、Git。

在 PowerShell 里运行：

```powershell
git clone https://github.com/2deng-bowen/claude-code-desktop-account-switcher "$HOME\.claude\account-switcher-src"
powershell -ExecutionPolicy Bypass -File "$HOME\.claude\account-switcher-src\scripts\install.ps1"
```

然后每个想用的账号加一次（会打开浏览器，用**那个账号**登录并批准）：

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\.claude\account-switcher\scripts\add-account.ps1" -Name work
```

装好后新开一个 Claude Code 会话（已经开着的会话输入 `/reload-plugins`），输入框上方就有账号下拉框。也可以直接把这个仓库链接发给那台电脑上的 Claude Code，让它按这一节装。

- **token 每台电脑单独加**，不要把 `tokens.json` 传到网上或给别人。
- 更新：`git -C "$HOME\.claude\account-switcher-src" pull`，再跑一次 `install.ps1`，然后 `/reload-plugins`。
- 卸载：`powershell -ExecutionPolicy Bypass -File "$HOME\.claude\account-switcher\scripts\uninstall.ps1"`（加 `-PurgeTokens` 连 token 一起删）。
- `add-account` 停在 `Waiting...` 超过 10 秒：先在那个窗口按一下 Esc（Windows 控制台被点中会进入“选择”模式而暂停），再不行就关掉重跑。

---

*Original README (upstream), with the band and install URLs updated for this fork:*

Bill a Claude Code session to a different Claude subscription, per project or on demand, inside **one** Claude Desktop app or one terminal. No logout, no restart, no second copy of the app.

- A project folder with `.claude/account` containing `work` bills every session opened there to the account named `work`.
- A band above the prompt holds a dropdown: the app's own login and every account that has a token, each with its last 5-hour / 7-day usage. A pick switches the current session from its next message; beside it, the chosen account's usage and when each window resets; `hide` puts the band away (remembered; `/account show` brings it back).
- `/account <name>` does the same by keyboard; `/account off` returns to the app's own login; `/account` shows status, token expiry and each account's real usage meters.
- The status line reads `💳 billing: WORK` whenever a session is routed. If the relay is down or has no token for the name, the session stays on the app's login and the status line says so.

| Platform | Installer | Service | Status |
|---|---|---|---|
| Windows | `scripts\install.ps1` | per-user scheduled task `ClaudeAccountRelay` | in daily use with Claude Desktop |
| Linux | `scripts/install.sh` | `systemd --user` unit `claude-account-relay.service` | tested end to end (Pop!_OS 24.04, Claude Code 2.1.281) |
| macOS | `scripts/install.sh` | LaunchAgent `com.claude-account-switcher.relay` | **untested**: written to the launchd docs and shellcheck-clean, but no Mac was available |

On Linux there is no Claude Desktop app, so the switcher there applies to terminal Claude Code only. On Windows and macOS it covers both the Desktop app's Code sessions and the terminal.

## How it works

Claude Desktop hands every Code session a login ticket for the account the app is signed into, and the engine keeps that ticket in memory, so environment tricks do not change it. What the engine *does* read per request is where to send the request (`ANTHROPIC_BASE_URL`). This project uses that:

1. **Relay** (`relay/relay.py`): a loopback-only HTTP relay on `127.0.0.1:48620`. A request to `/acct/<name>/v1/...` is forwarded to `api.anthropic.com/v1/...` with the Authorization header replaced by `<name>`'s long-lived token. Responses stream back unchanged. It never logs a token.
2. **Plugin** (`plugin/`): a Claude Code hooks module that, when a marker or `/account` names an account, points the session at the relay path for that account and keeps the status line honest. It never reads a token; it learns which accounts exist, when their tokens expire and what their usage meters say from the relay's heartbeat file.
3. **Tokens** (`~/.claude/account-switcher/tokens.json`): one long-lived token per account from `claude setup-token` (one browser approval, valid one year, model requests only). Same protection level as Claude Code's own `.credentials.json`.

What stays on the app's own login: everything the app does itself (its panes, artifacts, scheduled tasks) and, inside a routed session, the claude.ai connector list, cloud routines and Remote Control, because the swapped ticket is model-only by design.

## Install

Requirements: Claude Code 2.1.280 or later (for `CLAUDE_CODE_PLUGIN_DIRS`), Python 3.8 or later (standard library only), and a Claude Pro/Max/Team/Enterprise subscription for every account you add.

### Windows (current user)

```powershell
git clone https://github.com/2deng-bowen/claude-code-desktop-account-switcher.git claude-account-switcher
.\claude-account-switcher\scripts\install.ps1
.\claude-account-switcher\scripts\add-account.ps1 -Name work     # browser opens: sign in as that account, approve
```

`install.ps1` copies the plugin and relay to `~/.claude/account-switcher`, adds `CLAUDE_CODE_PLUGIN_DIRS` to the `env` block of `~/.claude/settings.json` (backup kept), registers the per-user scheduled task `ClaudeAccountRelay` (starts at logon, 5-minute self-recovery) and starts it. Finds `pythonw.exe` in the default python.org location, through the `py` launcher, or on the PATH (never the WindowsApps Store stub), and needs Python 3.8 or later.

### Linux (tested) and macOS (untested)

```bash
git clone https://github.com/2deng-bowen/claude-code-desktop-account-switcher.git claude-account-switcher
./claude-account-switcher/scripts/install.sh
./claude-account-switcher/scripts/add-account.sh work        # browser opens or a sign-in URL is shown; approve
```

`install.sh` copies the plugin and relay to `~/.claude/account-switcher` (mode 700), adds `CLAUDE_CODE_PLUGIN_DIRS` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` to the `env` block of `~/.claude/settings.json` (backup kept), registers the relay as a per-user service that starts at login and restarts on failure, starts it and checks the heartbeat:

- Linux: `~/.config/systemd/user/claude-account-relay.service`, enabled for `default.target`. On a headless box that should relay without anyone logged in, run `loginctl enable-linger $USER` once.
- macOS: `~/Library/LaunchAgents/com.claude-account-switcher.relay.plist`, loaded with `launchctl bootstrap gui/<uid>` (falls back to `launchctl load -w`). Python 3 from Homebrew or python.org is preferred over the Xcode stub.

`add-account.sh` runs `claude setup-token` inside a pseudo-terminal (it prints nothing without one), passes your keystrokes through in case Claude Code asks you to paste a code, shows its screen with the token masked, and writes the token straight into `tokens.json` (mode 600).

Open a new Claude Code session afterwards; existing sessions do not load the plugin.

## Use

- Put `.claude/account` with the account name in any project that should bill another account.
- In a session: pick an account in the dropdown above the prompt, or `/account`, `/account work`, `/account off`, `/account hide`, `/account show`.
- Renew a token near expiry (the status line warns at 14 days): run add-account for that name again.
- Remove: `scripts\uninstall.ps1` / `scripts/uninstall.sh` (`-PurgeTokens` / `--purge-tokens` to delete the token store too).

## Limits and notes

- A routed session's rate-limit meters (`/account`) are the routed account's. The app's own usage tray still shows the app's login.
- Hooks-module plugins are early access in the terminal CLI: the terminal needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, which `install.sh` sets in `settings.json`. Claude Desktop sets it for its own sessions, so `install.ps1` does not.
- macOS is untested. If you run it there, an issue with the output of `launchctl print gui/$(id -u)/com.claude-account-switcher.relay` is welcome.

## Terms

Every token comes from Anthropic's own `claude setup-token` flow, approved in a browser by the account owner, and every account is that user's own paid Claude subscription. The relay only swaps which of *your* subscriptions a session bills; sharing tokens with other people or machines is outside what this tool is for and may breach Anthropic's terms. Check the terms that apply to your plan before using it.

See `TECHNICAL-GUIDE.md` for the full design, what was tried and rejected, and the evidence; `USER-GUIDE.md` for the plain-language version.
