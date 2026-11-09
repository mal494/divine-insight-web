/**
 * Journal — Pro reading log.
 *
 * Only reachable when SubscriptionContext says the visitor has Pro (and is
 * also wrapped in PremiumGate by the caller).
 *
 * - Pro UI flag on (VITE_PRO_UI_ENABLED=true): reads and writes the signed-in
 *   user's own entries through the Pro-gated /api/pro/journal API.
 * - Flag off (only reachable via the DEV PremiumDevToggle override): shows the
 *   sample entries as a design preview and makes no network calls.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useSubscription } from "~/context/SubscriptionContext";
import { journalClient, journalErrorMessage } from "~/lib/journal/client";
import type { JournalEntry } from "~/lib/journal/types";

export const SAMPLE_ENTRIES = [
  {
    title: "Past · Present · Future",
    date: "A quiet Tuesday",
    note: "Three cards on clarity — the present held more weight than the path behind.",
  },
  {
    title: "Celtic Cross",
    date: "Last new moon",
    note: "Foundation and outcome agreed: something soft is asking to be named.",
  },
  {
    title: "Vector score · 4 / 5",
    date: "This week",
    note: "Alignment ran high across the draw — keep the question close.",
  },
] as const;

const CARD_CLS =
  "border border-gold-500/20 bg-night-900/50 px-6 py-5 text-left backdrop-blur-sm sm:px-8 sm:py-6";
const INPUT_CLS =
  "w-full rounded border border-gold-500/30 bg-night-900/75 px-4 py-2 text-sm text-cream-100 placeholder:text-cream-100/35 focus:border-gold-400/70 focus:outline-none";
const BTN_CLS =
  "cursor-pointer rounded-full border border-gold-500/50 px-4 py-1.5 text-[11px] tracking-[0.14em] text-gold-300 uppercase transition hover:bg-gold-500/10 disabled:opacity-50";

function Header() {
  return (
    <div className="text-center">
      <p className="text-[10px] tracking-[0.45em] text-gold-400 uppercase sm:text-xs">Your archive</p>
      <h2 className="mt-4 font-display text-4xl font-medium tracking-[0.08em] text-cream-50 sm:text-5xl">Journal</h2>
      <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-cream-100/55">
        Every reading you choose to keep lands here — a quiet ledger of
        questions, spreads, and the threads you chose to return to.
      </p>
    </div>
  );
}

function SampleJournal() {
  return (
    <ul className="mx-auto mt-12 max-w-2xl space-y-5" data-journal="sample">
      {SAMPLE_ENTRIES.map((entry) => (
        <li key={entry.title} className={CARD_CLS}>
          <p className="text-[10px] tracking-[0.35em] text-gold-400/80 uppercase">{entry.date}</p>
          <p className="mt-2 font-display text-2xl tracking-[0.06em] text-cream-50">{entry.title}</p>
          <p className="mt-2 text-sm leading-relaxed text-cream-100/65">{entry.note}</p>
        </li>
      ))}
    </ul>
  );
}

function EntryItem({
  entry,
  onSave,
  onDelete,
}: {
  entry: JournalEntry;
  onSave: (id: string, note: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(entry.note);
  const [busy, setBusy] = useState(false);
  return (
    <li className={CARD_CLS}>
      <p className="text-[10px] tracking-[0.35em] text-gold-400/80 uppercase">
        {new Date(entry.createdAt).toLocaleDateString()}
        {entry.spread ? ` · ${entry.spread}` : ""}
      </p>
      <p className="mt-2 font-display text-2xl tracking-[0.06em] text-cream-50">{entry.title}</p>
      {editing ? (
        <textarea className={`${INPUT_CLS} mt-2`} rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
      ) : (
        entry.note && <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-cream-100/65">{entry.note}</p>
      )}
      <div className="mt-3 flex gap-2">
        {editing ? (
          <button
            type="button"
            className={BTN_CLS}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(entry.id, note);
              setBusy(false);
              setEditing(false);
            }}
          >
            Save
          </button>
        ) : (
          <button type="button" className={BTN_CLS} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button
          type="button"
          className={BTN_CLS}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onDelete(entry.id);
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function LiveJournal() {
  const api = useMemo(
    () => journalClient((input, init) => (typeof window === "undefined" ? Promise.reject(new Error("ssr")) : window.fetch(input, init))),
    [],
  );
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await api.list();
    if (r.ok) {
      setEntries(r.value);
      setError(null);
    } else {
      setEntries([]);
      setError(journalErrorMessage(r.error, r.status));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const r = await api.create({ title: title.trim(), note });
    setSaving(false);
    if (!r.ok) return setError(journalErrorMessage(r.error, r.status));
    setEntries((prev) => [r.value, ...(prev ?? [])]);
    setTitle("");
    setNote("");
  }

  async function save(id: string, nextNote: string) {
    const r = await api.update(id, { note: nextNote });
    if (!r.ok) return setError(journalErrorMessage(r.error, r.status));
    setEntries((prev) => (prev ?? []).map((x) => (x.id === id ? r.value : x)));
  }

  async function remove(id: string) {
    const r = await api.remove(id);
    if (!r.ok) return setError(journalErrorMessage(r.error, r.status));
    setEntries((prev) => (prev ?? []).filter((x) => x.id !== id));
  }

  return (
    <div className="mx-auto mt-12 max-w-2xl space-y-5" data-journal="live">
      <form onSubmit={add} className={`${CARD_CLS} space-y-3`}>
        <input className={INPUT_CLS} placeholder="Title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className={INPUT_CLS} placeholder="Notes (optional)" rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" className={BTN_CLS} disabled={saving || !title.trim()}>
          Add entry
        </button>
      </form>
      {error && (
        <p role="alert" className="text-center text-sm text-cream-100/70">
          {error}
        </p>
      )}
      {entries === null ? (
        <p className="text-center text-sm text-cream-100/50">Loading your journal…</p>
      ) : entries.length === 0 && !error ? (
        <p className="text-center text-sm text-cream-100/50">No entries yet.</p>
      ) : (
        <ul className="space-y-5">
          {entries.map((entry) => (
            <EntryItem key={entry.id} entry={entry} onSave={save} onDelete={remove} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function Journal() {
  const { proUiEnabled } = useSubscription();
  return (
    <section aria-label="Reading journal" className="animate-fade-up scroll-mt-24 pt-10 pb-20 sm:pt-14 sm:pb-28">
      <Header />
      {proUiEnabled ? <LiveJournal /> : <SampleJournal />}
    </section>
  );
}
