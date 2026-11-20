/**
 * Thin, typed wrapper around sql.js (SQLite compiled to WebAssembly).
 *
 * The database lives in memory and is persisted as a whole file after every committed
 * transaction through a `DbPersistence` adapter (IndexedDB on the web, the app's private
 * filesystem on iPadOS). Writes are coalesced and serialized; `flush()` waits for the last one.
 * The same code and the same migrations run in the browser, in the Capacitor WebView and in Node
 * (tests), so schema behaviour is verified once.
 */
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic, type SqlValue } from 'sql.js';
import { LATEST_VERSION, MIGRATIONS } from './migrations';

export type Params = SqlValue[] | Record<string, SqlValue>;

export interface DbPersistence {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  /** Keep a named copy of the database (e.g. before a migration or a restore). */
  snapshot(name: string, bytes: Uint8Array): Promise<void>;
  listSnapshots(): Promise<Array<{ name: string; size: number }>>;
  loadSnapshot(name: string): Promise<Uint8Array | null>;
  deleteSnapshot(name: string): Promise<void>;
}

export class MemoryPersistence implements DbPersistence {
  bytes: Uint8Array | null = null;
  snaps = new Map<string, Uint8Array>();
  saves = 0;
  async load() {
    return this.bytes ? new Uint8Array(this.bytes) : null;
  }
  async save(bytes: Uint8Array) {
    this.bytes = new Uint8Array(bytes);
    this.saves += 1;
  }
  async snapshot(name: string, bytes: Uint8Array) {
    this.snaps.set(name, new Uint8Array(bytes));
  }
  async listSnapshots() {
    return [...this.snaps].map(([name, b]) => ({ name, size: b.length }));
  }
  async loadSnapshot(name: string) {
    const b = this.snaps.get(name);
    return b ? new Uint8Array(b) : null;
  }
  async deleteSnapshot(name: string) {
    this.snaps.delete(name);
  }
}

export class MigrationError extends Error {
  constructor(message: string, readonly version: number, readonly cause?: unknown) {
    super(message);
  }
}

let sqlPromise: Promise<SqlJsStatic> | null = null;
export function loadSqlJs(locateFile?: (file: string) => string): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs((locateFile ? { locateFile } : undefined) as Parameters<typeof initSqlJs>[0]);
  return sqlPromise;
}

export type ChangeListener = (tables: ReadonlySet<string>) => void;

export class Database {
  private listeners = new Set<ChangeListener>();
  private txDepth = 0;
  private dirtyTables = new Set<string>();
  private saveInFlight: Promise<void> | null = null;
  private saveQueued = false;
  private lastSaveError: unknown = null;

  private constructor(
    readonly sql: SqlJsStatic,
    private db: SqlJsDatabase,
    readonly persistence: DbPersistence,
  ) {}

  /** Opens (or creates) the database, runs pending migrations, and enables foreign keys. */
  static async open(persistence: DbPersistence, locateFile?: (file: string) => string): Promise<Database> {
    const SQL = await loadSqlJs(locateFile);
    const bytes = await persistence.load();
    const raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
    const wrapper = new Database(SQL, raw, persistence);
    try {
      await wrapper.migrate(Boolean(bytes));
    } catch (e) {
      raw.close();
      throw e;
    }
    return wrapper;
  }

  /** Create from raw bytes without touching persistence (used to inspect archives). */
  static async fromBytes(bytes: Uint8Array | null, persistence: DbPersistence = new MemoryPersistence(), locateFile?: (f: string) => string): Promise<Database> {
    const SQL = await loadSqlJs(locateFile);
    const raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
    const wrapper = new Database(SQL, raw, persistence);
    await wrapper.migrate(Boolean(bytes));
    return wrapper;
  }

