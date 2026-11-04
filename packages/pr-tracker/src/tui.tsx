import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { PrTracker, type Item } from "./rpc.ts"

// The sidebar shows only for the session on screen, so the poll runs only while that session is open.
const POLL_MS = 60_000
const PULSE = ["·", "•", "●", "•"]
const PULSE_MS = 250

const ciOf = (item: Item) =>
  (item.status === "open" || item.status === "draft") && item.ci && item.ci !== "none" ? item.ci : undefined

function SidebarPrs(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const data = props.context.data
  const rpc = props.context.client.rpc(PrTracker)
  const [items, setItems] = createSignal<Item[]>([])

  // Subagent sessions create PRs too; the sidebar shows the whole family under the root.
  const family = createMemo(() => [
    props.sessionID,
    ...data.session.family(props.sessionID).filter((id) => id !== props.sessionID),
  ])

  // A reply that arrives after a newer request is stale.
  let turn = 0
  const load = (refresh: boolean) => {
    const current = ++turn
    const sessionID = props.sessionID
    const directory = data.session.get(sessionID)?.location.directory
    void rpc
      .list({ sessionIDs: family(), refresh }, directory ? { location: { directory } } : undefined)
      .then(
        (reply) => {
          if (current === turn && sessionID === props.sessionID) setItems((reply as { items: Item[] }).items)
        },
        () => undefined,
      )
  }

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setItems([])
        load(true)
      },
    ),
  )
  createEffect(on(() => family().join("\0"), () => load(false), { defer: true }))

  const timer = setInterval(() => {
    if (items().some((item) => item.status !== "merged")) load(true)
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))
  onCleanup(
    rpc.events.on("changed", (event) => {
      if (family().includes((event.data as { sessionID: string }).sessionID)) load(false)
    }),
  )
  onCleanup(data.on("server.connected", () => load(true)))

  const [frame, setFrame] = createSignal(0)
  const pending = createMemo(() => items().some((item) => ciOf(item) === "pending"))
  createEffect(() => {
    if (!pending()) return
    const pulse = setInterval(() => setFrame((n) => (n + 1) % PULSE.length), PULSE_MS)
    onCleanup(() => clearInterval(pulse))
  })

  const color = (status: Item["status"]) => {
    if (status === "open") return theme.text.feedback.success.base
    if (status === "merged") return theme.text.feedback.info.base
    if (status === "closed") return theme.text.feedback.error.base
    return theme.text.muted
  }

  const ciColor = (ci: NonNullable<Item["ci"]>) => {
    if (ci === "failure") return theme.text.feedback.error.base
    if (ci === "pending") return theme.text.feedback.warning.base
    return theme.text.feedback.success.base
  }

  return (
    <Show when={items().length > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Pull requests</b>
        </text>
        <For each={items()}>
          {(item) => (
            <box flexDirection="row" gap={1} minWidth={0}>
              <text flexShrink={0} style={{ fg: color(item.status) }}>
                •
              </text>
              <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                <a href={item.url}>
                  <b>{item.repo}</b> #{item.number}
                </a>
              </text>
              <Show when={ciOf(item)}>
                <text fg={ciColor(ciOf(item)!)} flexShrink={0}>
                  {ciOf(item) === "pending" ? PULSE[frame()] : "●"}
                </text>
              </Show>
              <text fg={color(item.status)} wrapMode="none" flexShrink={0}>
                {item.status}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "r3nic1e.pr-tracker.tui",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarPrs context={context} sessionID={props.sessionID} />,
    })
  },
})
