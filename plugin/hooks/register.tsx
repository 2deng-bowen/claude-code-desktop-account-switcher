// account-switcher — bill a Claude Code session to a different Claude subscription.
//
// How it works: the relay (relay.py, loopback only) rewrites the Authorization header for the
// account named in the request path. This plugin points the session's API traffic at
// http://127.0.0.1:48620/acct/<name>, chosen by the project's `.claude/account` marker, by
// `/account <name>` in the session, or by the dropdown in the band above the prompt, and points
// it again before every model request (`turn.step`), main's and every subagent's, so subagents
// follow a switch made while they run. The desktop app keeps its own login; only this session's
// model requests change accounts. A chosen account is never swapped for the window login behind
// the person's back: with the relay not answering, requests keep going to it (and retry); only
// an account the relay holds no token for falls back, and the status line says so. The plugin
// never reads or logs a token; expiry dates and usage come from the relay's heartbeat file (the
// relay probes every account itself, used or not), and the window login's usage from the API's
// own usage endpoint (through `$.session.authorize`) or the session's rate-limit readings.
//
// Auto-switch (on by default, "自动" in the band, `/account auto on|off`): when a turn dies on the
// usage limit, the session moves to the relay account with the most room left (never the window
// login) and sends "继续" so the work goes on; and a turn about to start on an account already
// known to be refused moves first.

import { atom, read, update } from "claude-code";
import type { Billing, Usage, UsageMap } from "../types";

const RELAY = "http://127.0.0.1:48620";
const STALE_S = 30;
const WARN_DAYS = 14;
const REFRESH_MS = 15_000;
const OLD_S = 3600; // a usage reading older than this draws dimmed
const HIDDEN_KEY = "band.hidden"; // $.store: the hide choice outlives the session
const COLLAPSED_KEY = "band.collapsed"; // $.store: so does folding the usage table away
const WINDOW_USAGE_KEY = "usage.window"; // $.store: the window login's last reading outlives the session
const WINDOW = "__window"; // the dropdown's value (and usage key) for the window's own login
const WINDOW_NAME = "窗口账号";
const AUTO_KEY = "auto.switch"; // $.store: auto-switch on a usage limit, on unless turned off
const CONTINUE_TEXT = "继续";
const AUTO_MAX = 4; // at most this many automatic switches ...
const AUTO_SPAN_MS = 10 * 60_000; // ... within this span, so a refusal on every account cannot loop
const USAGE_API = "https://api.anthropic.com/api/oauth/usage";

type Heartbeat = { port: number; pid: number; at: number; accounts: string[]; expires?: Record<string, string>; usage?: Record<string, Usage> };
type RateLimit = { kind: string; percentUsed: number; resetsAt?: string };

// What the band draws from. Held by the host, so a hot reload keeps the chosen account.
const billing = atom({ plugin: "account-switcher", key: "billing" } as const, {
  account: null, source: null, accounts: [], relayUp: false, host: null,
} as Billing);
const isHidden = atom({ plugin: "account-switcher", key: "isHidden" } as const, false);
const isCollapsed = atom({ plugin: "account-switcher", key: "isCollapsed" } as const, false);
const usage = atom({ plugin: "account-switcher", key: "usage" } as const, {} as UsageMap);
const autoSwitch = atom({ plugin: "account-switcher", key: "autoSwitch" } as const, true);

let store = "";
let hb: Heartbeat | null = null;
let warned = false;
let routedTo: string | null = null; // where this session's requests go now; null = the window login
let autoTimes: number[] = []; // when the recent automatic switches happened
let pendingContinue = false; // an automatic switch is waiting to send CONTINUE_TEXT
const CONTINUE_DELAY_MS = 3000;

function sendContinue($: any): void {
  if (!pendingContinue) return;
  pendingContinue = false;
  $.prompt.submit({ text: CONTINUE_TEXT }).catch(() => {});
}

// ---- usage figures --------------------------------------------------------------------------

// One rate-limit window as drawn: its percent, its reset, and whether it is full, already reset
// (the reading predates the reset, so its percent no longer holds) or never read.
type Win = { pct: number | null; reset: number | null; state: "ok" | "full" | "reset" | "none" };

