# MCP arguments

The built-in permission prompt shows an MCP call only as "Call tool `<name>`". This TUI plugin shows the call's arguments in a box above the prompt, so you can check what you approve.

- PgUp and PgDn scroll the arguments while a prompt waits. The mouse wheel also works.
- The box shows the first pending request of the session on screen and its subagent sessions.

## Install

The package has only a TUI part, so add it to `plugins` in `cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@r3nic1e/opencode-mcp-args@0.1.1"]
}
```
