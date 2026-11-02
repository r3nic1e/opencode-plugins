# MCP health

When an MCP server fails, its tools are missing and the model often says that the service does not exist or that it has no access. This plugin adds a short note to each model request while there is a problem:

- an MCP server that failed, with its error;
- an MCP server that needs sign-in;
- a local reference whose path does not exist.

The note tells the model which service is down and what to ask the user. It disappears when the problem clears. Status is cached for 15 seconds, and a slow status call never blocks a model request.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@r3nic1e/opencode-mcp-health@0.1.0"],
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `expectedDown` | `[]` | MCP server names to ignore, for example a server that listens only while a helper runs. |
| `advice.down` | Ask the user to check the server, then reconnect with `/mcps` or `/reload`. | Instruction added when a server failed. |
| `advice.auth` | Ask the user to sign in through `/mcps`. | Instruction added when a server needs sign-in. |
| `advice.missing` | Do not write to the missing path; ask the user to restore it. | Instruction added when a reference path is missing. |

```jsonc
{
  "plugins": [
    {
      "package": "@r3nic1e/opencode-mcp-health@0.1.0",
      "options": {
        "expectedDown": ["demo_browser"],
        "advice": { "missing": "The host mount is missing. Ask the user to restore the mount." },
      },
    },
  ],
}
```
