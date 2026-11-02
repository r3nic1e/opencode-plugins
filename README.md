# opencode-plugins

Plugins for [OpenCode 2](https://opencode.ai/v2/docs/build/plugins). Each directory under `packages/` is one npm package.

| Package | What it does | Parts |
|---|---|---|
| [`@r3nic1e/opencode-evidence`](packages/evidence) | Records tool results, adds citation handles such as `[E17]`, and adds a TUI browser for them. | server, TUI, RPC |
| [`@r3nic1e/opencode-pr-tracker`](packages/pr-tracker) | Tracks pull requests created through the GitHub MCP and shows their status in the session sidebar. | server, TUI, RPC |
| [`@r3nic1e/opencode-mcp-args`](packages/mcp-args) | Shows MCP tool arguments above the permission prompt. | TUI only |
| [`@r3nic1e/opencode-mcp-health`](packages/mcp-health) | Tells the model which MCP servers are down or need sign-in, and which local references are missing. | server |
| [`@r3nic1e/opencode-github-guard`](packages/github-guard) | Blocks remote `git`, `gh`, and `api.github.com` calls in a sandbox that cannot make them, and tells the model what to use instead. | server |
| [`@r3nic1e/opencode-litellm-cache-scrub`](packages/litellm-cache-scrub) | Removes Anthropic prompt-cache fields from requests to gateways that reject them. | server |
| [`@r3nic1e/opencode-meridian-quota`](packages/meridian-quota) | Serves [Meridian](https://www.npmjs.com/package/@rynfar/meridian) quota to [`@slkiser/opencode-quota`](https://www.npmjs.com/package/@slkiser/opencode-quota). | server |
| [`@r3nic1e/opencode-openai-decisions`](packages/openai-decisions) | Adds an `openai_decisions` tool for the OpenAI Decisions API. | server |

## Install

Add server plugins to `plugins` in `opencode.json(c)`. Pin a version, and use the object form to pass options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@r3nic1e/opencode-evidence@0.1.0",
    {
      "package": "@r3nic1e/opencode-openai-decisions@0.1.0",
      "options": { "endpoint": "https://api.openai.com/v1/decisions", "providerID": "openai-api" },
    },
  ],
}
```

A package with only a TUI part, such as `@r3nic1e/opencode-mcp-args`, goes in `plugins` in `cli.json` instead.

Each release also has a Git tag `<directory>@<version>`, so you can install from GitHub without npm:

```sh
opencode plugin add 'github:r3nic1e/opencode-plugins#evidence@0.1.0::path:packages/evidence'
```

## Development

The packages ship TypeScript source; OpenCode loads it directly. There is no build step.

```sh
npm ci
npm run typecheck
npm test
```

## Release

1. Bump `version` in `packages/<directory>/package.json` and merge the change.
2. Push the tag `<directory>@<version>` on that commit, for example `evidence@0.2.0`.

The `release` workflow checks that the tag matches the package version, runs the checks, and publishes the package to npm with provenance. It needs the `NPM_TOKEN` repository secret.
