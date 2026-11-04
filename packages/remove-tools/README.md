# Remove tools

Removes the tools named in its options from every session, including OpenCode's built-in ones. Use it to take a tool away from the model instead of denying it with a permission rule: a removed tool is absent from the catalog and from Code Mode search, so the model never tries it.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@r3nic1e/opencode-remove-tools@0.1.0",
      "options": { "tools": ["session_move"] },
    },
  ],
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `tools` | `[]` | Tool names to remove. A name matches the effective tool ID with or without the `opencode` namespace and with `.` or `_` as the separator, so `session_move` removes `opencode.session_move`. Without a list the plugin does nothing. |

The transform runs after the tools registered before it, so list the plugin after any plugin whose tool it should remove. OpenCode replays transforms on every reload; removed tools stay removed until the plugin is unloaded.
