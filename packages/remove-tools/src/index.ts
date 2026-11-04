import type { Plugin } from "@opencode/plugin";

export function parseOptions(options: unknown): readonly string[] {
  const raw = (options ?? {}) as { tools?: unknown };
  return Array.isArray(raw.tools) ? raw.tools.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
}

// The registry lists built-in tools as `opencode.session_move`; the documented effective name is `opencode_session_move`.
export function removable(id: string, names: readonly string[]): boolean {
  const flat = id.replace(/\./g, "_");
  return names.some((name) => {
    const wanted = name.replace(/\./g, "_");
    return flat === wanted || flat === `opencode_${wanted}`;
  });
}

const RemoveTools: Plugin.Plugin = {
  id: "remove-tools",
  async setup(ctx) {
    const names = parseOptions(ctx.options);
    if (!names.length) return;
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (removable(tool.id, names)) editor.remove(tool.id);
      }
    });
  },
};

export default RemoveTools;
