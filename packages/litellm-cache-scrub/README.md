# LiteLLM cache scrub

LiteLLM's Chat Completions route rejects the Anthropic prompt-cache fields that OpenCode adds for Anthropic models (`cache_control`, `cacheControl`, `promptCacheKey`). This plugin removes those fields from JSON request bodies before OpenCode sends them to the selected providers. Other providers are not affected.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@r3nic1e/opencode-litellm-cache-scrub@0.1.1"],
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `providerIDs` | `["litellm"]` | OpenCode provider IDs whose requests the plugin scrubs. |

```jsonc
{
  "plugins": [
    { "package": "@r3nic1e/opencode-litellm-cache-scrub@0.1.1", "options": { "providerIDs": ["litellm", "gateway"] } },
  ],
}
```
