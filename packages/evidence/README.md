# Tool evidence

Records tool observations and lets you inspect the source of assistant citations. Targets OpenCode V2; checked against `2.2.3`. The plugin ID is `evidence`.

## Use

- The top of the session sidebar has an **Evidence** box. Scroll through all saved records, newest first, and click a row to inspect it.
- The box updates as tools finish. **Browse / search all** opens the searchable browser.
- Run `/evidence` or select **Browse tool evidence** in the command palette.
- Search the execution list by handle, tool, or argument preview. Select a record to inspect its captured arguments and result.
- Run `/evidence E17` or `/evidence <uuid>` to open one record directly.
- Missing citations appear as **BROKEN CITATION** in the browser. The check scans assistant text in the session's available message history.

The plugin assigns each recorded invocation a UUID and a session-local handle such as `[E17]`. It adds citation instructions and an index of the latest 30 records to model requests. The assistant can use `evidence_lookup` to retrieve older records, page through large records, or validate references after compaction.

The UI only reads snapshots. It never reruns commands. Inline citation links in assistant messages are not implemented; use the sidebar, browser, or direct lookup instead.

## Install

Add the package to `plugins` in `opencode.json(c)`. The package exports server, TUI, and RPC parts; the TUI loads its part automatically and uses OpenCode's Solid and OpenTUI runtime.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@r3nic1e/opencode-evidence@0.1.3",
      "options": { "maxSnapshotBytes": 262144 }
    }
  ]
}
```

`maxSnapshotBytes` bounds each argument or result snapshot. The default is 256 KiB; accepted values are 1 KiB through 4 MiB. Invalid values use the default.

## What a record means

Records contain the session, message, native call ID, tool name, plugin location, captured arguments, result or error, and capture timestamps. A shell's explicit working directory stays in its arguments; the plugin location is not necessarily the shell's working directory.

The recorder uses `execute.after` hooks, including for nested Code Mode tools and tools registered by later plugins. Each completed invocation gets its own UUID even when parallel nested calls share a native call ID. Short handles follow capture order, not source-code order.

The outer Code Mode `execute` gets an initial record before execution. Nested records link to that parent. An outer record with status `started` has no captured completion; it does not prove that execution is still running or that it succeeded.

Other tools are recorded when their completion hook runs. Interruption, validation failure, permission rejection, or a plugin that stops execution before that hook can leave no record. `evidence_lookup` excludes itself to avoid recursively storing retrieved history. Code Mode's `fetch` and `search` helpers are not separate registered tool invocations; only the outer execution covers them. User shell commands outside tool execution are not captured.

Snapshots show the result at this plugin's capture hook. Another plugin can modify it later, and OpenCode can normalize content or images afterward. A nested tool's full result is not necessarily what the model saw after Code Mode filtered it. Snapshot timestamps are capture times, not execution durations. Background tools capture the immediate tool response, not later job output unless another tool reads it.

## Storage and privacy

Records use OpenCode's durable, plugin-scoped local storage, partitioned by session. They survive plugin reloads, server restarts, and context compaction. Removing a session does not automatically delete this plugin's records. There is no retention cleanup or export command in this version.

The recorder removes common credential-key values and bearer tokens before saving. This is best-effort redaction, not a secret scanner: arbitrary secrets in command strings, URLs, or file contents can remain. The original tool arguments and results are not modified.

Each snapshot includes its full redacted byte count, SHA-256 hash, and explicit redaction and truncation flags. The hash covers the full redacted JSON serialization, not the original secret-bearing result. Truncation stores only a UTF-8-safe prefix; the omitted tail cannot be recovered from this plugin. Upstream tools may already truncate their own output.

If capture fails, the original tool still returns or throws normally. The plugin logs a generic warning and adds a capture warning to subsequent model requests. Partial records remain visibly incomplete. Concurrent allocation is serialized within one server process; do not use separate server processes writing the same OpenCode database.

Valid references prove that a record exists in this session. They do not prove that its contents support a claim, identify the assistant's internal reasoning, or provide tamper-resistant audit storage.

## Development

From the repository root, run:

```sh
node --test packages/evidence/test/evidence.test.mjs
```

Tests cover SQLite persistence, concurrent nested calls, session isolation, pagination, redaction, bounded snapshots, capture failures, model and compaction instructions, read-only TUI browsing, and sidebar live updates and cleanup.
