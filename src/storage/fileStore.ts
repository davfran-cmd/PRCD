/**
 * Binary file storage (PDFs, images, notes). Large binaries never go in SQLite: documents.storage_key
 * points here. Implementations: IndexedDB (web / fallback), Capacitor Filesystem (iPad, private app
 * storage), memory (tests).
 */
export interface FileStore {
  put(key: string, data: Blob | Uint8Array): Promise<void>;
  get(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /** Total size in bytes (best effort). */
  usage(): Promise<number>;
}

export function toBlob(data: Blob | Uint8Array, type = 'application/octet-stream'): Blob {
  return data instanceof Blob ? data : new Blob([data as BlobPart], { type });
}

export class MemoryFileStore implements FileStore {
  readonly map = new Map<string, Uint8Array>();
  async put(key: string, data: Blob | Uint8Array) {
    this.map.set(key, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data));
  }
  async get(key: string) {
    const b = this.map.get(key);
    return b ? new Blob([b as BlobPart]) : null;
  }
  async has(key: string) {
    return this.map.has(key);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()];
  }
  async usage() {
    let n = 0;
    for (const v of this.map.values()) n += v.length;
    return n;
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Opens (creating if needed) an IndexedDB database with the given object stores. */
export function openIdb(name: string, stores: string[], version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, version);
    open.onupgradeneeded = () => {
      for (const s of stores) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

export class IndexedDbFileStore implements FileStore {
  private dbp: Promise<IDBDatabase>;
  constructor(name = 'prcd-files') {
    this.dbp = openIdb(name, ['files']);
  }
  async put(key: string, data: Blob | Uint8Array) {
    const db = await this.dbp;
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(toBlob(data), key);
    await txDone(tx);
  }
  async get(key: string) {
    const db = await this.dbp;
    const v = await req(db.transaction('files').objectStore('files').get(key));
    return (v as Blob | undefined) ?? null;
  }
  async has(key: string) {
    const db = await this.dbp;
    return (await req(db.transaction('files').objectStore('files').count(key))) > 0;
  }
  async delete(key: string) {
    const db = await this.dbp;
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(key);
    await txDone(tx);
  }
  async keys() {
    const db = await this.dbp;
    return (await req(db.transaction('files').objectStore('files').getAllKeys())).map(String);
  }
  async usage() {
    const db = await this.dbp;
    const all = (await req(db.transaction('files').objectStore('files').getAll())) as Blob[];
    return all.reduce((n, b) => n + b.size, 0);
  }
}

/** Database persistence on IndexedDB (web). The previous version is kept as `db_prev` on every write. */
import type { DbPersistence } from '../db/database';

export class IndexedDbPersistence implements DbPersistence {
  private dbp: Promise<IDBDatabase>;
  constructor(name = 'prcd-db') {
    this.dbp = openIdb(name, ['main', 'snapshots']);
  }
  async load() {
    const db = await this.dbp;
    const v = await req(db.transaction('main').objectStore('main').get('db'));
    return v ? new Uint8Array(v as ArrayBuffer) : null;
  }
  async save(bytes: Uint8Array) {
    const db = await this.dbp;
    const tx = db.transaction('main', 'readwrite');
    const store = tx.objectStore('main');
    // Single atomic transaction: the single `put` replaces the whole image or fails entirely.
    store.put(bytes.slice().buffer, 'db');
    await txDone(tx);
  }
  async snapshot(name: string, bytes: Uint8Array) {
    const db = await this.dbp;
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put(bytes.slice().buffer, name);
    await txDone(tx);
  }
  async listSnapshots() {
    const db = await this.dbp;
    const store = db.transaction('snapshots').objectStore('snapshots');
    const keys = (await req(store.getAllKeys())).map(String);
    const out: Array<{ name: string; size: number }> = [];
    for (const k of keys) out.push({ name: k, size: ((await req(db.transaction('snapshots').objectStore('snapshots').get(k))) as ArrayBuffer).byteLength });
    return out;
  }
  async loadSnapshot(name: string) {
    const db = await this.dbp;
    const v = await req(db.transaction('snapshots').objectStore('snapshots').get(name));
    return v ? new Uint8Array(v as ArrayBuffer) : null;
  }
  async deleteSnapshot(name: string) {
    const db = await this.dbp;
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').delete(name);
    await txDone(tx);
  }
}
