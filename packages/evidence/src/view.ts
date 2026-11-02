import type { Evidence, Snapshot } from "./store.ts";

export function citations(messages: readonly unknown[]): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    const item = message as { type?: string; content?: { type: string; text?: string }[] };
    if (item.type !== "assistant" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type !== "text" || !part.text) continue;
      for (const match of part.text.matchAll(/\[E[1-9]\d*\]/g)) found.add(match[0].slice(1, -1));
    }
  }
  return [...found];
}

export function snapshotLines(title: string, value: Snapshot): string[] {
  return [
    `${title}: ${value.bytes} bytes; sha256 ${value.sha256}`,
    ...(value.redacted ? ["REDACTED: common credential fields or bearer tokens were removed."] : []),
    ...(value.truncated ? ["TRUNCATED: only the captured prefix is available; the hash covers the full redacted snapshot."] : []),
    ...value.text.split("\n").flatMap((line) => {
      const characters = Array.from(line);
      return Array.from({ length: Math.max(1, Math.ceil(characters.length / 64)) }, (_, i) => characters.slice(i * 64, (i + 1) * 64).join(""));
    }),
  ];
}

export function recordLines(record: Evidence): string[] {
  return [
    `[${record.ref}] ${record.tool} — ${record.status === "started" ? "incomplete; completion not captured" : record.status}`,
    `UUID: ${record.uuid}`,
    `Session: ${record.sessionID}`,
    `Message: ${record.messageID}`,
    `Call: ${record.callID}`,
    `Location: ${record.directory}`,
    ...(record.parent ? [`Code Mode parent: [${record.parent}]`] : []),
    `Input snapshot captured: ${record.captured}`,
    ...(record.finished ? [`Result snapshot captured: ${record.finished}`] : []),
    "",
    ...snapshotLines("Arguments", record.input),
    "",
    ...(record.result ? snapshotLines("Tool result at capture hook", record.result) : ["No completion snapshot. Do not treat this as a successful execution."]),
  ];
}
