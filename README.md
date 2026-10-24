# claude-code-desktop-account-switcher

在**同一个** Claude Code desktop（或终端）里，让不同的会话用不同的 Claude 订阅账号计费。不用登出、不用重启。

这是 [SmelterLabs/claude-account-switcher](https://github.com/SmelterLabs/claude-account-switcher)（MIT，作者 Casey Russell）的 fork，在它的基础上：

- **输入框上方是一个下拉框 + 用量表**：选账号就切换；下面每个账号一行，5 小时 / 7 天各一条用量条（70% 变黄、90% 变红）、百分比和重置倒计时（`↻2h10m`），按窗口宽度自动收缩，不会被截断；用满的账号在下拉框里标“已满”。可以折叠成一行（“收起”），每 15 秒刷新。
- **用量准、自己刷新**：relay 每 15 分钟（或某个窗口重置之后）给每个账号发一个 1 token 的 haiku 请求，读回复头里的真实用量和“是否已被拒”，没用过的号也有数；窗口账号的用量直接读官方用量接口（和 `/usage` 同一个数）。输入框上方的 **↻** 或 `/account refresh` 立刻全部刷新。
- **撞限额自动换号继续**（默认开，“自动切换 ✓/✗” 或 `/account auto on|off`）：一轮因为额度用完而中断时，换到剩余额度最多的 relay 账号，并自动发一条「继续」接着干；发消息前如果已知当前号满了，就先切再发。**永远不会自动切到窗口账号**；所有 relay 账号都满了就只提示不切；10 分钟内最多自动切 4 次，防止来回跳。
- **subagent 跟着切**：每一个模型请求（主对话和所有 subagent）发出前都重新指向当前账号，切号后正在跑的 subagent 下一个请求就换过去。
- **不会偷偷退回窗口账号**：原版在读 relay 状态失败时会悄悄把整个会话换回 desktop 登录的账号，那个号额度用完就是莫名其妙的 rate limit。现在选了账号就一直走它；relay 真的没响应时请求会重试，输入框上方会提示，并给一个“改用窗口账号”的按钮。
- **查哪些请求绕过了 relay**：`python "$HOME\.claude\account-switcher\scripts\check-routing.py" <会话 id>`，逐条对照会话记录和 relay 日志（主对话 + 每个 subagent）。
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
- The status line reads `💳 billing: WORK` whenever a session is routed. Every model request, main's and every subagent's, is pointed at the chosen account right before it is sent. A chosen account is never swapped for the app's login behind your back: if the relay is not answering, requests keep going to it and retry (the band offers a one-press switch to the app's login); only a name the relay holds no token for falls back, and the status line says so.

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
- In a session: pick an account in the dropdown above the prompt, or `/account`, `/account work`, `/account off`, `/account refresh`, `/account auto on|off`, `/account hide`, `/account show`.
- Auto-switch (on by default): when a turn stops on the usage limit, the session moves to the relay account with the most room left and sends 「继续」; it never moves to the app's own login automatically.
- Renew a token near expiry (the status line warns at 14 days): run add-account for that name again.
- Remove: `scripts\uninstall.ps1` / `scripts/uninstall.sh` (`-PurgeTokens` / `--purge-tokens` to delete the token store too).

## Limits and notes

- A routed session's rate-limit meters (`/account`) are the routed account's. The app's own usage tray still shows the app's login.
- Hooks-module plugins are early access in the terminal CLI: the terminal needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, which `install.sh` sets in `settings.json`. Claude Desktop sets it for its own sessions, so `install.ps1` does not.
- macOS is untested. If you run it there, an issue with the output of `launchctl print gui/$(id -u)/com.claude-account-switcher.relay` is welcome.

## Terms

Every token comes from Anthropic's own `claude setup-token` flow, approved in a browser by the account owner, and every account is that user's own paid Claude subscription. The relay only swaps which of *your* subscriptions a session bills; sharing tokens with other people or machines is outside what this tool is for and may breach Anthropic's terms. Check the terms that apply to your plan before using it.

See `TECHNICAL-GUIDE.md` for the full design, what was tried and rejected, and the evidence; `USER-GUIDE.md` for the plain-language version.
