import type { Plugin } from "@opencode/plugin";
import { EvidenceRPC } from "./rpc.ts";
import { EvidenceStore, summarize, type Evidence } from "./store.ts";

const instructions = `Tool evidence is recorded by the harness, not written by you.
Cite recorded observations next to factual claims using the exact short handle, for example [E17].
Handles are local to this session. Never invent a handle or copy one from another session.
Use evidence_lookup to resolve older handles, list earlier records, or check references after compaction.
The index is not evidence itself: inspect the corresponding result before relying on it.
Distinguish your inference from the observation. A citation proves provenance, not that the claim is correct.
Snapshots can be redacted or truncated. Do not describe missing output as observed.
When summarizing for compaction, preserve cited handles and the claims they support.`;

const EvidencePlugin: Plugin.Plugin = {
  id: "evidence",
  async setup(ctx) {
    const requested = ctx.options.maxSnapshotBytes;
    const maxBytes = typeof requested === "number" && Number.isSafeInteger(requested) && requested >= 1024 && requested <= 4_194_304
      ? requested : 262_144;
    const store = new EvidenceStore(ctx.storage, maxBytes);
    const outer = new Map<string, Evidence>();
    let degraded = false;
    const key = (call: { sessionID: string; messageID: string; id: string }) =>
      JSON.stringify([call.sessionID, call.messageID, call.id]);
    const capture = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await operation();
      } catch {
        if (!degraded) console.error("[evidence] Capture failed; some executions have no complete evidence record.");
        degraded = true;
      }
    };

    const registration = await ctx.rpc.register(EvidenceRPC, {
      list: async (raw) => {
        const input = raw as { sessionID: string; after?: string };
        return store.list(input.sessionID, input.after);
      },
      get: async (raw) => {
        const input = raw as { sessionID: string; reference: string };
        return store.get(input.sessionID, input.reference);
      },
      check: async (raw) => {
        const input = raw as { sessionID: string; references: string[] };
        return store.check(input.sessionID, input.references);
      },
    });
    const notify = async (record: Evidence) => {
      try {
        await registration.events.emit("changed", { record: summarize(record) });
      } catch {}
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "evidence_lookup",
        description: "Read harness-recorded tool evidence in this session. Supply reference (E17, [E17], or UUID) for a record; references to validate citations; or neither to list records. Use after to page the list. Never reruns the tool. Output is paged as text with offset/limit.",
        input: {
          type: "object", additionalProperties: false,
          properties: {
            reference: { type: "string" },
            references: { type: "array", maxItems: 1000, items: { type: "string" } },
            after: { type: "string" },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 20_000 },
          },
        },
        options: { codemode: false },
        execute: async (raw, context) => {
          const input = raw as { reference?: string; references?: string[]; after?: string; offset?: number; limit?: number };
          const value = input.reference !== undefined
            ? await store.get(context.sessionID, input.reference)
            : input.references !== undefined
              ? await store.check(context.sessionID, input.references)
              : await store.list(context.sessionID, input.after);
          const text = JSON.stringify(value === null ? { error: "Broken citation: no evidence exists for this reference in this session." } : value, null, 2);
          const offset = input.offset ?? 0;
          const limit = input.limit ?? 12_000;
          return { content: JSON.stringify({ text: text.slice(offset, offset + limit), offset, total: text.length, nextOffset: offset + limit < text.length ? offset + limit : null }) };
        },
      });
    });

    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "execute") return;
      const record = await capture(() => store.start("execute", event.input, event, ctx.location.directory));
      if (record) {
        outer.set(key(event), record);
        await notify(record);
      }
    });
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool === "evidence_lookup") return;
      const parent = outer.get(key(event));
      const record = event.tool === "execute" && parent
        ? parent
        : await capture(() => store.start(event.tool, event.input, event, ctx.location.directory, parent?.ref));
      if (event.tool === "execute") outer.delete(key(event));
      if (record) {
        const completed = await capture(() => store.finish(record, event.status, event.status === "completed" ? event.result : event.error));
        await notify(completed ?? record);
      }
    });

    const addIndex = async (event: { sessionID: string; system: { type: "text"; text: string }[] }) => {
      const recent = await capture(() => store.recent(event.sessionID));
      const index = recent?.map(({ ref, tool, status, parent, preview, resultPreview }) => ({ ref, tool, status, parent, preview, resultPreview }));
      event.system.push({
        type: "text",
        text: `${instructions}\n${degraded ? "WARNING: Evidence capture has failed. Missing or started-only records are not complete evidence.\n" : ""}Recent execution index (previews only):\n${JSON.stringify(index ?? [])}`,
      });
    };
    await ctx.session.hook("context", addIndex);
    await ctx.session.hook("compaction", addIndex);
  },
};

export default EvidencePlugin;
