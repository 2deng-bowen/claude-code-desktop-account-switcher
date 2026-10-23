// The band above the prompt: a dropdown of the window login and every account the relay has a
// token for, and under it a table of each account's 5-hour / 7-day usage fitted to the band's
// width. A pick moves the session's API traffic (subagents' included) to that account, the window
// entry moves it back, "收起" folds the table and "隐藏" puts the band away, both remembered.
import { test, expect, mock } from "claude-code/testing";

const RELAY = "http://127.0.0.1:48620";
const band = (bodyColumns = 100) => ({
  plugin: "account-switcher", component: "AbovePrompt" as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns },
});

// The world beneath the plugin: a relay heartbeat file (or none, or one caught mid-write), a
// project with or without a marker, an environment the plugin may write (the kit's mock.env is
// read-only), the rate limits the session's last reply reported, and the URL each model request
// would have gone to.
let clock: any; // the kit's clock world() installs, to move the band's refresh timer
let sent: (string | undefined)[] = [];

function world(on: any, heartbeat: object | string | null | (() => object | string | null), env: Record<string, string | undefined>, rateLimits: object[] = [], marker?: string) {
  const hb = typeof heartbeat === "function" ? heartbeat : () => heartbeat;
  const isMarker = (path: string) => marker !== undefined && /[\\/]\.claude[\\/]account$/.test(path);
  on("fs.exists", async (_$: any, e: any) => ({ value: /relay\.alive$/.test(e.path) ? hb() !== null : isMarker(e.path) }));
  on("fs.read", async (_$: any, e: any) => {
    const h = hb();
    if (/relay\.alive$/.test(e.path) && h !== null) return { value: typeof h === "string" ? h : JSON.stringify(h) };
    if (isMarker(e.path)) return { value: marker };
    return { deny: `unexpected read ${e.path}` };
  });
  on("session.cwd", async () => ({ value: "C:/work/project" }));
  on("session.root", async () => ({ value: "C:/work/project" }));
  on("session.start", async (_$: any, e: any) => ({ cwd: e.cwd }));
  on("session.usage", async () => ({ value: { startedAt: 0, context: {}, rateLimits } }));
  on("env.get", async (_$: any, e: any) => ({ value: env[e.name] }));
  on("env.set", async (_$: any, e: any) => { env[e.name] = e.value; return { value: undefined }; });
  on("ui.status", async () => ({ value: undefined }));
  on("ui.toast", async () => ({ value: undefined }));
  on("command.register", async (_$: any, e: any) => ({ value: { command: e.name } }));
  on("turn.start", async (_$: any, e: any) => ({ turnId: e.turnId }));
  on("turn.complete", async (_$: any, e: any) => ({ text: e.answer }));
  sent = [];
  on("turn.step", async function* (_$: any, e: any) {
    sent.push(env.ANTHROPIC_BASE_URL);
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [] };
  });
  clock = mock.clock(on); // the band's refresh timer runs on the kit's clock
  // The engine's own band is empty: what a hidden band's next(e) reaches.
  on("ui.render", { component: "AbovePrompt" }, async () => ({ type: "Box", props: {}, children: [] }));
  return env;
}

// A model request as the engine makes it, read to its end.
async function step($: any, agentId?: string) {
  const s = $.turn.step({ turnId: "t1", index: 0, model: "m", messageCount: 1, ...(agentId ? { agentId } : {}) });
  for await (const _ of s) { /* drain */ }
  return s.result;
}

const now = () => Date.now() / 1000;
const alive = (usage: object = {}) => ({ port: 48620, pid: 1, at: now(), accounts: ["vbp", "personal2", "personal"], usage });
const reading = (h5: number, h5h: number, d7: number, d7d: number) => ({ at: now(), h5, h5_reset: now() + h5h * 3600, d7, d7_reset: now() + d7d * 86400 });

