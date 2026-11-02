import type { Plugin } from "@opencode/plugin/tui";
import { EvidenceRPC } from "./rpc.ts";
import type { Evidence, Page, Summary } from "./store.ts";
import { citations, recordLines } from "./view.ts";

type Check = { valid: string[]; broken: string[] };

export function setupBrowser(ctx: Plugin.Context) {
  const rpc = ctx.client.rpc(EvidenceRPC);
  const options = () => ({ location: ctx.location ?? ctx.data.location.default() });
  const session = () => {
    const route = ctx.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const inspect = async (sessionID: string, reference: string) => {
    const record = await rpc.get({ sessionID, reference }, options()) as Evidence | null;
    if (!record) {
      await ctx.ui.dialog.alert({ title: "Broken evidence citation", message: `No record for ${reference} exists in this session.` });
      return;
    }
    const lines = recordLines(record);
    ctx.ui.dialog.set({ size: "xlarge" });
    await ctx.ui.dialog.select({
      title: `[${record.ref}] ${record.tool} — captured evidence (read-only)`,
      placeholder: "Search captured arguments and output",
      options: lines.map((line, i) => ({ title: line || " ", value: i })),
    });
  };
  const browse = async (sessionID: string) => {
    const items: Summary[] = [];
    let after: string | undefined;
    do {
      const page = await rpc.list({ sessionID, ...(after ? { after } : {}) }, options()) as Page;
      items.push(...page.items);
      after = page.next;
    } while (after);
    await ctx.data.session.message.sync(sessionID);
    const references = citations(ctx.data.session.message.list(sessionID));
    const check: Check = { valid: [], broken: [] };
    for (let offset = 0; offset < references.length; offset += 1000) {
      const page = await rpc.check({ sessionID, references: references.slice(offset, offset + 1000) }, options()) as Check;
      check.valid.push(...page.valid);
      check.broken.push(...page.broken);
    }
    if (!items.length && !check.broken.length) {
      await ctx.ui.dialog.alert({ title: "Evidence", message: "No executions recorded in this session yet. Recording starts when the plugin is loaded." });
      return;
    }
    ctx.ui.dialog.set({ size: "xlarge" });
    const selected = await ctx.ui.dialog.select({
      title: `Evidence — ${items.length} executions, ${check.broken.length} broken citations`,
      placeholder: "Search handles, tools, or argument previews",
      options: [
        ...check.broken.map((ref) => ({ title: `[${ref}] BROKEN CITATION`, value: ref, description: "No execution record in this session" })),
        ...items.toReversed().map((item) => ({
          title: `[${item.ref}] ${item.tool} — ${item.status}${item.parent ? ` (in ${item.parent})` : ""}`,
          value: item.ref,
          description: item.preview,
        })),
      ],
    });
    if (selected) await inspect(sessionID, selected);
  };
  const open = async (sessionID: string, reference?: string) => {
    try {
      if (reference?.trim()) await inspect(sessionID, reference.trim());
      else await browse(sessionID);
    } catch {
      ctx.ui.toast.show({ message: "Cannot load evidence. Check that the evidence server plugin is active at this location.", variant: "error" });
    }
  };
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "evidence.open",
      title: "Browse tool evidence",
      group: "Evidence",
      palette: true,
      slash: { name: "evidence", arguments: true },
      run: async (input) => {
        const sessionID = session();
        if (!sessionID) {
          ctx.ui.toast.show({ message: "Open a session to inspect its evidence.", variant: "info" });
          return;
        }
        await open(sessionID, input);
      },
    }],
  }));
  return open;
}