  get version(): number {
    return Number(this.db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
  }

  private async migrate(hadData: boolean): Promise<void> {
    this.db.run('PRAGMA foreign_keys = ON');
    const current = this.version;
    if (current > LATEST_VERSION) {
      throw new MigrationError(`Il database è stato creato da una versione più recente dell'app (schema ${current}, supportato ${LATEST_VERSION}).`, current);
    }
    const pending = MIGRATIONS.filter((m) => m.version > current);
    if (!pending.length) return;
    // Safety net: keep the pre-migration database before changing an existing one.
    if (hadData && current > 0) {
      await this.persistence.snapshot(`pre-migration-v${current}`, this.db.export());
    }
    for (const m of pending) {
      try {
        this.db.run('BEGIN');
        for (const stmt of m.up) this.db.run(stmt);
        this.db.run(`PRAGMA user_version = ${m.version}`);
        this.db.run('COMMIT');
      } catch (e) {
        try {
          this.db.run('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw new MigrationError(`Migrazione ${m.version} (${m.name}) non riuscita: ${(e as Error).message}`, m.version, e);
      }
      // PRAGMA foreign_keys is reset by some statements; re-assert it.
      this.db.run('PRAGMA foreign_keys = ON');
    }
    await this.persistNow();
  }

  // ------------------------------------------------------------------ queries

  all<T = Record<string, SqlValue>>(sql: string, params: Params = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T = Record<string, SqlValue>>(sql: string, params: Params = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  scalar<T extends SqlValue = SqlValue>(sql: string, params: Params = []): T | undefined {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as never);
      return stmt.step() ? (stmt.get()[0] as T) : undefined;
    } finally {
      stmt.free();
    }
  }

  run(sql: string, params: Params = []): void {
    this.db.run(sql, params as never);
    this.markDirty(sql);
    if (this.txDepth === 0) this.afterCommit();
  }

  /** Runs `fn` atomically. Nested calls become savepoints. Throwing rolls everything back. */
  transaction<T>(fn: () => T): T {
    const outer = this.txDepth === 0;
    const sp = `sp_${this.txDepth}`;
    this.db.run(outer ? 'BEGIN' : `SAVEPOINT ${sp}`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      this.db.run(outer ? 'COMMIT' : `RELEASE ${sp}`);
      if (outer) this.afterCommit();
      return result;
    } catch (e) {
      this.txDepth -= 1;
      try {
        this.db.run(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
        if (!outer) this.db.run(`RELEASE ${sp}`);
      } catch {
        /* nothing to roll back */
      }
      if (outer) this.dirtyTables.clear();
      throw e;
    }
  }

  private markDirty(sql: string) {
    const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+"?(\w+)"?/i.exec(sql);
    if (m) this.dirtyTables.add(m[1].toLowerCase());
    else if (!/^\s*(SELECT|PRAGMA)/i.test(sql)) this.dirtyTables.add('*');
  }

  private afterCommit() {
    if (!this.dirtyTables.size) return;
    const tables = new Set(this.dirtyTables);
    this.dirtyTables.clear();
    this.schedulePersist();
    for (const l of this.listeners) l(tables);
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify subscribers without writing (after an external replace). */
  notifyAll() {
    for (const l of this.listeners) l(new Set(['*']));
  }

  // ------------------------------------------------------------------ persistence

  private schedulePersist() {
    if (this.saveInFlight) {
      this.saveQueued = true;
      return;
    }
    this.saveInFlight = this.persistLoop();
  }

  private async persistLoop(): Promise<void> {
    do {
      this.saveQueued = false;
      try {
        await this.persistence.save(this.db.export());
        this.lastSaveError = null;
      } catch (e) {
        this.lastSaveError = e;
      }
    } while (this.saveQueued);
    this.saveInFlight = null;
  }

  private async persistNow(): Promise<void> {
    this.schedulePersist();
    await this.flush();
  }

  /** Resolves once everything committed so far is durably stored. Throws if the last write failed. */
  async flush(): Promise<void> {
    while (this.saveInFlight) await this.saveInFlight;
    if (this.lastSaveError) throw this.lastSaveError;
  }

  get persistenceError(): unknown {
    return this.lastSaveError;
  }

  exportBytes(): Uint8Array {
    return this.db.export();
  }

  /** Make a named snapshot of the current database. */
  async snapshot(name: string): Promise<void> {
    await this.persistence.snapshot(name, this.db.export());
  }

  integrityCheck(): string {
    return String(this.db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0] ?? 'unknown');
  }

  foreignKeyViolations(): number {
    return this.db.exec('PRAGMA foreign_key_check')[0]?.values.length ?? 0;
  }

  /**
   * Replace the whole content with a (migrated) database image — used by restore.
   * The caller must have verified `bytes` first (see backup.ts) and taken a snapshot.
   */
  async replaceWith(bytes: Uint8Array): Promise<void> {
    const next = new this.sql.Database(bytes);
    const old = this.db;
    this.db = next;
    try {
      await this.migrate(true);
    } catch (e) {
      this.db = old;
      next.close();
      throw e;
    }
    old.close();
    await this.persistNow();
    this.notifyAll();
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------------ settings key/value helpers

  getJson<T>(table: 'settings' | 'meta', key: string): T | undefined {
    const row = this.get<{ value: string }>(`SELECT value FROM ${table} WHERE key = ?`, [key]);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  setJson(table: 'settings' | 'meta', key: string, value: unknown): void {
    this.run(`INSERT INTO ${table}(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(value)]);
  }
}
