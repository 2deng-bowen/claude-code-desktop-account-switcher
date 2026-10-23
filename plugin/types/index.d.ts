// The values the account-switcher band draws from, held by the host for the session
// (a hot reload keeps them; the module's own variables start over).
export type Billing = {
  /** The account this session bills, or null for the window's own login. */
  account: string | null;
  /** How the account was chosen. */
  source: "marker" | "command" | "button" | null;
  /** Accounts the relay holds a token for; empty while the relay is down. */
  accounts: string[];
  /** Whether the relay answered a fresh heartbeat. */
  relayUp: boolean;
  /** ANTHROPIC_BASE_URL as the host set it, captured once per session and restored by "off". */
  host: { baseUrl: string | undefined } | null;
};

/** One account's rate-limit windows as the API last reported them: fractions 0..1, resets in epoch seconds. */
export type Usage = {
  at: number;
  h5: number | null;
  h5_reset: number | null;
  d7: number | null;
  d7_reset: number | null;
};

/** Usage per account name; WINDOW_KEY ("__window") is the window's own login. */
export type UsageMap = Record<string, Usage>;

declare module "claude-code" {
  interface PluginState {
    "account-switcher": { billing: Billing; isHidden: boolean; isCollapsed: boolean; usage: UsageMap };
  }
}
