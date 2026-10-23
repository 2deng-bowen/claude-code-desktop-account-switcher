// account-switcher — bill a Claude Code session to a different Claude subscription.
//
// How it works: the relay (relay.py, loopback only) rewrites the Authorization header for the
// account named in the request path. This plugin points the session's API traffic at
// http://127.0.0.1:48620/acct/<name>, chosen by the project's `.claude/account` marker, by
// `/account <name>` in the session, or by the dropdown in the band above the prompt. The desktop
// app keeps its own login; only this session's model requests change accounts. Fails open:
// relay down or no token → the session stays on the window's account and the status line says
// so. The plugin never reads or logs a token; expiry dates and usage come from the relay's
// heartbeat file, and the window login's usage from the session's own rate-limit readings.

import { atom, read, update } from "claude-code";
import type { Billing, Usage, UsageMap } from "../types";

const RELAY = "http://127.0.0.1:48620";
const STALE_S = 30;
const WARN_DAYS = 14;
const REFRESH_MS = 15_000;
const HIDDEN_KEY = "band.hidden"; // $.store: the hide choice outlives the session
const WINDOW_USAGE_KEY = "usage.window"; // $.store: the window login's last reading outlives the session
const WINDOW = "__window"; // the dropdown's value (and usage key) for the window's own login

type Heartbeat = { port: number; pid: number; at: number; accounts: string[]; expires?: Record<string, string>; usage?: Record<string, Usage> };
type RateLimit = { kind: string; percentUsed: number; resetsAt?: string };

// What the band draws from. Held by the host, so a hot reload keeps the chosen account.
const billing = atom({ plugin: "account-switcher", key: "billing" } as const, {
  account: null, source: null, accounts: [], relayUp: false, host: null,
} as Billing);
const isHidden = atom({ plugin: "account-switcher", key: "isHidden" } as const, false);
const usage = atom({ plugin: "account-switcher", key: "usage" } as const, {} as UsageMap);

let store = "";
let hb: Heartbeat | null = null;
let warned = false;
let routedTo: string | null = null; // where this session's requests go now; null = the window login

// ---- usage figures --------------------------------------------------------------------------

