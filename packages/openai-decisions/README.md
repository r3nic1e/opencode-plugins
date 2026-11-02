# OpenAI Decisions tool

Registers an `openai_decisions` tool, also available to Code Mode. It evaluates ordered predicate (probability), choice (classification), and score questions against shared evidence with the OpenAI Decisions API. Existing permissions still apply; the plugin grants none.

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@r3nic1e/opencode-openai-decisions@0.1.0",
      "options": {
        "endpoint": "https://litellm.example.com/openai/v1/decisions",
        "providerID": "litellm",
      },
    },
  ],
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `endpoint` | required | Full Decisions URL. The plugin fails to load without it. |
| `providerID` | `litellm` | OpenCode provider whose credentials the tool uses. |
| `model` | `gpt-6-luna` | Model used when a call does not set `model`. |

The tool does not derive the URL from the provider's `settings.baseURL`, because gateways serve Decisions on other routes. For example, LiteLLM serves it on its OpenAI pass-through route, `/openai/v1/decisions`; its own `/v1/decisions` returns 404. For the OpenAI API, use `https://api.openai.com/v1/decisions` with a provider that holds an OpenAI API key. A ChatGPT subscription token is not accepted by Decisions.

The token comes from the provider: an active integration connection if one exists, otherwise `settings.apiKey` or a configured `Authorization` header. Provider `settings.timeout` is honored (milliseconds; `false` disables the timeout), with a default of 120 seconds. Session cancellation aborts the request. Requests are not retried. Error responses report only the HTTP status, because their bodies can echo evidence or credentials.

## Tool input

```json
{
  "input": "The proposed migration removes the old database before verifying the new replica.",
  "questions": [
    { "type": "predicate", "name": "unsafe", "instructions": "Does this migration risk data loss?" },
    {
      "type": "choice", "name": "action", "instructions": "Choose the next action.",
      "choices": [{ "value": "proceed" }, { "value": "revise" }]
    },
    {
      "type": "score", "name": "risk", "instructions": "Assess migration risk using the ordered levels.",
      "levels": [{ "label": "low" }, { "label": "medium" }, { "label": "high" }]
    }
  ]
}
```

Input may also contain `user` messages with strings or `input_text` and `input_image` parts. Images must be base64 data URLs (maximum 128 per request). Choice values may be strings or booleans. An optional `safety_identifier` is passed through. Results preserve the API's answer order, distributions, refusals, model, and usage; a refusal is not converted into a scored answer.

The API contract follows the official [OpenAI Python SDK](https://github.com/openai/openai-python/blob/main/src/openai/resources/decisions.py) and its [request types](https://github.com/openai/openai-python/blob/main/src/openai/types/decision_create_params.py).
