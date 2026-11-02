import type { Plugin } from "@opencode/plugin";

type Question =
  | { type: "predicate"; instructions: string; name?: string }
  | { type: "choice"; instructions: string; name?: string; choices: { value: string | boolean; description?: string }[] }
  | { type: "score"; instructions: string; name?: string; levels: { label: string; description?: string }[] };

type DecisionInput = {
  model?: string;
  input: string | {
    role: "user";
    type?: "message";
    content: string | (
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" | "original" | null }
    )[];
  }[];
  questions: Question[];
  safety_identifier?: string | null;
};

export type DecisionsOptions = { endpoint: string; providerID: string; model: string };

export function parseOptions(options: unknown): DecisionsOptions {
  const raw = (options ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  // Gateways such as LiteLLM serve Decisions on a pass-through route, so the endpoint cannot be derived from baseURL.
  const endpoint = text(raw.endpoint);
  if (!endpoint) throw new Error("openai-decisions: set options.endpoint to the Decisions URL, for example https://api.openai.com/v1/decisions.");
  return { endpoint, providerID: text(raw.providerID) ?? "litellm", model: text(raw.model) ?? "gpt-6-luna" };
}

// Contract: openai/openai-python src/openai/types/decision_create_params.py.
const inputSchema = (defaultModel: string) => ({
  type: "object",
  required: ["input", "questions"],
  additionalProperties: false,
  properties: {
    model: { type: "string", minLength: 1, description: `A Decisions model the endpoint serves. Defaults to ${defaultModel}.` },
    input: {
      description: "Shared evidence. Images must be inline base64 data URLs; at most 128 images per request.",
      oneOf: [
        { type: "string" },
        {
          type: "array",
          items: {
            type: "object",
            required: ["role", "content"],
            additionalProperties: false,
            properties: {
              role: { type: "string", enum: ["user"] },
              type: { type: "string", enum: ["message"] },
              content: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "array",
                    items: {
                      oneOf: [
                        {
                          type: "object",
                          required: ["type", "text"],
                          additionalProperties: false,
                          properties: { type: { type: "string", enum: ["input_text"] }, text: { type: "string" } },
                        },
                        {
                          type: "object",
                          required: ["type", "image_url"],
                          additionalProperties: false,
                          properties: {
                            type: { type: "string", enum: ["input_image"] },
                            image_url: { type: "string", pattern: "^data:image/[^;,]+;base64," },
                            detail: { type: ["string", "null"], enum: ["low", "high", "auto", "original", null] },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
    questions: {
      type: "array",
      minItems: 1,
      items: {
        oneOf: ["predicate", "choice", "score"].map((type) => ({
          type: "object",
          required: ["type", "instructions", ...(type === "choice" ? ["choices"] : type === "score" ? ["levels"] : [])],
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: [type] },
            instructions: { type: "string" },
            name: { type: "string" },
            ...(type === "choice" ? {
              choices: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["value"],
                  additionalProperties: false,
                  properties: { value: { type: ["string", "boolean"] }, description: { type: "string" } },
                },
              },
            } : {}),
            ...(type === "score" ? {
              levels: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["label"],
                  additionalProperties: false,
                  properties: { label: { type: "string" }, description: { type: "string" } },
                },
              },
            } : {}),
          },
        })),
      },
    },
    safety_identifier: { type: ["string", "null"], description: "Optional opaque end-user identifier; do not use credentials or personal data." },
  },
});

const OpenAIDecisions: Plugin.Plugin = {
  id: "openai-decisions",
  async setup(ctx) {
    const { endpoint, providerID, model: defaultModel } = parseOptions(ctx.options);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "openai_decisions",
        description: `Evaluate ordered predicate (probability), choice (classification), or score questions against shared evidence using OpenAI's Decisions API. Returns answers, confidence/probability distributions, refusals, and token usage unchanged. Uses the ${providerID} provider's token; model defaults to ${defaultModel}.`,
        input: inputSchema(defaultModel),
        options: { codemode: true },
        execute: async (raw, context) => {
          const input = raw as DecisionInput;
          const images = typeof input.input === "string" ? 0 : input.input.reduce((count, message) =>
            count + (typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "input_image").length), 0);
          if (images > 128) throw new Error("Decisions supports at most 128 inline images per request.");

          const { data: provider } = await ctx.provider.get({ providerID }, { signal: context.signal });
          const connection = await ctx.integration.connection.active(provider.integrationID ?? providerID);
          const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
          const settings = provider.settings ?? {};
          const key = credential?.type === "oauth" ? credential.access : credential?.type === "key" ? credential.key : settings.apiKey;
          const headers = new Headers(provider.headers);
          if (typeof key === "string" && key) headers.set("Authorization", `Bearer ${key}`);
          if (!headers.has("Authorization")) throw new Error(`No token is configured for the ${providerID} provider. Set its apiKey or connect it first.`);
          headers.set("Content-Type", "application/json");
          headers.set("Accept", "application/json");

          const timeout = settings.timeout === false ? undefined : typeof settings.timeout === "number" ? settings.timeout : 120_000;
          const signal = timeout === undefined ? context.signal : AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]);
          const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...input, model: input.model ?? defaultModel }),
            signal,
            redirect: "error",
          });
          // Error bodies may echo evidence or credentials; keep them out of session history.
          if (!response.ok) {
            await response.body?.cancel();
            const hint = response.status === 401 ? " The endpoint did not accept the token." : ` Check that the endpoint serves Decisions for this model (default ${defaultModel}).`;
            throw new Error(`OpenAI Decisions request failed (HTTP ${response.status}).${hint}`);
          }
          return { content: JSON.stringify(await response.json(), null, 2) };
        },
      });
    });
  },
};

export default OpenAIDecisions;
