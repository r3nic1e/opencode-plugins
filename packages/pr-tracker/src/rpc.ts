import { Rpc } from "@opencode/plugin/rpc"

export const PrTracker = Rpc.define({
  id: "r3nic1e.pr-tracker",
  methods: {
    // With refresh, the server re-reads stale statuses in the background and emits `changed`.
    list: {
      input: {
        type: "object",
        properties: {
          sessionIDs: { type: "array", items: { type: "string" } },
          refresh: { type: "boolean" },
        },
        required: ["sessionIDs"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sessionID: { type: "string" },
                owner: { type: "string" },
                repo: { type: "string" },
                number: { type: "number" },
                url: { type: "string" },
                title: { type: "string" },
                status: { type: "string", enum: ["draft", "open", "merged", "closed"] },
                ci: { type: "string", enum: ["pending", "failure", "success", "none"] },
                createdAt: { type: "number" },
              },
              required: ["sessionID", "owner", "repo", "number", "url", "title", "status", "createdAt"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})

export type Item = {
  sessionID: string
  owner: string
  repo: string
  number: number
  url: string
  title: string
  status: "draft" | "open" | "merged" | "closed"
  ci?: "pending" | "failure" | "success" | "none"
  createdAt: number
}