for (const surface of ["terminal", "desktop"] as const) {
  test(`a dropdown pick switches the account; the table shows each account's usage (${surface})`, async ($, on) => {
    mock.store(on);
    const env = world(on, alive({ personal2: reading(0.234, 3, 0.41, 2) }), { ANTHROPIC_BASE_URL: "https://host.example" });
    await $.session.start({ cwd: "C:/work/project", surface, isInteractive: true });

    const ui = await $.ui.mount({ ...band(), surface });
    const select = await ui.find({ key: "acct" });
    expect(select?.type).toBe("Select");
    const options = select?.props.options as { value: string; label: string }[];
    expect(options.map((o) => o.value)).toEqual(["__window", "vbp", "personal2", "personal"]);
    expect(options.map((o) => o.label)).toEqual(["窗口账号", "vbp", "personal2", "personal"]);
    expect(select?.props.value).toBe("__window");

    // One row per account; one with a reading shows both windows, one without says so.
    const row = await ui.find({ key: "row:personal2" });
    expect(row?.text).toMatch(/personal2.*5h.*23%.*↻3h.*7d.*41%.*↻2d/);
    expect((await ui.find({ key: "row:vbp" }))?.text).toMatch(/暂无数据/);
    if (surface === "desktop") expect((await ui.find({ type: "Svg" }))?.props.source).toMatch(/<rect[^>]+fill="#2ea56a"/);
    else expect(await ui.find({ type: "Text", text: /█/ })).toBeDefined();

    await ui.select({ key: "acct", value: "personal2" });
    expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/personal2`);
    expect((await ui.find({ key: "acct" }))?.props.value).toBe("personal2");
    expect((await ui.find({ key: "row:personal2" }))?.text).toMatch(/^▸/);

    await ui.select({ key: "acct", value: "__window" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
    expect((await ui.find({ key: "row:__window" }))?.text).toMatch(/^▸/);

    await ui.press({ key: "hide" });
    expect(await ui.find({ key: "acct" })).toBeUndefined();
    await ui.unmount();
  });
}

test("the table fits the band: bars shrink, then go, then the reset countdowns go", async ($, on) => {
  mock.store(on);
  world(on, alive({ vbp: reading(0.5, 2, 0.2, 3) }), {});
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  const bars = async (cols: number) => {
    const ui = await $.ui.mount({ ...band(cols), surface: "terminal" });
    const text = (await ui.find({ key: "row:vbp" }))?.text ?? "";
    await ui.unmount();
    return text;
  };
  expect(await bars(100)).toMatch(/█{6}░{6}/);        // 12-cell bars at 50%
  expect(await bars(64)).toMatch(/█+░+/);
  expect(await bars(50)).not.toMatch(/[█░]/);         // no room for bars: percents and resets
  expect(await bars(50)).toMatch(/50%.*↻2h/);
  expect(await bars(34)).not.toMatch(/↻/);            // narrower still: percents alone
  expect(await bars(34)).toMatch(/50%.*20%/);
});

test("a full account is marked in the dropdown; a window whose reset has passed reads 已重置", async ($, on) => {
  mock.store(on);
  world(on, alive({ vbp: reading(1, 1.5, 0.6, 3), personal: { at: now() - 7200, h5: 0.9, h5_reset: now() - 60, d7: 0.3, d7_reset: now() + 86400 } }), {});
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  const ui = await $.ui.mount({ ...band(), surface: "desktop" });
  const options = (await ui.find({ key: "acct" }))?.props.options as { value: string; label: string }[];
  expect(options.find((o) => o.value === "vbp")?.label).toBe("vbp · 已满");
  expect((await ui.find({ key: "row:vbp" }))?.text).toMatch(/100%.*↻1h30m/);
  expect((await ui.find({ key: "row:personal" }))?.text).toMatch(/5h.*–.*已重置.*7d.*30%/);
  await ui.unmount();
});

test("every model request, a subagent's included, goes out on the account in force", async ($, on) => {
  mock.store(on);
  const env = world(on, alive(), { ANTHROPIC_BASE_URL: "https://host.example" });
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  await $.command.run({ command: "account", args: "vbp" });

  env.ANTHROPIC_BASE_URL = "https://host.example"; // whatever left the process on the window login
  await step($, "a1b2c3");                          // a subagent's request
  await step($);                                    // and main's
  expect(sent).toEqual([`${RELAY}/acct/vbp`, `${RELAY}/acct/vbp`]);

  await $.command.run({ command: "account", args: "off" });
  await step($, "a1b2c3");
  expect(sent.at(-1)).toBe("https://host.example");
});

test("a heartbeat caught mid-write keeps the route instead of dropping to the window login", async ($, on) => {
  mock.store(on);
  let beat: object | string = alive();
  const env = world(on, () => beat, { ANTHROPIC_BASE_URL: "https://host.example" }, [], "vbp\n");
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/vbp`);
  beat = "";                                        // truncated by an in-place rewrite
  await $.turn.start({ turnId: "t2" } as any);
  expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/vbp`);
});

test("after a turn on the window login, its rate limits show in the table and are stored for later sessions", async ($, on) => {
  const kept: Record<string, unknown> = {};
  on("store.get", async (_$: any, e: any) => ({ value: kept[e.key] }));
  on("store.set", async (_$: any, e: any) => { kept[e.key] = e.value; return { value: undefined }; });
  const resets = new Date(Date.now() + 90 * 60000).toISOString();
  world(on, alive(), { ANTHROPIC_BASE_URL: "https://host.example" }, [
    { kind: "five_hour", percentUsed: 12, resetsAt: resets },
    { kind: "seven_day", percentUsed: 57.5 },
  ]);
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  const ui = await $.ui.mount({ ...band(), surface: "desktop" });

  await $.turn.complete({ answer: "done", durationMs: 1000, isAborted: false, turnId: "t1", reason: "answer" });
  expect((await ui.find({ key: "row:__window" }))?.text).toMatch(/窗口账号.*12%.*↻1h30m.*58%/);
  expect(kept["usage.window"]).toMatchObject({ h5: 0.12, d7: 0.575 });
  await ui.unmount();
});

test("收起 folds the table to one line, remembered across sessions", async ($, on) => {
  const kept: Record<string, unknown> = {};
  on("store.get", async (_$: any, e: any) => ({ value: kept[e.key] }));
  on("store.set", async (_$: any, e: any) => { kept[e.key] = e.value; return { value: undefined }; });
  world(on, alive({ vbp: reading(0.3, 2, 0.1, 4) }), {}, [], "vbp\n");
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  const ui = await $.ui.mount({ ...band(), surface: "desktop" });
  expect(await ui.find({ key: "row:vbp" })).toBeDefined();

  await ui.press({ key: "fold" });
  expect(await ui.find({ key: "row:vbp" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /5h 30% ↻2h · 7d 10% ↻4d/ })).toBeDefined();
  expect(kept["band.collapsed"]).toBe(true);

  await ui.press({ key: "fold" });
  expect(await ui.find({ key: "row:vbp" })).toBeDefined();
  await ui.unmount();
});

test("relay down with no account chosen: no dropdown, the band says so, and the session keeps the host URL", async ($, on) => {
  mock.store(on);
  const env = world(on, null, { ANTHROPIC_BASE_URL: "https://host.example" });
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  const ui = await $.ui.mount({ ...band(), surface: "terminal" });
  expect(await ui.find({ key: "acct" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /relay 没在运行/ })).toBeDefined();
  expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
  await ui.unmount();
});

test("relay down with an account chosen: requests stay on that account (never silently the window login) until the person says so", async ($, on) => {
  mock.store(on);
  let beat: object | null = alive();
  const env = world(on, () => beat, { ANTHROPIC_BASE_URL: "https://host.example" });
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  await $.command.run({ command: "account", args: "vbp" } as any);

  beat = null;                                      // relay stops answering
  await $.turn.start({ turnId: "t2" } as any);
  await step($, "sub1");
  expect(sent.at(-1)).toBe(`${RELAY}/acct/vbp`);
  const ui = await $.ui.mount({ ...band(), surface: "desktop" });
  expect(await ui.find({ type: "Text", text: /relay 没响应/ })).toBeDefined();

  await ui.press({ key: "to-window" });
  expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
  await step($);
  expect(sent.at(-1)).toBe("https://host.example");
  await ui.unmount();
});

test("the refresh timer notices a relay that came up and shows the dropdown again", async ($, on) => {
  mock.store(on);
  let beat: object | null = null;
  const env = world(on, () => beat, { ANTHROPIC_BASE_URL: "https://host.example" }, [], "vbp\n");
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  const ui = await $.ui.mount({ ...band(), surface: "desktop" });
  expect(await ui.find({ type: "Text", text: /relay 没响应/ })).toBeDefined();
  expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/vbp`);  // the marker's account, relay or not

  beat = alive();
  await clock.advance(15_000);
  expect((await ui.find({ key: "acct" }))?.props.value).toBe("vbp");
  expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/vbp`);
  await ui.unmount();
});

test("a hide remembered in the store keeps the band away; /account show brings it back", async ($, on) => {
  mock.store(on, { "band.hidden": true });
  world(on, alive(), {});
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  const ui = await $.ui.mount({ ...band(), surface: "terminal" });
  expect(await ui.find({ key: "acct" })).toBeUndefined();
  const { text } = await $.command.run({ command: "account", args: "show" } as any);
  expect(text).toMatch(/shown/);
  expect(await ui.find({ key: "acct" })).toBeDefined();
  await ui.unmount();
});
