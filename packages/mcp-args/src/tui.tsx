/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"

// mcp-args: show MCP tool arguments above the permission prompt.
//
// The built-in prompt renders MCP calls as "Call tool <name>" and ignores the arguments that
// core attaches as `metadata.input`. The `session.composer.top` slot renders directly above the
// prompt, so this box sits on top of it.

type Request = { action: string; resources: readonly unknown[]; metadata?: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function format(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value))
}

// MCP tools assert with resources ["*"] and the raw tool input in metadata.input.
function mcpInput(request: Request | undefined): Record<string, unknown> | undefined {
  if (!request) return undefined
  if (request.resources.length !== 1 || request.resources[0] !== "*") return undefined
  const input = request.metadata?.input
  return isRecord(input) ? input : undefined
}

function Args(props: { context: Plugin.Context; action: string; args: Record<string, unknown> }) {
  const theme = props.context.theme
  const dimensions = useTerminalDimensions()
  // The permission prompt below takes up to 15 rows; leave it and the transcript room.
  const maxHeight = createMemo(() => Math.max(4, Math.floor(dimensions().height * 0.4)))
  let scroll: ScrollBoxRenderable | undefined

  // pageup/pagedown normally scroll the transcript; while a prompt waits, they scroll the arguments.
  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      { bind: "pageup", run: () => scroll?.scrollBy(-Math.max(1, maxHeight() - 2)) },
      { bind: "pagedown", run: () => scroll?.scrollBy(Math.max(1, maxHeight() - 2)) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} flexDirection="column" flexShrink={0}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text.feedback.warning.base}>Arguments for {props.action}</text>
        <text fg={theme.text.muted}>(PgUp/PgDn or mouse wheel to scroll)</text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        maxHeight={maxHeight()}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background.base,
            foregroundColor: theme.scrollbar.base,
          },
        }}
      >
        <For each={Object.entries(props.args)}>
          {([key, value]) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.text.muted} flexShrink={0}>
                {key}:
              </text>
              <text fg={theme.text.base} wrapMode="char" flexGrow={1} flexShrink={1}>
                {format(value)}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}

function McpArgs(props: { context: Plugin.Context; sessionID: string }) {
  const data = props.context.data

  // Same request order as the host prompt: this session, then its descendants.
  const request = createMemo(() => {
    const session = data.session.get(props.sessionID)
    if (session?.parentID) return undefined
    const ids = [props.sessionID, ...data.session.family(props.sessionID).filter((id) => id !== props.sessionID)]
    return ids.flatMap((id) => data.session.permission.list(id) ?? [])[0] as Request | undefined
  })
  const input = createMemo(() => mcpInput(request()))

  return (
    <Show when={input()} keyed>
      {(args: Record<string, unknown>) => <Args context={props.context} action={request()?.action ?? ""} args={args} />}
    </Show>
  )
}

export default Plugin.define({
  id: "r3nic1e.mcp-args",
  setup(context) {
    context.ui.slot({
      append: "session.composer.top",
      render: (props) => <McpArgs context={context} sessionID={props.sessionID} />,
    })
  },
})
