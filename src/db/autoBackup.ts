import type { Database } from './database';

const PREFIX = 'auto-';
const KEEP = 7;

/**
 * Keeps a rolling set of local safety copies of the database: at most one per day, the last 7 days.
 * (Documents are not duplicated here; use the archive export for a complete backup.)
 */
export async function maybeAutoSnapshot(db: Database, now: Date = new Date()): Promise<string | null> {
  const day = now.toISOString().slice(0, 10);
  const name = `${PREFIX}${day}`;
  const existing = await db.persistence.listSnapshots();
  let created: string | null = null;
  if (!existing.some((s) => s.name === name) && Number(db.scalar('SELECT COUNT(*) FROM courses') ?? 0) + Number(db.scalar('SELECT COUNT(*) FROM semesters') ?? 0) > 0) {
    await db.snapshot(name);
    created = name;
  }
  const autos = (await db.persistence.listSnapshots()).filter((s) => s.name.startsWith(PREFIX)).map((s) => s.name).sort();
  for (const old of autos.slice(0, Math.max(0, autos.length - KEEP))) await db.persistence.deleteSnapshot(old);
  return created;
}
