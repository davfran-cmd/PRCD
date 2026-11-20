import type { SqlValue } from 'sql.js';
import type { Database } from './database';

/** `start`/`end` are SQL keywords, so their columns are called `starts_at`/`ends_at`. */
const FIELD_TO_COLUMN: Record<string, string> = { start: 'starts_at', end: 'ends_at' };
const COLUMN_TO_FIELD: Record<string, string> = { starts_at: 'start', ends_at: 'end' };

export const snake = (s: string): string => FIELD_TO_COLUMN[s] ?? s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const camel = (s: string): string => COLUMN_TO_FIELD[s] ?? s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export interface RowSpec {
  bool?: readonly string[]; // camelCase field names stored as 0/1
  json?: readonly string[]; // camelCase field names stored as JSON text
}

export function fromRow<T>(row: Record<string, SqlValue>, spec: RowSpec = {}): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = camel(k);
    if (spec.bool?.includes(key)) out[key] = Boolean(v);
    else if (spec.json?.includes(key)) {
      try {
        out[key] = v === null || v === undefined ? null : JSON.parse(String(v));
      } catch {
        out[key] = null;
      }
    } else out[key] = v;
  }
  return out as T;
}

function encode(v: unknown, key: string, spec: RowSpec): SqlValue {
  if (v === undefined || v === null) return null;
  if (spec.json?.includes(key)) return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as SqlValue;
}

export function insertRow(db: Database, table: string, obj: object, spec: RowSpec = {}, orReplace = false): void {
  const keys = Object.keys(obj);
  const cols = keys.map(snake);
  const vals = keys.map((k) => encode((obj as Record<string, unknown>)[k], k, spec));
  db.run(`INSERT ${orReplace ? 'OR REPLACE ' : ''}INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, vals);
}

export function updateRow(db: Database, table: string, idCol: string, id: string, patch: object, spec: RowSpec = {}): void {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const sets = keys.map((k) => `${snake(k)} = ?`).join(', ');
  const vals = keys.map((k) => encode((patch as Record<string, unknown>)[k], k, spec));
  db.run(`UPDATE ${table} SET ${sets} WHERE ${idCol} = ?`, [...vals, id]);
}

export function selectAll<T>(db: Database, sql: string, params: SqlValue[] = [], spec: RowSpec = {}): T[] {
  return db.all(sql, params).map((r) => fromRow<T>(r, spec));
}

export function selectOne<T>(db: Database, sql: string, params: SqlValue[] = [], spec: RowSpec = {}): T | undefined {
  const r = db.get(sql, params);
  return r ? fromRow<T>(r, spec) : undefined;
}
