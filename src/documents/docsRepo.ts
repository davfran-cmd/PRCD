/**
 * Documents and folders. Binary content lives in the FileStore (copied on import, originals are never
 * modified); metadata, hierarchy, favourites, tags, reading positions and bookmarks live in SQLite.
 */
import type { Repo } from '../db/repo';
import { ValidationError } from '../db/repo';
import { insertRow, selectAll, selectOne, updateRow, type RowSpec } from '../db/rows';
import { newId } from '../domain/ids';
import type { DocKind, DocumentRecord, Folder, PdfBookmark, PdfState } from '../domain/types';
import type { FileStore } from '../storage/fileStore';

const DOC: RowSpec = { bool: ['favorite'], json: ['tags'] };

export const MARKDOWN_EXT = ['md', 'markdown', 'mdown'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'];
const MIME: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', mdown: 'text/markdown', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic',
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function kindOf(name: string): DocKind {
  const e = extOf(name);
  if (MARKDOWN_EXT.includes(e)) return 'markdown';
  if (e === 'pdf') return 'pdf';
  if (IMAGE_EXT.includes(e)) return 'image';
  return 'other';
}

export function mimeOf(name: string): string {
  return MIME[extOf(name)] ?? 'application/octet-stream';
}

export function displayName(fileName: string): string {
  const k = kindOf(fileName);
  if (k === 'markdown' || k === 'pdf') return fileName.replace(/\.[^.]+$/, '');
  return fileName;
}

/** Files and folders that are application noise, never user content. */
export function isIgnoredPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX' || seg === 'Thumbs.db' || seg === 'desktop.ini');
}

export interface ImportEntry {
  /** Relative path inside the imported tree, using "/" (e.g. "Fisica 2/Appunti/14 Ampère.md"). */
  path: string;
  data: Blob | Uint8Array;
}

export interface ImportReport {
  added: number;
  folders: number;
  skipped: Array<{ path: string; reason: string }>;
  renamed: Array<{ from: string; to: string }>;
  errors: Array<{ path: string; error: string }>;
  rootFolderId: string | null;
  documentIds: string[];
}

export interface DocQuery {
  folderId?: string | null; // undefined = anywhere; null = root
  courseId?: string | null;
  favorite?: boolean;
  recent?: boolean;
  tag?: string;
  query?: string;
  kind?: DocKind;
}

export class DocsRepo {
  constructor(readonly repo: Repo, readonly files: FileStore) {}

  private get db() {
    return this.repo.db;
  }

  // ------------------------------------------------------------------ folders

  folders(parentId?: string | null): Folder[] {
    if (parentId === undefined) return selectAll<Folder>(this.db, 'SELECT * FROM folders ORDER BY name COLLATE NOCASE');
    return selectAll<Folder>(this.db, `SELECT * FROM folders WHERE ${parentId === null ? 'parent_id IS NULL' : 'parent_id = ?'} ORDER BY name COLLATE NOCASE`, parentId === null ? [] : [parentId]);
  }

  folder(id: string): Folder | undefined {
    return selectOne<Folder>(this.db, 'SELECT * FROM folders WHERE id = ?', [id]);
  }

