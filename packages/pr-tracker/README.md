# PR tracker

Remembers the pull requests that the agent creates through the GitHub MCP in each session, and shows them with their status (draft, open, merged, closed) in the session sidebar. Subagent sessions count toward their root session.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@r3nic1e/opencode-pr-tracker@0.1.0"],
}
```

The TUI part loads with the server part.

## How it works

- After a successful call to the create tool, the plugin reads the PR URL from the result and stores the PR in plugin storage for that session.
- While the session is on screen, the sidebar asks for an update every 60 seconds. The server re-reads stale PRs with the read tool, as the agent that created the PR. These calls do not show in the transcript.
- A status refresh never prompts. If your permission rules would ask, the plugin denies its own call and keeps the last known status.
- Merged PRs are final and are not refreshed again. Storage for a session is removed when the session is deleted.

## Options

| Option | Default | Meaning |
|---|---|---|
| `createTool` | `github_create_pull_request` | Tool whose completed calls create a PR. |
| `readTool` | `github_pull_request_read` | Tool called with `{ method: "get", owner, repo, pullNumber }` to read PR status. |

The defaults match the [GitHub MCP server](https://github.com/github/github-mcp-server) registered as `github`. Change them if you register the server under another name.

```jsonc
{
  "plugins": [
    {
      "package": "@r3nic1e/opencode-pr-tracker@0.1.0",
      "options": { "createTool": "gh_create_pull_request", "readTool": "gh_pull_request_read" },
    },
  ],
}
```
