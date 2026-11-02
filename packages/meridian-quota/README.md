# Meridian quota bridge

Shows the Anthropic quota that [Meridian](https://www.npmjs.com/package/@rynfar/meridian) reports in [`@slkiser/opencode-quota`](https://www.npmjs.com/package/@slkiser/opencode-quota).

`opencode-quota` cannot read Meridian directly:

1. A custom quota provider URL must be HTTPS or loopback HTTP. Meridian on the host of a sandbox, such as `http://host.docker.internal:3456`, is neither.
2. The `json-v1` adapter cannot index Meridian's `buckets[]` array or give each window its own name.

The plugin listens on `127.0.0.1` and serves Meridian's payload in the native `quota-v1` format at `/quota`. It shows the 5-hour, weekly, and weekly Fable windows, the monthly extra usage (or the `overage` bucket when extra usage is missing), and a note when Meridian's OAuth source is unavailable.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@slkiser/opencode-quota@6.0.0",
    "@r3nic1e/opencode-meridian-quota@0.1.1",
  ],
}
```

Then add a custom provider to the `opencode-quota` settings file (`~/.config/opencode/opencode-quota/settings.jsonc`):

```jsonc
{
  "version": 6,
  "providers": {
    "off": ["anthropic"],
    "custom": [
      {
        "id": "meridian-anthropic",
        "providerId": "anthropic",
        "label": "Meridian",
        "mode": "remote-api",
        "format": "quota-v1",
        "url": "http://127.0.0.1:39456/quota",
        "apiKeyEnv": "ANTHROPIC_API_KEY",
      },
    ],
  },
}
```

Turn off the built-in `anthropic` quota provider: it reads local Claude OAuth credentials and calls `api.anthropic.com` directly.

## Options

Options take precedence over environment variables.

| Option | Environment variable | Default |
|---|---|---|
| `upstream` | `MERIDIAN_QUOTA_URL` | `http://host.docker.internal:3456/v1/usage/quota` |
| `port` | `MERIDIAN_QUOTA_BRIDGE_PORT` | `39456` |

If the port is already in use, the plugin assumes that another instance serves it.