function win(v: number | null, reset: number | null): Win {
  if (v === null) return { pct: null, reset: null, state: "none" };
  if (reset !== null && reset * 1000 <= Date.now()) return { pct: null, reset: null, state: "reset" };
  // Rounded from tenths so 0.575 (57.4999… in floating point) shows as 58%, as the API's 57.5 would.
  return { pct: Math.round(Math.round(v * 1000) / 10), reset, state: v >= 1 ? "full" : "ok" };
}

const windows = (u: Usage) => [win(u.h5, u.h5_reset), win(u.d7, u.d7_reset)] as const;
// Refused now: a window at 100%, or the API's own "rejected" verdict whose reset has not come.
const isRejected = (u?: Usage) => !!u && u.status === "rejected" && (!u.reset || u.reset * 1000 > Date.now());
const isFull = (u?: Usage) => !!u && (isRejected(u) || windows(u).some((w) => w.state === "full"));

// Theme color for a window: green, amber from 70%, red from 90% or full.
function tone(w: Win): "success" | "warning" | "error" | undefined {
  if (w.pct === null) return undefined;
  return w.state === "full" || w.pct >= 90 ? "error" : w.pct >= 70 ? "warning" : "success";
}
const HEX = { success: "#2ea56a", warning: "#e09b13", error: "#e5484d" } as const;

