/**
 * Postgres JournalStore (journal_entries, migrations/0003_journal_entries.sql).
 * Every statement binds user_id and filters on it, so a caller can only read
 * or change its own rows: an id that belongs to someone else looks missing.
 */
import type { JournalEntry, JournalInput, JournalPatch, JournalStore } from "./types";
import { LIMITS } from "./types";

type Queryable = { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> };

const COLUMNS = `id, title, spread, note, reading, created_at, updated_at`;

function toEntry(r: any): JournalEntry {
  const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));
  return {
    id: String(r.id),
    title: r.title,
    spread: r.spread ?? null,
    note: r.note ?? "",
    reading: r.reading ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function sqlJournalStore(db: () => Queryable): JournalStore {
  return {
    async list(userId) {
      const { rows } = await db().query(
        `select ${COLUMNS} from journal_entries where user_id = $1 order by created_at desc limit ${LIMITS.listMax}`,
        [userId],
      );
      return rows.map(toEntry);
    },
    async create(userId, input: JournalInput) {
      const { rows } = await db().query(
        `insert into journal_entries (user_id, title, spread, note, reading)
         values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
        [userId, input.title, input.spread, input.note, input.reading == null ? null : JSON.stringify(input.reading)],
      );
      return toEntry(rows[0]);
    },
    async update(userId, id, patch: JournalPatch) {
      const sets: string[] = [];
      const values: unknown[] = [id, userId];
      const add = (col: string, v: unknown) => {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      };
      if (patch.title !== undefined) add("title", patch.title);
      if (patch.spread !== undefined) add("spread", patch.spread);
      if (patch.note !== undefined) add("note", patch.note);
      if (patch.reading !== undefined) add("reading", patch.reading == null ? null : JSON.stringify(patch.reading));
      sets.push("updated_at = now()");
      const { rows } = await db().query(
        `update journal_entries set ${sets.join(", ")} where id = $1 and user_id = $2 returning ${COLUMNS}`,
        values,
      );
      return rows[0] ? toEntry(rows[0]) : null;
    },
    async remove(userId, id) {
      const { rows } = await db().query(
        `delete from journal_entries where id = $1 and user_id = $2 returning id`,
        [id, userId],
      );
      return rows.length > 0;
    },
  };
}
