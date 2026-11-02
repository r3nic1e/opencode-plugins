/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { setupBrowser } from "./browser.ts";
import { watchEvidence, type EvidenceState } from "./feed.ts";
import { EvidenceRPC } from "./rpc.ts";
import type { Page, Summary } from "./store.ts";

function EvidenceBox(props: {
  context: Plugin.Context;
  sessionID: string;
  open: (sessionID: string, reference?: string) => Promise<void>;
}) {
  const ctx = props.context;
  const theme = ctx.theme;
  const [state, setState] = createSignal<EvidenceState>({ items: [], loading: true, failed: false });
  let refresh = () => {};
  createEffect(on(() => props.sessionID, (sessionID) => {
    setState({ items: [], loading: true, failed: false });
    const rpc = ctx.client.rpc(EvidenceRPC);
    const feed = watchEvidence(sessionID, {
      list: async (after) => rpc.list({ sessionID, ...(after ? { after } : {}) }, {
        location: ctx.location ?? ctx.data.location.default(),
      }) as Promise<Page>,
      changed: (receive) => rpc.events.on("changed", (event) => receive((event.data as { record: Summary }).record)),
      reconnected: (receive) => ctx.data.on("server.connected", receive),
    }, setState);
    refresh = () => { void feed.refresh(); };
    onCleanup(() => feed.dispose());
  }));

  const color = (status: Summary["status"]) => status === "error"
    ? theme.text.feedback.error.base : status === "started" ? theme.text.muted : theme.text.base;

  return (
    <box border borderColor={theme.text.muted} paddingX={1} flexShrink={0}>
      <text fg={theme.text.base} onMouseUp={() => void props.open(props.sessionID)}>
        <b>Evidence ({state().items.length})</b>
      </text>
      <Show when={state().failed}>
        <text fg={theme.text.feedback.error.base} onMouseUp={() => refresh()}>Could not refresh. Click to retry.</text>
      </Show>
      <Show when={state().loading}><text fg={theme.text.muted}>Loading…</text></Show>
      <Show when={!state().loading && !state().failed && state().items.length === 0}>
        <text fg={theme.text.muted}>No evidence recorded yet.</text>
      </Show>
      <Show when={state().items.length > 0}>
        <scrollbox height={Math.min(state().items.length, 10)}>
          <For each={state().items}>
            {(item) => (
              <text fg={color(item.status)} wrapMode="none" truncate
                onMouseUp={(event) => {
                  event.stopPropagation();
                  if (event.button === 0) void props.open(props.sessionID, item.ref);
                }}>
                [{item.ref}] {item.tool}{item.status === "error" ? " · error" : item.status === "started" ? " · incomplete" : ""}
              </text>
            )}
          </For>
        </scrollbox>
      </Show>
      <text fg={theme.text.muted} onMouseUp={() => void props.open(props.sessionID)}>Browse / search all</text>
    </box>
  );
}

const EvidenceTUI: Plugin.Definition = {
  id: "evidence.tui",
  setup(ctx) {
    const open = setupBrowser(ctx);
    ctx.ui.slot({
      prepend: "sidebar.content",
      render: (props) => <EvidenceBox context={ctx} sessionID={props.sessionID} open={open} />,
    });
  },
};

export default EvidenceTUI;
