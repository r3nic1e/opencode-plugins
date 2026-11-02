import { Plugin } from "@opencode/plugin"
import { decode, due, parseCreated, parseStatus, sameRequest, toolNames, upsert, type PullRequest } from "./pr.ts"
import { PrTracker, type Item } from "./rpc.ts"

// pr-tracker: remember PRs created through the GitHub MCP in each session and keep their status current.
//
// Status refreshes call the GitHub MCP read tool directly, as the agent that created the PR. Direct
// calls skip tool hooks and never show in the transcript. A refresh never prompts: if the permission
// rules would ask, the plugin denies its own call and keeps the last known status.

const CALL_PREFIX = "prtracker_"
// The TUI asks every 60 s; a slightly shorter window keeps timer jitter from skipping a round.
const REFRESH_AFTER_MS = 50_000
const READ_TIMEOUT_MS = 30_000

const key = (sessionID: string) => `session:${sessionID}`

export default Plugin.define({
  id: "r3nic1e.pr-tracker",
  async setup(ctx) {
    const tools = toolNames(ctx.options)
    const queues = new Map<string, Promise<unknown>>()
    const inflight = new Set<string>()
    let calls = 0

    const read = async (sessionID: string) => decode(await ctx.storage.get(key(sessionID)))

    // Serialize read-modify-write per session; the hook and refreshes race otherwise.
    const update = (sessionID: string, change: (list: PullRequest[]) => PullRequest[]) => {
      const run = (queues.get(sessionID) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const before = await read(sessionID)
          const after = change(before)
          if (JSON.stringify(after) === JSON.stringify(before)) return false
          await ctx.storage.set(key(sessionID), after as never)
          return true
        })
      queues.set(sessionID, run)
      void run.finally(() => {
        if (queues.get(sessionID) === run) queues.delete(sessionID)
      })
      return run
    }

    const registration = await ctx.rpc.register(PrTracker, {
      list: async (input) => {
        const { sessionIDs, refresh } = input as { sessionIDs: string[]; refresh?: boolean }
        const items: Item[] = []
        for (const sessionID of sessionIDs) {
          const list = await read(sessionID)
          for (const pr of list) {
            items.push({
              sessionID,
              owner: pr.owner,
              repo: pr.repo,
              number: pr.number,
              url: pr.url,
              title: pr.title,
              status: pr.status,
              createdAt: pr.createdAt,
            })
          }
          if (refresh) void refreshSession(sessionID, list)
        }
        items.sort((a, b) => a.createdAt - b.createdAt)
        return { items }
      },
    })

    const changed = (sessionID: string) =>
      registration.events.emit("changed", { sessionID }).catch(() => undefined)

    const fetchStatus = async (sessionID: string, pr: PullRequest) => {
      const tool = (await ctx.tool.list()).find((item) => item.id === tools.read)
      if (!tool) return undefined
      const result = await tool.execute(
        { method: "get", owner: pr.owner, repo: pr.repo, pullNumber: pr.number },
        {
          sessionID,
          agent: pr.agent,
          messageID: pr.messageID,
          id: `${CALL_PREFIX}${Date.now()}_${++calls}`,
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
          progress: async () => {},
        } as never,
      )
      return parseStatus(result)
    }

    async function refreshSession(sessionID: string, list: readonly PullRequest[]) {
      const now = Date.now()
      const stale = list.filter((pr) => due(pr, now, REFRESH_AFTER_MS))
      const results = await Promise.all(
        stale.map(async (pr) => {
          const id = `${sessionID}/${pr.owner}/${pr.repo}#${pr.number}`
          if (inflight.has(id)) return false
          inflight.add(id)
          try {
            const status = await fetchStatus(sessionID, pr).catch((error) => {
              console.warn(`[pr-tracker] ${pr.owner}/${pr.repo}#${pr.number}: ${error instanceof Error ? error.message : error}`)
              return undefined
            })
            return await update(sessionID, (current) =>
              current.map((item) =>
                sameRequest(item, pr) ? { ...item, status: status ?? item.status, checkedAt: Date.now() } : item,
              ),
            ).then(() => status !== undefined && status !== pr.status)
          } finally {
            inflight.delete(id)
          }
        }),
      )
      if (results.some(Boolean)) await changed(sessionID)
    }

    await ctx.permission.hook("evaluate", (event) => {
      if (event.effect !== "ask" || !event.source?.id?.startsWith(CALL_PREFIX)) return
      event.effect = "deny"
      event.message = "pr-tracker refreshes never prompt"
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== tools.create || event.status !== "completed") return
      const created = parseCreated(event.input, event.result)
      if (!created) return
      const now = Date.now()
      await update(event.sessionID, (list) =>
        upsert(list, {
          ...created,
          createdAt: now,
          checkedAt: now,
          agent: event.agent,
          messageID: event.messageID,
        }),
      )
      await changed(event.sessionID)
    })

    const controller = new AbortController()
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: controller.signal })) {
            const sessionID = (event.data as { sessionID?: string }).sessionID
            if (sessionID) await ctx.storage.remove(key(sessionID)).catch(() => undefined)
          }
        } catch {
          // The stream ends on server shutdown or transport errors; resubscribe unless disposed.
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    return () => controller.abort()
  },
})