  folderPath(id: string | null): Folder[] {
    const out: Folder[] = [];
    let cur = id ? this.folder(id) : undefined;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      out.unshift(cur);
      cur = cur.parentId ? this.folder(cur.parentId) : undefined;
    }
    return out;
  }

  private uniqueFolderName(parentId: string | null, name: string, ignoreId?: string): string {
    const siblings = new Set(this.folders(parentId).filter((f) => f.id !== ignoreId).map((f) => f.name.toLowerCase()));
    if (!siblings.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) if (!siblings.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`;
  }

  createFolder(name: string, parentId: string | null, courseId: string | null = null): Folder {
    const n = name.trim().replace(/[/\\]/g, '-');
    if (!n) throw new ValidationError('Dai un nome alla cartella');
    if (parentId && !this.folder(parentId)) throw new ValidationError('Cartella di destinazione non trovata');
    const now = new Date().toISOString();
    const f: Folder = { id: newId(), parentId, name: this.uniqueFolderName(parentId, n), courseId, createdAt: now, updatedAt: now };
    insertRow(this.db, 'folders', f);
    return f;
  }

  /** Find or create a folder path under `parentId` ("a/b/c"). Returns the deepest folder id. */
  ensureFolderPath(segments: string[], parentId: string | null): string | null {
    let cur = parentId;
    for (const seg of segments) {
      const existing = this.folders(cur).find((f) => f.name === seg);
      cur = existing ? existing.id : this.createFolder(seg, cur).id;
    }
    return cur;
  }

  renameFolder(id: string, name: string): void {
    const f = this.folder(id);
    if (!f) throw new ValidationError('Cartella non trovata');
    const n = name.trim().replace(/[/\\]/g, '-');
    if (!n) throw new ValidationError('Dai un nome alla cartella');
    updateRow(this.db, 'folders', 'id', id, { name: this.uniqueFolderName(f.parentId, n, id), updatedAt: new Date().toISOString() });
  }

  moveFolder(id: string, newParentId: string | null): void {
    if (newParentId === id) throw new ValidationError('Una cartella non può stare dentro se stessa');
    if (newParentId && this.folderPath(newParentId).some((f) => f.id === id)) throw new ValidationError('Non puoi spostare una cartella dentro una sua sottocartella');
    const f = this.folder(id);
    if (!f) throw new ValidationError('Cartella non trovata');
    updateRow(this.db, 'folders', 'id', id, { parentId: newParentId, name: this.uniqueFolderName(newParentId, f.name, id), updatedAt: new Date().toISOString() });
  }

  setFolderCourse(id: string, courseId: string | null): void {
    updateRow(this.db, 'folders', 'id', id, { courseId, updatedAt: new Date().toISOString() });
  }

  descendantFolderIds(id: string): string[] {
    const out: string[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.pop() as string;
      out.push(cur);
      for (const c of this.folders(cur)) queue.push(c.id);
    }
    return out;
  }

  /** What deleting a folder would remove, for the confirmation dialog. */
  folderDeletionImpact(id: string): { folders: number; documents: number } {
    const ids = this.descendantFolderIds(id);
    const q = ids.map(() => '?').join(',');
    return { folders: ids.length, documents: Number(this.db.scalar(`SELECT COUNT(*) FROM documents WHERE folder_id IN (${q})`, ids) ?? 0) };
  }

  /** Deletes the folder tree *and the documents inside it* (explicit, confirmed by the caller). */
  async deleteFolder(id: string): Promise<void> {
    const ids = this.descendantFolderIds(id);
    const q = ids.map(() => '?').join(',');
    const keys = this.db.all<{ storage_key: string }>(`SELECT storage_key FROM documents WHERE folder_id IN (${q})`, ids).map((r) => r.storage_key);
    this.db.transaction(() => {
      this.db.run(`DELETE FROM documents WHERE folder_id IN (${q})`, ids);
      this.db.run('DELETE FROM folders WHERE id = ?', [id]); // cascades to subfolders
    });
    for (const k of keys) await this.files.delete(k);
  }

  // ------------------------------------------------------------------ documents

  document(id: string): DocumentRecord | undefined {
    return selectOne<DocumentRecord>(this.db, 'SELECT * FROM documents WHERE id = ?', [id], DOC);
  }

  documents(q: DocQuery = {}): DocumentRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.folderId !== undefined) {
      if (q.folderId === null) where.push('folder_id IS NULL');
      else {
        where.push('folder_id = ?');
        params.push(q.folderId);
      }
    }
    if (q.courseId !== undefined) {
      if (q.courseId === null) where.push('course_id IS NULL');
      else {
        where.push('course_id = ?');
        params.push(q.courseId);
      }
    }
    if (q.favorite) where.push('favorite = 1');
    if (q.recent) where.push('last_opened_at IS NOT NULL');
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    if (q.tag) {
      where.push('tags LIKE ?');
      params.push(`%${JSON.stringify(q.tag).slice(1, -1)}%`);
    }
    if (q.query) {
      where.push('(name LIKE ? ESCAPE \'\\\' OR id IN (SELECT document_id FROM document_text WHERE content LIKE ? ESCAPE \'\\\'))');
      const like = `%${q.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    const order = q.recent ? 'last_opened_at DESC' : 'name COLLATE NOCASE';
    return selectAll<DocumentRecord>(this.db, `SELECT * FROM documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`, params, DOC);
  }

  recentDocuments(n = 8): DocumentRecord[] {
    return this.documents({ recent: true }).slice(0, n);
  }

  /** Full path "Cartella/Sotto/nota.md" of a document inside the library. */
  pathOf(doc: DocumentRecord): string {
    return [...this.folderPath(doc.folderId).map((f) => f.name), doc.fileName].join('/');
  }

  private uniqueFileName(folderId: string | null, fileName: string): string {
    const taken = new Set(this.documents({ folderId }).map((d) => d.fileName.toLowerCase()));
    if (!taken.has(fileName.toLowerCase())) return fileName;
    const dot = fileName.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, ''];
    for (let i = 2; ; i++) if (!taken.has(`${stem} (${i})${ext}`.toLowerCase())) return `${stem} (${i})${ext}`;
  }

  async addDocument(input: { data: Blob | Uint8Array; fileName: string; folderId: string | null; courseId?: string | null; tags?: string[] }): Promise<DocumentRecord> {
    const fileName = this.uniqueFileName(input.folderId, input.fileName.replace(/[/\\]/g, '-'));
    const kind = kindOf(fileName);
    const mime = mimeOf(fileName);
    const blob = input.data instanceof Blob ? input.data : new Blob([input.data as BlobPart], { type: mime });
    const storageKey = `f/${newId()}`;
    await this.files.put(storageKey, blob); // file first: a DB row never points at nothing
    const now = new Date().toISOString();
    const doc: DocumentRecord = {
      id: newId(), folderId: input.folderId, name: displayName(fileName), fileName, kind, mime, size: blob.size, storageKey,
      courseId: input.courseId ?? this.folder(input.folderId ?? '')?.courseId ?? null, favorite: false, tags: input.tags ?? [], pageCount: null, addedAt: now, lastOpenedAt: null, updatedAt: now,
    };
    try {
      this.db.transaction(() => {
        insertRow(this.db, 'documents', doc, DOC);
      });
    } catch (e) {
      await this.files.delete(storageKey);
      throw e;
    }
    if (kind === 'markdown') await this.indexText(doc.id, blob);
    return doc;
  }

  async indexText(docId: string, blob: Blob): Promise<void> {
    const text = (await blob.text()).slice(0, 2_000_000);
    this.db.run('INSERT INTO document_text(document_id, content) VALUES(?, ?) ON CONFLICT(document_id) DO UPDATE SET content = excluded.content', [docId, text]);
  }

  async getBlob(id: string): Promise<Blob> {
    const d = this.document(id);
    if (!d) throw new ValidationError('Documento non trovato');
    const b = await this.files.get(d.storageKey);
    if (!b) throw new ValidationError(`Il file «${d.fileName}» non si trova più nella memoria locale.`);
    return d.mime ? new Blob([b], { type: d.mime }) : b;
  }

  async getText(id: string): Promise<string> {
    return (await this.getBlob(id)).text();
  }

  rename(id: string, name: string): void {
    const d = this.document(id);
    if (!d) throw new ValidationError('Documento non trovato');
    const n = name.trim().replace(/[/\\]/g, '-');
    if (!n) throw new ValidationError('Il nome non può essere vuoto');
    // Keep the extension so the kind never changes by accident.
    const ext = d.kind === 'markdown' || d.kind === 'pdf' ? `.${extOf(d.fileName)}` : '';
    const fileName = this.uniqueFileName(d.folderId, n.toLowerCase().endsWith(ext.toLowerCase()) && ext ? n : `${n}${ext}`);
    updateRow(this.db, 'documents', 'id', id, { name: displayName(fileName), fileName, updatedAt: new Date().toISOString() }, DOC);
  }

  move(id: string, folderId: string | null): void {
    const d = this.document(id);
    if (!d) throw new ValidationError('Documento non trovato');
    if (folderId && !this.folder(folderId)) throw new ValidationError('Cartella di destinazione non trovata');
    updateRow(this.db, 'documents', 'id', id, { folderId, fileName: this.uniqueFileName(folderId, d.fileName), updatedAt: new Date().toISOString() }, DOC);
  }

  setCourse(id: string, courseId: string | null): void {
    updateRow(this.db, 'documents', 'id', id, { courseId, updatedAt: new Date().toISOString() }, DOC);
  }

  setFavorite(id: string, favorite: boolean): void {
    updateRow(this.db, 'documents', 'id', id, { favorite }, DOC);
  }

  setTags(id: string, tags: string[]): void {
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    updateRow(this.db, 'documents', 'id', id, { tags: clean, updatedAt: new Date().toISOString() }, DOC);
  }

  setPageCount(id: string, pages: number): void {
    updateRow(this.db, 'documents', 'id', id, { pageCount: pages }, DOC);
  }

  markOpened(id: string): void {
    updateRow(this.db, 'documents', 'id', id, { lastOpenedAt: new Date().toISOString() }, DOC);
  }

  /** Permanently removes the document and its stored copy (callers confirm first). */
  async delete(id: string): Promise<void> {
    const d = this.document(id);
    if (!d) return;
    this.db.run('DELETE FROM documents WHERE id = ?', [id]);
    await this.files.delete(d.storageKey);
  }

  allTags(): string[] {
    const set = new Set<string>();
    for (const r of this.db.all<{ tags: string }>("SELECT tags FROM documents WHERE tags <> '[]'")) {
      try {
        (JSON.parse(r.tags) as string[]).forEach((t) => set.add(t));
      } catch {
        /* ignore */
      }
    }
    return [...set].sort();
  }

  // ------------------------------------------------------------------ import

  /**
   * Import a tree of files, preserving the folder hierarchy. Originals are never touched (we only copy
   * bytes). Name collisions never overwrite: the newcomer gets " (2)". Hidden/system files are skipped.
   */
  async importTree(entries: ImportEntry[], opts: { parentFolderId: string | null; rootName?: string | null; courseId?: string | null; onProgress?: (done: number, total: number) => void } = { parentFolderId: null }): Promise<ImportReport> {
    const report: ImportReport = { added: 0, folders: 0, skipped: [], renamed: [], errors: [], rootFolderId: null, documentIds: [] };
    const before = this.folders().length;
    const usable = entries.filter((e) => {
      if (isIgnoredPath(e.path)) {
        report.skipped.push({ path: e.path, reason: 'file di sistema o nascosto' });
        return false;
      }
      if (kindOf(e.path) === 'other') {
        report.skipped.push({ path: e.path, reason: 'tipo di file non supportato' });
        return false;
      }
      return true;
    });
    let rootId = opts.parentFolderId;
    if (opts.rootName) {
      rootId = this.createFolder(opts.rootName, opts.parentFolderId, opts.courseId ?? null).id;
      report.rootFolderId = rootId;
    }
    let done = 0;
    for (const e of usable) {
      const segs = e.path.split('/').filter(Boolean);
      const fileName = segs.pop() as string;
      try {
        const folderId = this.ensureFolderPath(segs, rootId);
        const doc = await this.addDocument({ data: e.data, fileName, folderId, courseId: opts.courseId ?? null });
        if (doc.fileName !== fileName) report.renamed.push({ from: e.path, to: doc.fileName });
        report.added += 1;
        report.documentIds.push(doc.id);
      } catch (err) {
        report.errors.push({ path: e.path, error: err instanceof Error ? err.message : String(err) });
      }
      opts.onProgress?.(++done, usable.length);
    }
    report.folders = this.folders().length - before - (opts.rootName ? 1 : 0);
    if (opts.rootName) report.folders += 1;
    return report;
  }

  // ------------------------------------------------------------------ path index (for links and images)

  /** lower-cased library path → document id, for resolving relative paths and wiki-links. */
  pathIndex(): Array<{ path: string; doc: DocumentRecord }> {
    const folders = new Map(this.folders().map((f) => [f.id, f]));
    const pathOfFolder = (id: string | null): string[] => {
      const segs: string[] = [];
      let cur = id ? folders.get(id) : undefined;
      const guard = new Set<string>();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        segs.unshift(cur.name);
        cur = cur.parentId ? folders.get(cur.parentId) : undefined;
      }
      return segs;
    };
    return this.documents().map((doc) => ({ path: [...pathOfFolder(doc.folderId), doc.fileName].join('/'), doc }));
  }

  // ------------------------------------------------------------------ PDF state & bookmarks

  pdfState(documentId: string): PdfState | undefined {
    return selectOne<PdfState>(this.db, 'SELECT * FROM pdf_state WHERE document_id = ?', [documentId]);
  }

  savePdfState(documentId: string, lastPage: number, zoom: number): void {
    if (!this.document(documentId)) return;
    this.db.run(
      `INSERT INTO pdf_state(document_id, last_page, zoom, updated_at) VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET last_page = excluded.last_page, zoom = excluded.zoom, updated_at = excluded.updated_at`,
      [documentId, Math.max(1, Math.floor(lastPage)), zoom, new Date().toISOString()],
    );
  }

  bookmarks(documentId: string): PdfBookmark[] {
    return selectAll<PdfBookmark>(this.db, 'SELECT * FROM pdf_bookmarks WHERE document_id = ? ORDER BY page, created_at', [documentId]);
  }

  addBookmark(documentId: string, page: number, label = ''): PdfBookmark {
    const existing = this.bookmarks(documentId).find((b) => b.page === page);
    if (existing) return existing;
    const b: PdfBookmark = { id: newId(), documentId, page, label: label.trim() || `Pagina ${page}`, createdAt: new Date().toISOString() };
    insertRow(this.db, 'pdf_bookmarks', b);
    return b;
  }

  removeBookmark(id: string): void {
    this.db.run('DELETE FROM pdf_bookmarks WHERE id = ?', [id]);
  }

  // ------------------------------------------------------------------ search

  /** Name and (for notes) full-text search with a short snippet. */
  search(query: string, limit = 30): Array<{ doc: DocumentRecord; snippet: string }> {
    const q = query.trim();
    if (!q) return [];
    const docs = this.documents({ query: q }).slice(0, limit);
    const lower = q.toLowerCase();
    return docs.map((doc) => {
      let snippet = '';
      if (doc.kind === 'markdown') {
        const row = this.db.get<{ content: string }>('SELECT content FROM document_text WHERE document_id = ?', [doc.id]);
        const i = row ? row.content.toLowerCase().indexOf(lower) : -1;
        if (row && i >= 0) snippet = row.content.slice(Math.max(0, i - 40), i + q.length + 60).replace(/\s+/g, ' ').trim();
      }
      return { doc, snippet };
    });
  }
}
