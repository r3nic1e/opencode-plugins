export type Status = "draft" | "open" | "merged" | "closed"
// "none": the head commit has no checks and no statuses.
export type Ci = "pending" | "failure" | "success" | "none"

export interface PullRequest {
  owner: string
  repo: string
  number: number
  url: string
  title: string
  status: Status
  ci?: Ci
  createdAt: number
  checkedAt: number
  // The call that created the PR; status refreshes reuse its session context.
  agent: string
  messageID: string
}

export interface Created {
  owner: string
  repo: string
  number: number
  url: string
  title: string
  status: Status
}

export interface ToolNames {
  create: string
  read: string
}

// Defaults match the official GitHub MCP server registered as `github`.
export function toolNames(options: unknown): ToolNames {
  const raw = isRecord(options) ? options : {}
  const pick = (value: unknown, fallback: string) => (typeof value === "string" && value ? value : fallback)
  return {
    create: pick(raw.createTool, "github_create_pull_request"),
    read: pick(raw.readTool, "github_pull_request_read"),
  }
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// MCP results carry structured output, JSON-parsed text, or plain text; the text parts repeat it.
function payloads(result: unknown): unknown[] {
  if (!isRecord(result)) return []
  const out: unknown[] = [result.output]
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") out.push(part.text)
    }
  }
  return out.map((value) => {
    if (typeof value !== "string") return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  })
}

export function parseCreated(input: unknown, result: unknown): Created | undefined {
  const args = isRecord(input) ? input : {}
  for (const payload of payloads(result)) {
    const text = isRecord(payload)
      ? [payload.html_url, payload.url].find((value) => typeof value === "string")
      : typeof payload === "string"
        ? payload
        : undefined
    const match = typeof text === "string" ? PR_URL.exec(text) : null
    if (!match) continue
    return {
      owner: match[1],
      repo: match[2],
      number: Number(match[3]),
      url: match[0],
      title: typeof args.title === "string" ? args.title : "",
      status: args.draft === true ? "draft" : "open",
    }
  }
  return undefined
}

// GitHub reports a merged PR as state "closed" with merged true.
export function parseStatus(result: unknown): Status | undefined {
  for (const payload of payloads(result)) {
    if (!isRecord(payload) || typeof payload.state !== "string") continue
    if (payload.merged === true || typeof payload.merged_at === "string") return "merged"
    if (payload.state === "closed") return "closed"
    if (payload.draft === true) return "draft"
    return "open"
  }
  return undefined
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"])

function listIn(result: unknown, field: string): Record<string, unknown>[] | undefined {
  for (const payload of payloads(result)) {
    if (isRecord(payload) && Array.isArray(payload[field])) return payload[field].filter(isRecord)
  }
  return undefined
}

// CI reports through two GitHub APIs: check runs (GitHub Actions and apps) and commit statuses
// (Jenkins, Atlantis). The commit status API already keeps only the latest status per context, but
// check runs include every rerun, so only the newest run per name counts. A combined status is
// "pending" when the commit has no statuses at all, so the individual statuses decide, not the
// combined state. Returns undefined unless both results are readable.
export function parseCi(checkRuns: unknown, combinedStatus: unknown): Ci | undefined {
  const runs = listIn(checkRuns, "check_runs")
  const statuses = listIn(combinedStatus, "statuses")
  if (!runs || !statuses) return undefined

  const latest = new Map<string, Record<string, unknown>>()
  for (const run of runs) {
    const name = String(run.name)
    const seen = latest.get(name)
    if (!seen || Number(run.id) > Number(seen.id)) latest.set(name, run)
  }

  const states: Ci[] = [
    ...[...latest.values()].map((run): Ci =>
      run.status !== "completed" ? "pending" : FAILED_CONCLUSIONS.has(String(run.conclusion)) ? "failure" : "success",
    ),
    ...statuses.map((status): Ci =>
      status.state === "pending" ? "pending" : status.state === "failure" || status.state === "error" ? "failure" : "success",
    ),
  ]
  if (states.includes("failure")) return "failure"
  if (states.includes("pending")) return "pending"
  return states.length > 0 ? "success" : "none"
}

export function sameRequest(a: Pick<Created, "owner" | "repo" | "number">, b: Pick<Created, "owner" | "repo" | "number">) {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number
}

export function upsert(list: readonly PullRequest[], next: PullRequest): PullRequest[] {
  const index = list.findIndex((item) => sameRequest(item, next))
  if (index === -1) return [...list, next]
  return list.map((item, i) => (i === index ? { ...item, ...next, createdAt: item.createdAt } : item))
}

// Merged is final; a closed PR can be reopened.
export function due(pr: PullRequest, now: number, interval: number): boolean {
  return pr.status !== "merged" && now - pr.checkedAt >= interval
}

export function decode(value: unknown): PullRequest[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is PullRequest =>
      isRecord(item) &&
      typeof item.owner === "string" &&
      typeof item.repo === "string" &&
      typeof item.number === "number" &&
      typeof item.status === "string",
  )
}
