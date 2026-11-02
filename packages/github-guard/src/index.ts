import type { Plugin } from "@opencode/plugin";

const REMOTE_GIT = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
const LOCAL_PATH = /^(?:\/|\.{1,2}\/|~\/|file:\/\/)/;

// `git` in command position, optional global options, then the subcommand and its arguments.
const GIT_CALL =
  /(?:^|[\s;&|(`{\/])(?:sudo\s+|command\s+)*git(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--no-pager|--paginate|-p|--no-optional-locks|--bare))*\s+([a-z-]+)([^;&|\n]*)/g;
const GH_CALL = /(?:^|[\s;&|(`{\/])(?:sudo\s+)?gh\s/;
const FETCH_GITHUB_API =
  /(?:^|[\s;&|(`{\/])(?:curl|wget)\s[^\n]*?https?:\/\/((?:[a-z0-9-]+\.)*api\.github\.com)(?=[\/:"'\s?#]|$)/i;
const GITHUB_API_HOST = /(?:^|\.)api\.github\.com$/i;

const HEREDOC = /(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2)([^\n]*)\n([\s\S]*?)\n[ \t]*\3(?=\n|$)/g;

function stripHeredocs(s: string): string {
  // Keep the command line, drop the body: a doc written through a heredoc may quote git commands.
  return s.replace(HEREDOC, (_m, open: string, _q: string, tag: string, rest: string) => `${open}${rest}\n${tag}`);
}

function stripQuotes(s: string): string {
  return s.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");
}

function stripComments(s: string): string {
  return s.replace(/(^|\s)#[^\n]*/g, "$1");
}

function positionals(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith("-"));
}

// Returns the offending operation, or null when the call stays local.
function gitVerdict(sub: string, args: string): string | null {
  const pos = positionals(args);
  if (REMOTE_GIT.has(sub)) {
    // `git fetch /run/sandbox/source`, `git clone /cache/repo ./wt`: local paths need no route.
    if (pos[0] && LOCAL_PATH.test(pos[0])) return null;
    return sub;
  }
  if (sub === "remote" && pos[0] === "update") return "remote update";
  if (sub === "submodule" && (pos[0] === "update" || pos[0] === "add")) return `submodule ${pos[0]}`;
  return null;
}

function tail(command: string): string {
  const one = command.length > 400 ? `${command.slice(0, 400)}…` : command;
  return `Rejected command: ${one}`;
}

type Advice = { note?: string; fix: string[] };

export type GuardOptions = {
  // `fix` lines for git are keyed by operation (`push`, `submodule update`, ...), with `default` as the fallback.
  git?: { note?: string; fix?: Record<string, string[]> };
  gh?: Partial<Advice>;
  githubApi?: Partial<Advice>;
};

type Messages = {
  git: { note?: string; fix: Record<string, string[]> };
  gh: Advice;
  githubApi: Advice;
};

const ASK = "Fix: use a GitHub MCP server if one is configured, or ask the user to run this outside the sandbox.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lines(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value;
  return undefined;
}

function note(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function advice(value: unknown): Advice {
  const raw = isRecord(value) ? value : {};
  return { note: note(raw.note), fix: lines(raw.fix) ?? [ASK] };
}

export function parseOptions(options: unknown): Messages {
  const raw = isRecord(options) ? options : {};
  const git = isRecord(raw.git) ? raw.git : {};
  const fix: Record<string, string[]> = {
    default: ["Fix: ask the user to run this outside the sandbox, or use the remote Git route that your environment documents."],
  };
  if (isRecord(git.fix)) {
    for (const [op, value] of Object.entries(git.fix)) {
      const parsed = lines(value);
      if (parsed) fix[op] = parsed;
    }
  }
  return { git: { note: note(git.note), fix }, gh: advice(raw.gh), githubApi: advice(raw.githubApi) };
}

function headline(text: string, extra: string | undefined): string {
  return `Blocked by github-guard: ${text}${extra ? ` ${extra}` : ""}`;
}

function gitReason(m: Messages, op: string, command: string): string {
  return [
    headline(`remote \`git ${op}\` is blocked in this environment.`, m.git.note),
    ...(m.git.fix[op] ?? m.git.fix.default),
    "Every other git command works locally. Do not retry this one with other flags or a token.",
    tail(command),
  ].join("\n");
}

function ghReason(m: Messages, command: string): string {
  return [
    headline("the `gh` CLI calls api.github.com, which is blocked in this environment.", m.gh.note),
    ...m.gh.fix,
    "Do not retry gh with a token or another host.",
    tail(command),
  ].join("\n");
}

function githubApiReason(m: Messages, host: string, what: string): string {
  return [headline(`${host} is blocked in this environment.`, m.githubApi.note), ...m.githubApi.fix, what].join("\n");
}

// V2 names the shell tool `shell`; `bash` stays for older hosts and custom tools.
const SHELL_TOOLS = new Set(["shell", "bash"]);

export function createGuard(options?: unknown) {
  const m = parseOptions(options);

  function checkBash(command: string): string | null {
    const noHeredoc = stripHeredocs(command);
    const fetch = FETCH_GITHUB_API.exec(noHeredoc);
    if (fetch) return githubApiReason(m, fetch[1].toLowerCase(), tail(command));

    const plain = stripComments(stripQuotes(noHeredoc));
    if (GH_CALL.test(plain)) return ghReason(m, command);

    const call = new RegExp(GIT_CALL.source, GIT_CALL.flags);
    let match: RegExpExecArray | null;
    while ((match = call.exec(plain)) !== null) {
      const op = gitVerdict(match[1], match[2]);
      if (op) return gitReason(m, op, command);
    }
    return null;
  }

  function checkWebfetch(url: string): string | null {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (!GITHUB_API_HOST.test(host)) return null;
    return githubApiReason(m, host, `Rejected URL: ${url}`);
  }

  function checkToolCall(tool: string, input: unknown): string | null {
    const args = (input ?? {}) as { command?: unknown; url?: unknown };
    if (SHELL_TOOLS.has(tool) && typeof args.command === "string") return checkBash(args.command);
    if (tool === "webfetch" && typeof args.url === "string") return checkWebfetch(args.url);
    return null;
  }

  return { checkBash, checkWebfetch, checkToolCall };
}

const defaults = createGuard();
export const { checkBash, checkWebfetch, checkToolCall } = defaults;

const GitHubGuard: Plugin.Plugin = {
  id: "github-guard",
  async setup(ctx) {
    const guard = createGuard(ctx.options);
    await ctx.tool.hook("execute.before", (event) => {
      const reason = guard.checkToolCall(event.tool, event.input);
      if (reason) throw new Error(reason);
    });
  },
};

export default GitHubGuard;