// "41m", "2h10m", "3d4h" until an epoch-seconds reset.
function until(s: number | null): string {
  if (!s) return "";
  const m = Math.max(0, Math.round((s * 1000 - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h${r}m` : `${h}h`; }
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return h ? `${d}d${h}h` : `${d}d`;
}

const pctText = (w: Win) => (w.pct === null ? "–" : `${w.pct}%`);
const resetText = (w: Win) => (w.state === "reset" ? "已重置" : w.reset ? `↻${until(w.reset)}` : "");

// One line for the folded band and /account: both windows with their resets.
function detail(u?: Usage): string {
  if (!u) return "暂无用量（回过一条消息后出现）";
  const [h5, d7] = windows(u);
  const part = (label: string, w: Win) => [label, pctText(w), resetText(w)].filter(Boolean).join(" ");
  const age = Math.round((Date.now() / 1000 - u.at) / 60);
  return `${part("5h", h5)} · ${part("7d", d7)}${age >= 10 ? ` · ${age}分钟前` : ""}`;
}

// Terminal cells a string takes: CJK and fullwidth forms take two.
function cells(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

// The usage table's columns fitted to the band's width: bars shrink first, then go, then the
// reset countdowns go. Row = marker 2 + name + 2 + group + 2 + group; group = "5h " 3 + bar+1 + pct 4 + reset 8.
type Layout = { name: number; bar: number; reset: boolean };
function layout(cols: number, name: number): Layout {
  for (const reset of [true, false]) {
    const base = 2 + name + 2 + 2 + 2 * (3 + 4 + (reset ? 8 : 0));
    const bar = Math.min(12, Math.floor((cols - base) / 2) - 1);
    if (bar >= 4) return { name, bar, reset };
    if (cols >= base) return { name, bar: 0, reset };
  }
  return { name, bar: 0, reset: false };
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

// The window login's usage from the API's usage endpoint (what /usage shows); the credential stays
// on the host. Null when the session has no first-party login or the call fails.
async function probeWindow($: any): Promise<Usage | null> {
  try {
    const auth = (await $.session.authorize())?.handle;
    if (!auth) return null;
    const r = await $.http.fetch(USAGE_API, { auth, headers: { "anthropic-beta": "oauth-2025-04-20" } });
    if (!r.ok) return null;
    const j = JSON.parse(r.text);
    const frac = (w: any) => (typeof w?.utilization === "number" ? w.utilization / 100 : null);
    const sec = (w: any) => { const t = w?.resets_at ? Date.parse(w.resets_at) : NaN; return Number.isFinite(t) ? Math.round(t / 1000) : null; };
    const u: Usage = { at: Date.now() / 1000, h5: frac(j.five_hour), h5_reset: sec(j.five_hour), d7: frac(j.seven_day), d7_reset: sec(j.seven_day) };
    if ((u.h5 ?? 0) >= 1 || (u.d7 ?? 0) >= 1) { u.status = "rejected"; u.reset = (u.h5 ?? 0) >= 1 ? u.h5_reset : u.d7_reset; }
    await $.store.set(WINDOW_USAGE_KEY, u);
    return u;
  } catch { return null; }
}

// Fresh readings for every account now: the relay probes the token accounts (one-token requests),
// the API's usage endpoint answers for the window login. Folded into the band's map.
async function probe($: any): Promise<void> {
  const fresh: Record<string, Usage> = {};
  const relay = (async () => {
    try {
      const r = await $.http.fetch(`${RELAY}/probe`);
      if (r.ok) Object.assign(fresh, JSON.parse(r.text).usage ?? {});
    } catch { /* relay down: the heartbeat's readings stand */ }
  })();
  const w = await probeWindow($);
  await relay;
  if (w) fresh[WINDOW] = w;
  await refreshUsage($, fresh);
}

// The relay account with the most room left, other than `not`; null when every one is refused.
// Never the window login: an automatic switch does not bill the desktop app's own account.
// Unread accounts rank after read ones with room.
async function bestAccount($: any, not: string): Promise<string | null> {
  const u = await read($, usage);
  const room = (k: string) => {
    const x = u[k];
    if (!x) return 0.5;
    const [h5, d7] = windows(x);
    return 1 - Math.max(h5.pct ?? 0, d7.pct ?? 0) / 100;
  };
  const names = (hb?.accounts ?? []).filter((k) => k !== not && !isFull(u[k]));
  names.sort((a, b) => room(b) - room(a));
  return names[0] ?? null;
}

// Move off a refused account: to the best other one, within the loop guard. Returns the account
// moved to (WINDOW for the window login), or null with the reason toasted.
async function autoMove($: any, why: string): Promise<string | null> {
  const now = Date.now();
  autoTimes = autoTimes.filter((t) => now - t < AUTO_SPAN_MS);
  if (autoTimes.length >= AUTO_MAX) {
    $.ui.toast(`account-switcher: ${AUTO_MAX} automatic switches in ${AUTO_SPAN_MS / 60000} minutes — stopping; pick an account by hand`);
    return null;
  }
  const from = (await read($, billing)).account ?? WINDOW;
  const to = await bestAccount($, from);
  if (!to) {
    $.ui.toast("account-switcher: every relay account is at its limit — nothing to switch to (the window account is never picked automatically)");
    return null;
  }
  autoTimes.push(now);
  await apply($, to, "auto");
  const name = (k: string) => (k === WINDOW ? WINDOW_NAME : k);
  $.ui.toast(`account-switcher: ${name(from)} ${why} → switched to ${name(to)}`);
  return to;
}

// ---- routing --------------------------------------------------------------------------------

function dir(p: string): string { return p.replace(/[\\/][^\\/]+[\\/]?$/, ""); }

async function readHeartbeat($: any): Promise<Heartbeat | null> {
  const fresh = (h: Heartbeat | null) => !!h && (Date.now() / 1000 - Number(h.at ?? 0)) < STALE_S;
  try {
    const f = `${store}/relay.alive`;
    if (!(await $.fs.exists(f))) return null;
    const h = JSON.parse(await $.fs.read(f)) as Heartbeat;
    return fresh(h) ? h : null;
  } catch {
    // A heartbeat caught mid-write (an older relay rewrites it in place) is not a dead relay:
    // keep the last one while it is fresh, rather than drop the session onto the window login.
    return fresh(hb) ? hb : null;
  }
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
    // No fresh heartbeat. Keep sending to the chosen account: if the relay really is down the
    // requests fail and are retried (and it restarts within a minute), which is visible; billing
    // the window login instead is silent, and on a spent window login it is an hours-long 429.
    await $.env.set("ANTHROPIC_BASE_URL", `${RELAY}/acct/${account}`);
    routedTo = account;
    await set({ account, source });
    const s = `⚠ ${label}: relay not answering · requests retry until it is back`;
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

// Right before a model request: the route `apply` last settled on, set again. Cheap (no file
// read), so it runs for every request, a subagent's included.
async function route($: any): Promise<void> {
  const b = await read($, billing);
  if (!b.host) return; // session.start has not applied yet
  await $.env.set("ANTHROPIC_BASE_URL", routedTo ? `${RELAY}/acct/${routedTo}` : b.host.baseUrl);
}

// The timer's tick: re-read the heartbeat; re-route only when the relay came up, went down or
// changed its accounts, otherwise just refresh the usage figures.
async function tick($: any): Promise<void> {
  const before = JSON.stringify([!!hb, hb?.accounts ?? []]);
  hb = await readHeartbeat($);
  if (JSON.stringify([!!hb, hb?.accounts ?? []]) !== before) await reapply($);
  else await refreshUsage($);
  if (Date.now() - lastWindowProbe > WINDOW_PROBE_MS) {
    lastWindowProbe = Date.now();
    const w = await probeWindow($);
    if (w) await refreshUsage($, { [WINDOW]: w });
  }
}
let lastWindowProbe = 0;
const WINDOW_PROBE_MS = 5 * 60_000;

async function setAuto($: any, on: boolean): Promise<void> {
  await update($, autoSwitch, () => on);
  await $.store.set(AUTO_KEY, on);
}

async function setHidden($: any, hidden: boolean): Promise<void> {
  await update($, isHidden, () => hidden);
  await $.store.set(HIDDEN_KEY, hidden);
}

async function setCollapsed($: any, collapsed: boolean): Promise<void> {
  await update($, isCollapsed, () => collapsed);
  await $.store.set(COLLAPSED_KEY, collapsed);
}

// ---- the band -------------------------------------------------------------------------------

// A usage bar `width` cells wide: an SVG on the desktop (rounded, colored by tone), block
// characters elsewhere.
function bar(ui: any, surface: string, w: Win, width: number, dim: boolean) {
  const { Box, Svg, Text } = ui;
  const frac = w.pct === null ? 0 : Math.min(1, w.pct / 100);
  const t = tone(w);
  if (surface === "desktop" && Svg) {
    const px = width * 7, fill = frac > 0 ? Math.max(4, Math.round(frac * px)) : 0;
    const color = t ? HEX[t] : "#888888";
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="8" viewBox="0 0 ${px} 8">`
      + `<rect x="0" y="1" width="${px}" height="6" rx="3" fill="#8a8a8a" fill-opacity="0.22"/>`
      + (fill ? `<rect x="0" y="1" width="${fill}" height="6" rx="3" fill="${color}" fill-opacity="${dim ? 0.45 : 1}"/>` : "")
      + `</svg>`;
    return <Box width={width} marginRight={1} alignItems="center"><Svg source={source} alt={pctText(w)} width={px} height={8} /></Box>;
  }
  const n = frac > 0 ? Math.max(1, Math.round(frac * width)) : 0;
  return (
    <Box width={width} marginRight={1}>
      <Text color={t} dimColor={dim}>{"█".repeat(n)}</Text>
      <Text dimColor>{"░".repeat(width - n)}</Text>
    </Box>
  );
}

// One account's row of the usage table: marker, name, then each window's bar, percent and reset.
function usageRow(ui: any, surface: string, key: string, name: string, u: Usage | undefined, isCurrent: boolean, L: Layout) {
  const { Box, Text } = ui;
  const dim = !!u && Date.now() / 1000 - u.at > OLD_S;
  const head = [
    <Box key="m" width={2}><Text color="claude" bold>{isCurrent ? "▸" : " "}</Text></Box>,
    <Box key="n" width={L.name + 2}><Text bold={isCurrent} dimColor={!isCurrent && dim} wrap="truncate-end">{name}</Text></Box>,
  ];
  if (!u) {
    return <Box key={key} flexDirection="row">{head}<Text dimColor>暂无数据 · 用过一次后显示</Text></Box>;
  }
  const group = (label: string, w: Win, k: string) => (
    <Box key={k} flexDirection="row" marginRight={2}>
      <Box width={3}><Text dimColor>{label}</Text></Box>
      {L.bar > 0 && bar(ui, surface, w, L.bar, dim)}
      <Box width={4} justifyContent="flex-end"><Text color={tone(w)} bold={w.state === "full"} dimColor={dim}>{pctText(w)}</Text></Box>
      {L.reset && <Box width={8} paddingLeft={1}><Text dimColor wrap="truncate-end">{resetText(w)}</Text></Box>}
    </Box>
  );
  const [h5, d7] = windows(u);
  return <Box key={key} flexDirection="row">{head}{group("5h", h5, "h5")}{group("7d", d7, "d7")}</Box>;
}

export function register(on: any) {
  on("session.start", async ($: any, e: any, next: any) => {
    store = dir($.plugin.root);
    const hidden = (await $.store.get(HIDDEN_KEY)) === true;
    const collapsed = (await $.store.get(COLLAPSED_KEY)) === true;
    await update($, isHidden, () => hidden);
    await update($, isCollapsed, () => collapsed);
    const auto = (await $.store.get(AUTO_KEY)) !== false;
    await update($, autoSwitch, () => auto);
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
      argumentHint: "[name | off | status | refresh | auto on|off | show | hide]",
    });
    $.clock.every(REFRESH_MS, () => { tick($).catch(() => {}); });
    probe($).catch(() => {});
    return next(e);
  });

  // A main turn about to start on an account already known to be refused moves first, so its
  // first request does not spend itself on a 429.
  on("turn.start", async ($: any, e: any, next: any) => {
    await reapply($);
    if (e.agentId === undefined && (await read($, autoSwitch))) {
      const b = await read($, billing);
      if (isFull((await read($, usage))[b.account ?? WINDOW])) await autoMove($, "is at its limit");
    }
    return next(e);
  });

  // A turn that died on the usage limit: mark the account refused, re-read everyone, move to the
  // account with the most room and send "继续" so the work picks up where it stopped.
  on("classic.StopFailure", async ($: any, e: any, next: any) => {
    const result = await next(e);
    if (e.error !== "rate_limit" || e.agent_id || !(await read($, autoSwitch))) return result;
    const k = (await read($, billing)).account ?? WINDOW;
    const cur = (await read($, usage))[k];
    await refreshUsage($, { [k]: { ...(cur ?? { h5: null, h5_reset: null, d7: null, d7_reset: null }), at: Date.now() / 1000, status: "rejected", reset: cur?.reset ?? null } });
    await probe($);
    // A submit from here would wait on the turn this hook holds: send it once the turn has ended
    // (turn.complete), or from the timer should no turn.complete follow.
    if (await autoMove($, "hit its limit")) {
      pendingContinue = true;
      $.clock.after(CONTINUE_DELAY_MS, () => sendContinue($));
    }
    return result;
  });
  on("prompt.submit", async ($: any, e: any, next: any) => { await reapply($); return next(e); });

  // Before every model request, main's or a subagent's (`e.agentId`): a subagent started before a
  // switch sends its next request on the new account, and no request goes out on a stale route.
  on("turn.step", async function* ($: any, e: any, next: any) {
    await route($);
    return yield* next(e);
  });

  // After each main-thread turn, keep the rate-limit windows the last reply reported, under the
  // account that served it; the window login's reading is also stored for later sessions.
  on("turn.complete", async ($: any, e: any, next: any) => {
    const result = await next(e);
    if (e.agentId === undefined) sendContinue($);
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

  // The band above the prompt: a dropdown of the window login and every account the relay holds a
  // token for, then a table of each account's 5-hour and 7-day usage (bar, percent, time to reset)
  // fitted to the band's width. "用量 / 收起" folds the table to one line, "隐藏" puts the band
  // away; both are remembered across sessions (`/account show` brings the band back).
  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: any) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e);
    const b = await read($, billing);
    const u = await read($, usage);
    const collapsed = await read($, isCollapsed);
    const ui = $.ui.resolve(e);
    const { Box, Button, Select, Text } = ui;
    const hide = <Button key="hide" label="隐藏" dimColor role="dismiss" onPress={() => setHidden($, true)} />;
    if (!b.relayUp) {
      // The chosen account stays in force (its requests retry until the relay is back); going
      // over to the window login is the person's call, one press away.
      const toWindow = async () => { $.ui.toast(`account-switcher: ${await apply($, null, null)}`); };
      return b.account ? (
        <Box flexDirection="row" gap={1}>
          <Text>💳 {b.account}</Text>
          <Text color="warning">relay 没响应 · 请求会重试</Text>
          <Button key="to-window" label={`改用${WINDOW_NAME}`} onPress={toWindow} />
          {hide}
        </Box>
      ) : (
        <Box flexDirection="row" gap={1}>
          <Text>💳 {WINDOW_NAME}</Text>
          <Text dimColor>relay 没在运行</Text>
          {hide}
        </Box>
      );
    }
    const current = b.account && b.accounts.includes(b.account) ? b.account : WINDOW;
    const names: [string, string][] = [[WINDOW, WINDOW_NAME], ...b.accounts.map((n): [string, string] => [n, n])];
    const options = names.map(([value, name]) => ({ value, label: isFull(u[value]) ? `${name} · 已满` : name }));
    if (b.account && !b.accounts.includes(b.account)) options.push({ value: b.account, label: `${b.account}（无 token）` });
    const choose = async (value: string) => {
      const name = value === WINDOW ? null : value;
      const s = await apply($, name, name ? "button" : null);
      $.ui.toast(`account-switcher: ${s} — from the next message on (subagents too)`);
    };
    const auto = await read($, autoSwitch);
    const header = (
      <Box key="head" flexDirection="row" gap={1}>
        <Select key="acct" label="💳" options={options} value={b.account ?? WINDOW} onSelect={choose} />
        {collapsed && <Box flexShrink={1}><Text dimColor wrap="truncate-end">{detail(u[current])}</Text></Box>}
        <Button key="auto" label={auto ? "自动切换 ✓" : "自动切换 ✗"} dimColor={!auto} onPress={() => setAuto($, !auto)} />
        <Button key="probe" label="↻" dimColor onPress={() => probe($)} />
        <Button key="fold" label={collapsed ? "用量 ▾" : "收起 ▴"} dimColor onPress={() => setCollapsed($, !collapsed)} />
        {hide}
      </Box>
    );
    if (collapsed) return header;
    const L = layout(Number(e.props.bodyColumns) || 80, Math.max(...names.map(([, n]) => cells(n))));
    return (
      <Box flexDirection="column">
        {header}
        {names.map(([value, name]) => usageRow(ui, e.surface, `row:${value}`, name, u[value], value === current, L))}
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
        b.account ? `This session bills: ${b.account.toUpperCase()} (${b.source}), its subagents too` : "This session bills: the window's own account",
        hb ? `Relay: up (pid ${hb.pid}, port ${hb.port}); accounts with tokens: ${known.join(", ") || "none"}` : "Relay: DOWN — sessions fall back to the window's account",
      ];
      for (const n of known) { const d = daysLeft(hb?.expires?.[n]); if (d !== null) lines.push(`  ${n}: token expires in ${d} days`); }
      for (const n of [WINDOW, ...known]) if (u[n]) lines.push(`  ${n === WINDOW ? "window account" : n} usage: ${detail(u[n])}`);
      lines.push(`Band above the prompt: ${(await read($, isHidden)) ? "hidden (/account show)" : "shown (/account hide)"}`);
      lines.push(`Auto-switch on the usage limit: ${(await read($, autoSwitch)) ? "on" : "off"} (/account auto on|off)`);
      lines.push("Usage: /account <name> · /account off · /account refresh · marker file .claude/account in a project");
      return { text: lines.join("\n") };
    }
    if (arg === "show" || arg === "hide") {
      await setHidden($, arg === "hide");
      return { text: arg === "hide" ? "Band hidden in every session; /account show brings it back." : "Band shown above the prompt." };
    }
    if (arg === "off") {
      return { text: await apply($, null, null) };
    }
    if (arg === "auto on" || arg === "auto off" || arg === "auto") {
      const enable = arg === "auto" ? !(await read($, autoSwitch)) : arg === "auto on";
      await setAuto($, enable);
      return { text: enable ? `Auto-switch on: a turn that hits the usage limit moves to the account with the most room and sends "${CONTINUE_TEXT}".` : "Auto-switch off." };
    }
    if (arg === "refresh") {
      await probe($);
      const u = await read($, usage);
      return { text: [WINDOW, ...known].filter((n) => u[n]).map((n) => `${n === WINDOW ? WINDOW_NAME : n}: ${isRejected(u[n]) ? "已满 · " : ""}${detail(u[n])}`).join("\n") || "No readings." };
    }
    if (!known.includes(arg)) {
      return { text: hb ? `No token for '${arg}'. Known: ${known.join(", ") || "none"}. Add one with scripts/add-account.ps1 -Name ${arg} (Windows) or scripts/add-account.sh ${arg} (macOS/Linux)` : "Relay is down; start it (Windows: scheduled task ClaudeAccountRelay · Linux: systemctl --user start claude-account-relay · macOS: launchctl kickstart gui/$(id -u)/com.claude-account-switcher.relay) and try again." };
    }
    return { text: `${await apply($, arg, "command")} — from the next message on (subagents too)` };
  });
}
