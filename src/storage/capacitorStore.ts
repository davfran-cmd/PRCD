/**
 * iPadOS storage on top of @capacitor/filesystem: the database image and the imported files live in the
 * app's private Data directory (not visible in Files, included in iCloud/iTunes device backups).
 *
 * NOTE: written against the Capacitor API but NOT yet exercised on a simulator or a device
 * (this repository was developed on Windows). See docs/IOS_BUILD.md for the verification checklist.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { DbPersistence } from '../db/database';
import type { FileStore } from './fileStore';

const ROOT = 'prcd';
const CHUNK = 3 * 1024 * 1024; // multiple of 3 so base64 chunks concatenate cleanly

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function writeBytes(path: string, data: Blob | Uint8Array): Promise<void> {
  // Write to a temp file then rename: a crash never leaves a half-written file under the real name.
  const tmp = `${path}.tmp`;
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  await Filesystem.writeFile({ path: tmp, directory: Directory.Data, data: '', recursive: true });
  for (let off = 0; off < blob.size; off += CHUNK) {
    const chunk = new Uint8Array(await blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer());
    await Filesystem.appendFile({ path: tmp, directory: Directory.Data, data: toBase64(chunk) });
  }
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  } catch {
    /* did not exist */
  }
  await Filesystem.rename({ from: tmp, to: path, directory: Directory.Data, toDirectory: Directory.Data });
}

export class CapacitorFileStore implements FileStore {
  private path = (key: string) => `${ROOT}/files/${key}`;

  async put(key: string, data: Blob | Uint8Array) {
    await writeBytes(this.path(key), data);
  }
  async get(key: string): Promise<Blob | null> {
    try {
      const { uri } = await Filesystem.getUri({ path: this.path(key), directory: Directory.Data });
      const res = await fetch(Capacitor.convertFileSrc(uri)); // streams from disk, no base64 round trip
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }
  async has(key: string) {
    try {
      await Filesystem.stat({ path: this.path(key), directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    try {
      await Filesystem.deleteFile({ path: this.path(key), directory: Directory.Data });
    } catch {
      /* already gone */
    }
  }
  async keys() {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      let res;
      try {
        res = await Filesystem.readdir({ path: dir, directory: Directory.Data });
      } catch {
        return;
      }
      for (const f of res.files) {
        if (f.type === 'directory') await walk(`${dir}/${f.name}`, `${prefix}${f.name}/`);
        else if (!f.name.endsWith('.tmp')) out.push(`${prefix}${f.name}`);
      }
    };
    await walk(`${ROOT}/files`, '');
    return out;
  }
  async usage() {
    let n = 0;
    for (const k of await this.keys()) {
      try {
        n += (await Filesystem.stat({ path: this.path(k), directory: Directory.Data })).size;
      } catch {
        /* ignore */
      }
    }
    return n;
  }
}

export class CapacitorDbPersistence implements DbPersistence {
  private main = `${ROOT}/db/prcd.sqlite`;
  private prev = `${ROOT}/db/prcd.sqlite.prev`;
  private snap = (name: string) => `${ROOT}/snapshots/${name}.sqlite`;

  async load() {
    for (const path of [this.main, this.prev]) {
      try {
        const r = await Filesystem.readFile({ path, directory: Directory.Data });
        const data = typeof r.data === 'string' ? fromBase64(r.data) : new Uint8Array(await r.data.arrayBuffer());
        if (data.length) return data;
      } catch {
        /* try the previous copy */
      }
    }
    return null;
  }
  async save(bytes: Uint8Array) {
    // Keep the last good image as .prev, then atomically replace the main file.
    try {
      await Filesystem.copy({ from: this.main, to: this.prev, directory: Directory.Data, toDirectory: Directory.Data });
    } catch {
      /* first write */
    }
    await writeBytes(this.main, bytes);
  }
  async snapshot(name: string, bytes: Uint8Array) {
    await writeBytes(this.snap(name), bytes);
  }
  async listSnapshots() {
    try {
      const r = await Filesystem.readdir({ path: `${ROOT}/snapshots`, directory: Directory.Data });
      return r.files.filter((f) => f.name.endsWith('.sqlite')).map((f) => ({ name: f.name.replace(/\.sqlite$/, ''), size: f.size }));
    } catch {
      return [];
    }
  }
  async loadSnapshot(name: string) {
    try {
      const r = await Filesystem.readFile({ path: this.snap(name), directory: Directory.Data });
      return typeof r.data === 'string' ? fromBase64(r.data) : new Uint8Array(await r.data.arrayBuffer());
    } catch {
      return null;
    }
  }
  async deleteSnapshot(name: string) {
    try {
      await Filesystem.deleteFile({ path: this.snap(name), directory: Directory.Data });
    } catch {
      /* gone */
    }
  }
}