// Rounded from tenths so 0.575 (57.4999… in floating point) shows as 58%, as the API's 57.5 would.
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(Math.round(v * 1000) / 10)}%`);

// "3小时" until an epoch-seconds reset.
function until(s: number | null): string {
  if (!s) return "";
  const m = Math.max(0, Math.round((s * 1000 - Date.now()) / 60000));
  return m < 60 ? `${m}分钟` : m < 1440 ? `${Math.round(m / 60)}小时` : `${Math.round(m / 1440)}天`;
}

// For a dropdown option: both windows' percentages.
function brief(u?: Usage): string {
  return u ? ` · 5h ${pct(u.h5)} · 7d ${pct(u.d7)}` : "";
}

// Beside the dropdown: the chosen account's windows with their resets, and the reading's age once old.
function detail(u?: Usage): string {
  if (!u) return "暂无用量（回过一条消息后出现）";
  const win = (label: string, v: number | null, reset: number | null) => `${label} ${pct(v)}${reset ? ` ↻${until(reset)}` : ""}`;
  const age = Math.round((Date.now() / 1000 - u.at) / 60);
  return `${win("5h", u.h5, u.h5_reset)} · ${win("7d", u.d7, u.d7_reset)}${age >= 10 ? ` · ${age}分钟前` : ""}`;
}

// The session's own rate-limit readings (percent, ISO resets) in the relay's shape.
function fromRateLimits(rls: readonly RateLimit[]): Usage | null {
  const h5 = rls.find((r) => r.kind === "five_hour"), d7 = rls.find((r) => r.kind === "seven_day");
  if (!h5 && !d7) return null;
  const sec = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.round(t / 1000) : null; };
  return {
    at: Date.now() / 1000,
    h5: h5 ? h5.percentUsed / 100 : null, h5_reset: sec(h5?.resetsAt),
    d7: d7 ? d7.percentUsed / 100 : null, d7_reset: sec(d7?.resetsAt),
  };
}

// Fold the heartbeat's readings, the stored window reading and any fresh ones into the band's
// map, newest reading per account winning; writes (and so redraws) only on a change.
async function refreshUsage($: any, fresh: Record<string, Usage> = {}): Promise<void> {
  const cur = await read($, usage);
  const merged: UsageMap = { ...cur };
  const put = (k: string, u?: Usage | null) => { if (u && typeof u.at === "number" && (!merged[k] || merged[k].at < u.at)) merged[k] = u; };
  for (const [k, u] of Object.entries(hb?.usage ?? {})) put(k, u);
  put(WINDOW, (await $.store.get(WINDOW_USAGE_KEY)) as Usage | undefined);
  for (const [k, u] of Object.entries(fresh)) put(k, u);
  if (JSON.stringify(merged) !== JSON.stringify(cur)) await update($, usage, () => merged);
}

// ---- routing --------------------------------------------------------------------------------

function dir(p: string): string { return p.replace(/[\\/][^\\/]+[\\/]?$/, ""); }

async function readHeartbeat($: any): Promise<Heartbeat | null> {
  try {
    const f = `${store}/relay.alive`;
    if (!(await $.fs.exists(f))) return null;
    const h = JSON.parse(await $.fs.read(f)) as Heartbeat;
    return (Date.now() / 1000 - Number(h.at ?? 0)) < STALE_S ? h : null;
  } catch { return null; }
}

async function readMarker($: any): Promise<string | null> {
  for (const base of [await $.session.cwd(), await $.session.root()]) {
    const f = `${base}/.claude/account`;
    if (await $.fs.exists(f)) {
      const v = (await $.fs.read(f)).trim().toLowerCase();
      if (v) return v;
    }
  }
  return null;
}

function daysLeft(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : null;
}

// Point the session's API traffic where the chosen account says, update the band's state and
// the status line, and return the one-line summary. Never called while drawing.
async function apply($: any, account: string | null, source: Billing["source"]): Promise<string> {
  const b = await read($, billing);
  const host = b.host ?? { baseUrl: await $.env.get("ANTHROPIC_BASE_URL") };
  hb = await readHeartbeat($);
  const accounts = hb?.accounts ?? [];
  const set = (patch: Partial<Billing>) => update($, billing, (cur) => ({ ...cur, host, accounts, relayUp: !!hb, ...patch }));
  await refreshUsage($);

  if (!account) {
    await $.env.set("ANTHROPIC_BASE_URL", host.baseUrl);
    routedTo = null;
    await set({ account: null, source: null });
    $.ui.status(undefined);
    return "billing: window account";
  }
  const label = account.toUpperCase();
  if (!hb) {
    await $.env.set("ANTHROPIC_BASE_URL", host.baseUrl);
    routedTo = null;
    await set({ account, source });
    const s = `⚠ ${label}: relay down · billing window account`;
    $.ui.status(s); return s;
  }
  if (!accounts.includes(account)) {
    await $.env.set("ANTHROPIC_BASE_URL", host.baseUrl);
    routedTo = null;
    await set({ account, source });
    const s = `⚠ ${label}: no token · billing window account`;
    $.ui.status(s); return s;
  }
  await $.env.set("ANTHROPIC_BASE_URL", `${RELAY}/acct/${account}`);
  routedTo = account;
  await set({ account, source });
  const left = daysLeft(hb.expires?.[account]);
  let s = `💳 billing: ${label}`;
  if (left !== null && left <= WARN_DAYS) {
    s += ` ⚠ token expires in ${left}d`;
    if (!warned) { warned = true; $.ui.toast(`account-switcher: the ${label} token expires in ${left} days — run the add-account script for ${account} again`); }
  }
  $.ui.status(s);
  return s;
}

async function reapply($: any): Promise<string> {
  const b = await read($, billing);
  return apply($, b.account, b.source);
}

// The timer's tick: re-read the heartbeat; re-route only when the relay came up, went down or
// changed its accounts, otherwise just refresh the usage figures.
async function tick($: any): Promise<void> {
  const before = JSON.stringify([!!hb, hb?.accounts ?? []]);
  hb = await readHeartbeat($);
  if (JSON.stringify([!!hb, hb?.accounts ?? []]) !== before) await reapply($);
  else await refreshUsage($);
}

async function setHidden($: any, hidden: boolean): Promise<void> {
  await update($, isHidden, () => hidden);
  await $.store.set(HIDDEN_KEY, hidden);
}

export function register(on: any) {
  on("session.start", async ($: any, e: any, next: any) => {
    store = dir($.plugin.root);
    const hidden = (await $.store.get(HIDDEN_KEY)) === true;
    await update($, isHidden, () => hidden);
    const b = await read($, billing);
    if (b.account || b.host) {
      await apply($, b.account, b.source);            // a reload: keep what this session chose
    } else {
      const m = await readMarker($);
      await apply($, m, m ? "marker" : null);
    }
    await $.command.register({
      name: "account",
      description: "Bill this session to another Claude account (via the account-switcher relay)",
      argumentHint: "[name | off | status | show | hide]",
    });
    $.clock.every(REFRESH_MS, () => { tick($).catch(() => {}); });
    return next(e);
  });

  on("turn.start", async ($: any, e: any, next: any) => { await reapply($); return next(e); });
  on("prompt.submit", async ($: any, e: any, next: any) => { await reapply($); return next(e); });

  // After each main-thread turn, keep the rate-limit windows the last reply reported, under the
  // account that served it; the window login's reading is also stored for later sessions.
  on("turn.complete", async ($: any, e: any, next: any) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      try {
        const u = fromRateLimits((await $.session.usage()).rateLimits ?? []);
        if (u) {
          const k = routedTo ?? WINDOW;
          if (k === WINDOW) await $.store.set(WINDOW_USAGE_KEY, u);
          await refreshUsage($, { [k]: u });
        }
      } catch { /* usage is a nicety: never fail a turn over it */ }
    }
    return result;
  });

  // The band above the prompt: a dropdown of the window login and every account the relay holds
  // a token for (each with its last usage), the chosen one's usage beside it, and a hide button
  // (remembered across sessions; `/account show` brings it back).
  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: any) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e);
    const b = await read($, billing);
    const u = await read($, usage);
    const { Box, Button, Select, Text } = $.ui.resolve(e);
    const hide = <Button key="hide" label="隐藏" dimColor role="dismiss" onPress={() => setHidden($, true)} />;
    if (!b.relayUp) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text>💳 窗口账号</Text>
          <Text dimColor>relay down</Text>
          {hide}
        </Box>
      );
    }
    const options = [
      { value: WINDOW, label: `窗口账号${brief(u[WINDOW])}` },
      ...b.accounts.map((name) => ({ value: name, label: `${name}${brief(u[name])}` })),
    ];
    if (b.account && !b.accounts.includes(b.account)) options.push({ value: b.account, label: `${b.account}（无 token）` });
    const choose = async (value: string) => {
      const name = value === WINDOW ? null : value;
      const s = await apply($, name, name ? "button" : null);
      $.ui.toast(`account-switcher: ${s} — from the next message on`);
    };
    return (
      <Box flexDirection="row" gap={1}>
        <Select key="acct" label="💳" options={options} value={b.account ?? WINDOW} onSelect={choose} />
        <Text dimColor>{detail(u[b.account ?? WINDOW])}</Text>
        {hide}
      </Box>
    );
  });

  on("command.run", { command: "account" }, async ($: any, e: any) => {
    const arg = (e.args ?? "").trim().toLowerCase();
    hb = await readHeartbeat($);
    await refreshUsage($);
    const known = hb?.accounts ?? [];
    const b = await read($, billing);
    if (!arg || arg === "status") {
      const u = await read($, usage);
      const lines = [
        b.account ? `This session bills: ${b.account.toUpperCase()} (${b.source})` : "This session bills: the window's own account",
        hb ? `Relay: up (pid ${hb.pid}, port ${hb.port}); accounts with tokens: ${known.join(", ") || "none"}` : "Relay: DOWN — sessions fall back to the window's account",
      ];
      for (const n of known) { const d = daysLeft(hb?.expires?.[n]); if (d !== null) lines.push(`  ${n}: token expires in ${d} days`); }
      for (const n of [WINDOW, ...known]) if (u[n]) lines.push(`  ${n === WINDOW ? "window account" : n} usage: ${detail(u[n])}`);
      lines.push(`Band above the prompt: ${(await read($, isHidden)) ? "hidden (/account show)" : "shown (/account hide)"}`);
      lines.push("Usage: /account <name> · /account off · marker file .claude/account in a project");
      return { text: lines.join("\n") };
    }
    if (arg === "show" || arg === "hide") {
      await setHidden($, arg === "hide");
      return { text: arg === "hide" ? "Band hidden in every session; /account show brings it back." : "Band shown above the prompt." };
    }
    if (arg === "off") {
      return { text: await apply($, null, null) };
    }
    if (!known.includes(arg)) {
      return { text: hb ? `No token for '${arg}'. Known: ${known.join(", ") || "none"}. Add one with scripts/add-account.ps1 -Name ${arg} (Windows) or scripts/add-account.sh ${arg} (macOS/Linux)` : "Relay is down; start it (Windows: scheduled task ClaudeAccountRelay · Linux: systemctl --user start claude-account-relay · macOS: launchctl kickstart gui/$(id -u)/com.claude-account-switcher.relay) and try again." };
    }
    return { text: `${await apply($, arg, "command")} — from the next message on` };
  });
}
