/**
 * Full-archive backup and restore.
 *
 * Archive = ZIP (`.prcd`) containing
 *   manifest.json   format, versions, counts, sha256 of every file
 *   database.sqlite the whole SQLite image
 *   data.json       human-readable dump of every table (for inspection / future structured import)
 *   files/<key>     every imported document, byte for byte
 *
 * Restore is all-or-nothing: the archive is fully verified (hashes, integrity_check, foreign keys,
 * schema version) *before* anything is touched; the current database is snapshotted first; files are
 * written before the database image is swapped in, so a failure leaves the previous data in place.
 */
import { Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8, unzipSync } from 'fflate';
import { Database, MemoryPersistence } from './database';
import { LATEST_VERSION } from './migrations';
import type { FileStore } from '../storage/fileStore';

export const ARCHIVE_FORMAT = 'prcd-archive';
export const ARCHIVE_VERSION = 1;

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  files: Array<{ key: string; size: number; sha256: string | null }>;
  counts: Record<string, number>;
}

export class ArchiveError extends Error {}

export async function sha256Hex(data: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', data.slice().buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function tableNames(db: Database): string[] {
  return db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}

export function dumpJson(db: Database): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of tableNames(db)) out[t] = db.all(`SELECT * FROM "${t}"`);
  return out;
}

export async function createArchive(db: Database, files: FileStore, opts: { appVersion?: string; now?: Date } = {}): Promise<Blob> {
  await db.flush();
  const docs = db.all<{ storage_key: string }>('SELECT storage_key FROM documents').map((d) => d.storage_key);
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else chunks.push(chunk);
  });
  const manifestFiles: ArchiveManifest['files'] = [];

  const addDeflated = (name: string, data: Uint8Array) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(data, true);
  };

  const sqlite = db.exportBytes();
  const json = dump(db);
  addDeflated('database.sqlite', sqlite);
  addDeflated('data.json', strToU8(JSON.stringify(json)));

  for (const key of docs) {
    const blob = await files.get(key);
    if (!blob) throw new ArchiveError(`File mancante nell'archivio locale: ${key}. Il backup non è stato creato.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    manifestFiles.push({ key, size: bytes.length, sha256: await sha256Hex(bytes) });
    const f = new ZipPassThrough(`files/${key}`); // PDFs/images are already compressed
    zip.add(f);
    f.push(bytes, true);
  }

  const counts: Record<string, number> = {};
  for (const [t, rows] of Object.entries(json)) counts[t] = rows.length;
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt: (opts.now ?? new Date()).toISOString(),
    appVersion: opts.appVersion ?? '0.1.0',
    schemaVersion: db.version,
    files: manifestFiles,
    counts,
  };
  addDeflated('manifest.json', strToU8(JSON.stringify(manifest, null, 2)));
  zip.end();
  if (failure) throw failure;
  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}

function dump(db: Database) {
  return dumpJson(db);
}

export interface ArchiveInspection {
  manifest: ArchiveManifest;
  database: Uint8Array;
  entries: Record<string, Uint8Array>;
}

/** Parses and fully verifies an archive without touching any live data. */
export async function inspectArchive(bytes: Uint8Array): Promise<ArchiveInspection> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ArchiveError('Il file non è un archivio PRCD valido (ZIP illeggibile).');
  }
  const mf = entries['manifest.json'];
  if (!mf) throw new ArchiveError('Archivio non valido: manifest.json mancante.');
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(strFromU8(mf)) as ArchiveManifest;
  } catch {
    throw new ArchiveError('Archivio non valido: manifest illeggibile.');
  }
  if (manifest.format !== ARCHIVE_FORMAT) throw new ArchiveError('Questo file non è un archivio PRCD.');
  if (manifest.version > ARCHIVE_VERSION) throw new ArchiveError('Archivio creato da una versione più recente di PRCD: aggiorna l’app prima di ripristinarlo.');
  if (manifest.schemaVersion > LATEST_VERSION) throw new ArchiveError('I dati dell’archivio sono più recenti di questa versione dell’app.');
  const database = entries['database.sqlite'];
  if (!database) throw new ArchiveError('Archivio non valido: database mancante.');
  for (const f of manifest.files) {
    const data = entries[`files/${f.key}`];
    if (!data) throw new ArchiveError(`Archivio incompleto: manca il file ${f.key}.`);
    if (data.length !== f.size) throw new ArchiveError(`Archivio danneggiato: dimensione errata per ${f.key}.`);
    if (f.sha256) {
      const h = await sha256Hex(data);
      if (h && h !== f.sha256) throw new ArchiveError(`Archivio danneggiato: il file ${f.key} non corrisponde al checksum.`);
    }
  }
  // Open the image in memory (this also migrates it forward) and verify it.
  let candidate: Database;
  try {
    candidate = await Database.fromBytes(database, new MemoryPersistence());
  } catch (e) {
    throw new ArchiveError(`Database dell'archivio non utilizzabile: ${(e as Error).message}`);
  }
  try {
    if (candidate.integrityCheck() !== 'ok') throw new ArchiveError('Il database dell’archivio è danneggiato (integrity_check).');
    if (candidate.foreignKeyViolations() > 0) throw new ArchiveError('Il database dell’archivio ha riferimenti incoerenti.');
    const keys = new Set(manifest.files.map((f) => f.key));
    const missing = candidate.all<{ storage_key: string }>('SELECT storage_key FROM documents').find((d) => !keys.has(d.storage_key));
    if (missing) throw new ArchiveError(`Il database fa riferimento a un file non incluso: ${missing.storage_key}.`);
    return { manifest, database: candidate.exportBytes(), entries };
  } finally {
    candidate.close();
  }
}

export interface RestoreReport {
  files: number;
  documents: number;
  courses: number;
  snapshotName: string;
}

export async function restoreArchive(db: Database, files: FileStore, archive: Uint8Array, opts: { now?: Date } = {}): Promise<RestoreReport> {
  const verified = await inspectArchive(archive); // throws before anything changes
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const snapshotName = `pre-restore-${stamp}`;
  await db.flush();
  await db.snapshot(snapshotName); // the user's current data is kept, never silently lost
  // Files first (additive: keys are unique ids), then swap the database in.
  for (const f of verified.manifest.files) await files.put(f.key, verified.entries[`files/${f.key}`]);
  await db.replaceWith(verified.database);
  return {
    files: verified.manifest.files.length,
    documents: verified.manifest.counts.documents ?? 0,
    courses: verified.manifest.counts.courses ?? 0,
    snapshotName,
  };
}

/** Delete everything (explicit user action). A snapshot is kept so it can still be recovered. */
export async function eraseAllData(db: Database, files: FileStore, opts: { now?: Date } = {}): Promise<string> {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const name = `pre-erase-${stamp}`;
  await db.flush();
  await db.snapshot(name);
  const fresh = await Database.fromBytes(null, new MemoryPersistence());
  const bytes = fresh.exportBytes();
  fresh.close();
  for (const k of await files.keys()) await files.delete(k);
  await db.replaceWith(bytes);
  return name;
}
