import type { Page, Summary } from "./store.ts";

export type EvidenceState = { items: Summary[]; loading: boolean; failed: boolean };
type Source = {
  list: (after?: string) => Promise<Page>;
  changed: (receive: (record: Summary) => void) => () => void;
  reconnected: (receive: () => void) => () => void;
};

export function watchEvidence(sessionID: string, source: Source, update: (state: EvidenceState) => void) {
  let records = new Map<string, Summary>();
  let pending: Map<string, Summary> | undefined;
  let active = true;
  let generation = 0;
  let loading = false;
  let failed = false;
  const merge = (target: Map<string, Summary>, record: Summary) => {
    const previous = target.get(record.ref);
    if (previous && previous.status !== "started" && record.status === "started") return;
    target.set(record.ref, record);
  };
  const publish = () => update({
    items: [...records.values()].sort((a, b) => Number(b.ref.slice(1)) - Number(a.ref.slice(1))),
    loading,
    failed,
  });
  const refresh = async () => {
    if (!active) return;
    const current = ++generation;
    const changes = new Map<string, Summary>();
    pending = changes;
    loading = true;
    failed = false;
    publish();
    try {
      const snapshot = new Map<string, Summary>();
      let after: string | undefined;
      do {
        const page = await source.list(after);
        if (!active || current !== generation) return;
        for (const item of page.items) merge(snapshot, item);
        after = page.next;
      } while (after);
      for (const item of changes.values()) merge(snapshot, item);
      records = snapshot;
    } catch {
      if (!active || current !== generation) return;
      failed = true;
    }
    pending = undefined;
    loading = false;
    publish();
  };
  const stopChanged = source.changed((record) => {
    if (!active || record.sessionID !== sessionID) return;
    merge(records, record);
    if (pending) merge(pending, record);
    publish();
  });
  const stopReconnect = source.reconnected(() => { void refresh(); });
  const ready = refresh();
  return {
    ready,
    refresh,
    dispose() {
      active = false;
      generation++;
      stopChanged();
      stopReconnect();
    },
  };
}
