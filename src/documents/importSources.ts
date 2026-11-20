/**
 * Where imported files come from. Everything is turned into `ImportEntry` (relative path + bytes) so
 * the library import is one code path. Originals are only ever read.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ImportEntry } from './docsRepo';

/** From <input type="file" [webkitdirectory]>: uses webkitRelativePath to keep the hierarchy. */
export function entriesFromFileList(files: FileList | File[], opts: { stripRoot?: boolean } = {}): ImportEntry[] {
  return [...files].map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    return { path: opts.stripRoot && parts.length > 1 ? parts.slice(1).join('/') : rel, data: f };
  });
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

async function walk(entry: FsEntry, prefix: string, out: ImportEntry[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ path: `${prefix}${entry.name}`, data: f });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Drag & drop of files and folders (from Files on iPadOS, or a desktop file manager). */
export async function entriesFromDrop(dt: DataTransfer): Promise<ImportEntry[]> {
  const out: ImportEntry[] = [];
  const items = [...dt.items].filter((i) => i.kind === 'file');
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (entry) await walk(entry, '', out);
    else {
      const f = item.getAsFile();
      if (f) out.push({ path: f.name, data: f });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------- native (iPadOS)

interface PRCDFilesPlugin {
  /** Presents UIDocumentPickerViewController (folder mode) and copies the tree into the app's temp dir. */
  pickFolder(): Promise<{ cancelled?: boolean; name: string; files: Array<{ path: string; uri: string; size: number }> }>;
  /** Cleans up the temp copy after the import. */
  cleanup(o: { name: string }): Promise<void>;
}

const Files = registerPlugin<PRCDFilesPlugin>('PRCDFiles');

export const canPickFolderNatively = () => Capacitor.isNativePlatform();

/**
 * iOS WKWebView cannot select a directory from <input>, so the native document picker is used.
 * Each file is then streamed from the temp copy (never loaded all at once).
 */
export async function pickFolderNative(): Promise<{ name: string; entries: ImportEntry[]; cleanup: () => Promise<void> } | null> {
  const res = await Files.pickFolder();
  if (res.cancelled) return null;
  const entries: ImportEntry[] = [];
  for (const f of res.files) {
    const r = await fetch(Capacitor.convertFileSrc(f.uri));
    if (r.ok) entries.push({ path: f.path, data: await r.blob() });
  }
  return { name: res.name, entries, cleanup: () => Files.cleanup({ name: res.name }) };
}
