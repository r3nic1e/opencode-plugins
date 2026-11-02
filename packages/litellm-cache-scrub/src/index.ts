import type { Plugin } from "@opencode/plugin";

// LiteLLM rejects Anthropic prompt-cache fields on its Chat Completions route.
const STRIP_KEYS = new Set(["cache_control", "cacheControl", "promptCacheKey"]);

export function scrub(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = scrub(item) || changed;
    return changed;
  }
  for (const key of Object.keys(value)) {
    if (STRIP_KEYS.has(key)) {
      delete value[key];
      changed = true;
      continue;
    }
    changed = scrub(value[key]) || changed;
  }
  return changed;
}

export async function scrubRequest(request: Request): Promise<Request> {
  if (!request.body || !(request.headers.get("content-type") ?? "").includes("json")) return request;
  let payload: unknown;
  try {
    payload = JSON.parse(await request.clone().text());
  } catch {
    return request;
  }
  if (!scrub(payload)) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { body: JSON.stringify(payload), headers });
}

export function providerIDs(options: unknown): string[] {
  const value = (options as { providerIDs?: unknown } | undefined)?.providerIDs;
  if (!Array.isArray(value)) return ["litellm"];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

const LiteLLMFetchScrub: Plugin.Plugin = {
  id: "litellm-fetch-scrub",
  async setup(ctx) {
    for (const providerID of providerIDs(ctx.options)) {
      await ctx.session.hook("http.request", async (event) => {
        event.request = await scrubRequest(event.request);
      }, { providerID });
    }
  },
};

export default LiteLLMFetchScrub;
