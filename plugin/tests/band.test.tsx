// The band above the prompt: a dropdown of the window login and every account the relay has a
// token for, each with its last usage; a pick moves the session's API traffic to that account,
// the window entry moves it back, the chosen account's usage shows beside it, and "hide" is
// remembered in the store.
import { test, expect, mock } from "claude-code/testing";

const RELAY = "http://127.0.0.1:48620";
const BAND = { plugin: "account-switcher", component: "AbovePrompt" as const, props: { hasSurvey: false, isWorking: false, maxRows: 10 } };

// The world beneath the plugin: a relay heartbeat file (or none), a project with no marker,
// an environment the plugin may write (the kit's mock.env is read-only) and the rate limits
// the session's last reply reported.
let clock: any; // the kit's clock world() installs, to move the band's refresh timer

function world(on: any, heartbeat: object | null | (() => object | null), env: Record<string, string | undefined>, rateLimits: object[] = [], marker?: string) {
  const hb = typeof heartbeat === "function" ? heartbeat : () => heartbeat;
  const isMarker = (path: string) => marker !== undefined && /[\\/]\.claude[\\/]account$/.test(path);
  on("fs.exists", async (_$: any, e: any) => ({ value: /relay\.alive$/.test(e.path) ? hb() !== null : isMarker(e.path) }));
  on("fs.read", async (_$: any, e: any) => {
    if (/relay\.alive$/.test(e.path) && hb()) return { value: JSON.stringify(hb()) };
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
  on("turn.complete", async (_$: any, e: any) => ({ text: e.answer }));
  clock = mock.clock(on); // the band's refresh timer runs on the kit's clock
  // The engine's own band is empty: what a hidden band's next(e) reaches.
  on("ui.render", { component: "AbovePrompt" }, async () => ({ type: "Box", props: {}, children: [] }));
  return env;
}

const now = () => Date.now() / 1000;
const alive = (usage: object = {}) => ({ port: 48620, pid: 1, at: now(), accounts: ["vbp", "personal2", "personal"], usage });

for (const surface of ["terminal", "desktop"] as const) {
  test(`a dropdown pick switches the account and the window entry restores the host URL (${surface})`, async ($, on) => {
    mock.store(on);
    const usage = { personal2: { at: now(), h5: 0.234, h5_reset: now() + 3 * 3600, d7: 0.41, d7_reset: now() + 2 * 86400 } };
    const env = world(on, alive(usage), { ANTHROPIC_BASE_URL: "https://host.example" });
    await $.session.start({ cwd: "C:/work/project", surface, isInteractive: true });

    const ui = await $.ui.mount({ ...BAND, surface });
    const select = await ui.find({ key: "acct" });
    expect(select?.type).toBe("Select");
    const options = select?.props.options as { value: string; label: string }[];
    expect(options.map((o) => o.value)).toEqual(["__window", "vbp", "personal2", "personal"]);
    expect(options[2]?.label).toBe("personal2 · 5h 23% · 7d 41%");
    expect(select?.props.value).toBe("__window");
    expect(await ui.find({ type: "Text", text: /暂无用量/ })).toBeDefined();

    await ui.select({ key: "acct", value: "personal2" });
    expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY}/acct/personal2`);
    expect((await ui.find({ key: "acct" }))?.props.value).toBe("personal2");
    expect(await ui.find({ type: "Text", text: /5h 23% ↻3小时 · 7d 41% ↻2天/ })).toBeDefined();

    await ui.select({ key: "acct", value: "__window" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
    expect((await ui.find({ key: "acct" }))?.props.value).toBe("__window");

    await ui.press({ key: "hide" });
    expect(await ui.find({ key: "acct" })).toBeUndefined();
    await ui.unmount();
  });
}

test("after a turn on the window login, its rate limits show in the band and are stored for later sessions", async ($, on) => {
  const kept: Record<string, unknown> = {};
  on("store.get", async (_$: any, e: any) => ({ value: kept[e.key] }));
  on("store.set", async (_$: any, e: any) => { kept[e.key] = e.value; return { value: undefined }; });
  const resets = new Date(Date.now() + 90 * 60000).toISOString();
  world(on, alive(), { ANTHROPIC_BASE_URL: "https://host.example" }, [
    { kind: "five_hour", percentUsed: 12, resetsAt: resets },
    { kind: "seven_day", percentUsed: 57.5 },
  ]);
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });

  await $.turn.complete({ answer: "done", durationMs: 1000, isAborted: false, turnId: "t1", reason: "answer" });
  expect(await ui.find({ type: "Text", text: /5h 12% ↻(90分钟|2小时) · 7d 58%/ })).toBeDefined();
  const options = (await ui.find({ key: "acct" }))?.props.options as { value: string; label: string }[];
  expect(options[0]?.label).toBe("窗口账号 · 5h 12% · 7d 58%");
  expect(kept["usage.window"]).toMatchObject({ h5: 0.12, d7: 0.575 });
  await ui.unmount();
});

test("relay down: no dropdown, the band says so, and the session keeps the host URL", async ($, on) => {
  mock.store(on);
  const env = world(on, null, { ANTHROPIC_BASE_URL: "https://host.example" });
  await $.session.start({ cwd: "C:/work/project", surface: "terminal", isInteractive: true });
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ key: "acct" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /relay down/ })).toBeDefined();
  expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");
  await ui.unmount();
});

test("the refresh timer notices a relay that came up and routes the marker's account through it", async ($, on) => {
  mock.store(on);
  let beat: object | null = null;
  const env = world(on, () => beat, { ANTHROPIC_BASE_URL: "https://host.example" }, [], "vbp\n");
  await $.session.start({ cwd: "C:/work/project", surface: "desktop", isInteractive: true });
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect(await ui.find({ type: "Text", text: /relay down/ })).toBeDefined();
  expect(env.ANTHROPIC_BASE_URL).toBe("https://host.example");

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
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ key: "acct" })).toBeUndefined();
  const { text } = await $.command.run({ command: "account", args: "show" });
  expect(text).toMatch(/shown/);
  expect(await ui.find({ key: "acct" })).toBeDefined();
  await ui.unmount();
});
