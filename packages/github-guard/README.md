# GitHub guard

Some sandboxes allow only `GET` and `HEAD` requests to GitHub. Remote `git` commands, the `gh` CLI, and `api.github.com` then fail with network errors, and the model retries them in different ways. This plugin stops those calls before they run and returns a clear error that says what to use instead.

It checks `shell` (and `bash`) commands and `webfetch` URLs:

| Blocked | Allowed |
|---|---|
| `git clone`, `fetch`, `pull`, `push`, `ls-remote`, `remote update`, `submodule update`, `submodule add` to a remote | The same commands with a local path (`/`, `./`, `../`, `~/`, `file://`), and every other `git` command |
| `gh` | Ordinary `github.com`, `raw.githubusercontent.com`, and release downloads |
| `curl`, `wget`, or `webfetch` to `api.github.com` or its subdomains | Hosts that only contain `api.github.com` in a longer name |

Text inside quotes, comments, and heredoc bodies does not count as a command.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@r3nic1e/opencode-github-guard@0.1.0"],
}
```

## Options

The default messages tell the model to use a GitHub MCP server or to ask the user. Options let you describe the route that your environment provides.

| Option | Meaning |
|---|---|
| `git.note` | Sentence added after "remote `git <op>` is blocked in this environment." |
| `git.fix` | Map from operation (`fetch`, `pull`, `push`, `clone`, `ls-remote`, `remote update`, `submodule update`, `submodule add`) to the fix lines. `default` applies to operations without their own entry. |
| `gh.note`, `gh.fix` | Note and fix lines for `gh`. |
| `githubApi.note`, `githubApi.fix` | Note and fix lines for `api.github.com`. |

A `fix` value is a string or an array of lines.

```jsonc
{
  "plugins": [
    {
      "package": "@r3nic1e/opencode-github-guard@0.1.0",
      "options": {
        "git": {
          "note": "Use the host Git broker MCP.",
          "fix": {
            "push": ["Fix: push through the broker: await tools.git.push({ path, branch })"],
            "default": ["Fix: fetch through the broker: await tools.git.fetch({ path })"],
          },
        },
        "gh": { "fix": "Fix: use the GitHub MCP tools (tools.github.*)." },
      },
    },
  ],
}
```
