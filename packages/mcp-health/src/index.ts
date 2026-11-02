import type { Plugin } from "@opencode/plugin";
import { existsSync } from "node:fs";

type Server = { name: string; status: { status: string; error?: string } };
type Reference = { name: string; path?: string; source?: { type?: string } };
type Exists = (path: string) => boolean;

export type Advice = { down: string; auth: string; missing: string };

export type HealthOptions = {
  expectedDown?: readonly string[];
  advice?: Partial<Advice>;
};

const DEFAULT_ADVICE: Advice = {
  down: "Agents do not restart MCP servers. Ask the user to check the server, then reconnect it with `/mcps` or `/reload`.",
  auth: "Ask the user to sign in through `/mcps`.",
  missing: "Do not create or write to a missing reference path. Ask the user to restore it.",
};

const TTL_MS = 15_000;
const LIST_TIMEOUT_MS = 2_000;

function oneLine(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseOptions(options: unknown): HealthOptions {
  const raw = (options ?? {}) as { expectedDown?: unknown; advice?: unknown };
  const advice = (raw.advice ?? {}) as Record<string, unknown>;
  const picked: Partial<Advice> = {};
  for (const key of ["down", "auth", "missing"] as const) {
    if (typeof advice[key] === "string") picked[key] = advice[key] as string;
  }
  return { expectedDown: strings(raw.expectedDown), advice: picked };
}

export function healthNote(
  servers: readonly Server[],
  references: readonly Reference[],
  exists: Exists = existsSync,
  options: HealthOptions = {},
): string | undefined {
  const expectedDown = new Set(options.expectedDown ?? []);
  const advice = { ...DEFAULT_ADVICE, ...options.advice };
  const lines: string[] = [];
  let down = false;
  let auth = false;
  for (const server of servers) {
    if (expectedDown.has(server.name)) continue;
    const error = oneLine(server.status.error);
    if (server.status.status === "failed") {
      down = true;
      lines.push(`- MCP \`${server.name}\` is configured but failed${error ? `: ${error}` : ""}. Its tools are missing from Code Mode search.`);
    } else if (server.status.status === "needs_auth") {
      auth = true;
      lines.push(`- MCP \`${server.name}\` needs sign-in${error ? `: ${error}` : ""}.`);
    }
  }
  let missing = false;
  for (const ref of references) {
    if ((ref.source?.type ?? "local") !== "local" || !ref.path || exists(ref.path)) continue;
    missing = true;
    lines.push(`- Reference \`${ref.name}\` points to \`${ref.path}\`, which does not exist.`);
  }
  if (!lines.length) return undefined;

  return [
    "Connection problems right now (mcp-health plugin; this note disappears when they clear):",
    ...lines,
    "Tell the user which service is down. Do not say that it does not exist or that you have no access to it.",
    down ? advice.down : "",
    auth ? advice.auth : "",
    missing ? advice.missing : "",
  ].filter(Boolean).join("\n");
}

function items<T>(output: unknown): T[] {
  if (Array.isArray(output)) return output as T[];
  const data = (output as { data?: unknown } | undefined)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type HealthSource = {
  servers: () => Promise<unknown>;
  references: () => Promise<unknown>;
  now?: () => number;
  exists?: Exists;
  timeoutMs?: number;
  options?: HealthOptions;
};

export function createHealth(source: HealthSource) {
  const now = source.now ?? Date.now;
  const timeout = source.timeoutMs ?? LIST_TIMEOUT_MS;
  let servers: Server[] = [];
  let references: Reference[] = [];
  let checked = -Infinity;

  async function refresh() {
    const [s, r] = await Promise.allSettled([
      within(Promise.resolve().then(source.servers), timeout),
      within(Promise.resolve().then(source.references), timeout),
    ]);
    if (s.status === "fulfilled" && s.value !== undefined) servers = items<Server>(s.value);
    if (r.status === "fulfilled" && r.value !== undefined) references = items<Reference>(r.value);
    checked = now();
  }

  return {
    async note(): Promise<string | undefined> {
      if (now() - checked >= TTL_MS) await refresh();
      return healthNote(servers, references, source.exists, source.options);
    },
  };
}

const McpHealth: Plugin.Plugin = {
  id: "mcp-health",
  async setup(ctx) {
    const health = createHealth({
      servers: () => ctx.mcp.list(),
      references: () => ctx.reference.list(),
      options: parseOptions(ctx.options),
    });
    await ctx.session.hook("context", async (event) => {
      const note = await health.note().catch(() => undefined);
      if (note) event.system.push({ type: "text", text: note });
    });
  },
};

export default McpHealth;
