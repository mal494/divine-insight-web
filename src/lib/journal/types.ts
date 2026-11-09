export type JournalEntry = {
  id: string;
  title: string;
  spread: string | null;
  note: string;
  reading: unknown;
  createdAt: string;
  updatedAt: string;
};

export type JournalInput = {
  title: string;
  spread: string | null;
  note: string;
  reading: unknown;
};

export type JournalPatch = Partial<JournalInput>;

/** All methods are scoped to `userId`; implementations must never touch other users' rows. */
export interface JournalStore {
  list(userId: string): Promise<JournalEntry[]>;
  create(userId: string, input: JournalInput): Promise<JournalEntry>;
  update(userId: string, id: string, patch: JournalPatch): Promise<JournalEntry | null>;
  remove(userId: string, id: string): Promise<boolean>;
}

export const LIMITS = {
  title: 120,
  spread: 40,
  note: 4000,
  readingBytes: 16 * 1024,
  bodyBytes: 32 * 1024,
  listMax: 200,
} as const;
