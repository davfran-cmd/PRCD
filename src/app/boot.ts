import { Capacitor } from '@capacitor/core';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { Database, type DbPersistence } from '../db/database';
import { Repo } from '../db/repo';
import { CalendarService } from '../calendar/service';
import { createBridge, type CalendarBridge } from '../calendar/bridge';
import { DocsRepo } from '../documents/docsRepo';
import { CapacitorDbPersistence, CapacitorFileStore } from '../storage/capacitorStore';
import { IndexedDbFileStore, IndexedDbPersistence, type FileStore } from '../storage/fileStore';
import { maybeAutoSnapshot } from '../db/autoBackup';
import type { Services } from './AppContext';

export interface BootResult {
  services: Services;
}

/** Opens the local database and wires the services. Nothing here touches the network. */
export async function boot(): Promise<BootResult> {
  const native = Capacitor.isNativePlatform();
  const persistence: DbPersistence = native ? new CapacitorDbPersistence() : new IndexedDbPersistence();
  const files: FileStore = native ? new CapacitorFileStore() : new IndexedDbFileStore();
  // Ask the browser not to evict our data under storage pressure (no-op in the native app).
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not available */
  }
  const db = await Database.open(persistence, () => wasmUrl);
  const repo = new Repo(db);
  void maybeAutoSnapshot(db).catch(() => undefined);
  const docs = new DocsRepo(repo, files);

  let bridge: CalendarBridge = createBridge();
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('mockCalendar')) {
    // Development only: exercise the Apple Calendar UI in the browser against an in-memory EventKit stand-in.
    const { MockCalendarBridge } = await import('../calendar/mock');
    const mock = new MockCalendarBridge();
    mock.addThirdParty('cal-icloud', { title: 'Dentista', start: '2026-11-24T17:30', end: '2026-11-24T18:30' });
    bridge = mock;
  }
  const calendar = new CalendarService(repo, bridge);
  void calendar.init();

  // Flush pending writes when the page is hidden or closed.
  const flush = () => void db.flush().catch(() => undefined);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

  const services: Services = { db, repo, files, docs, calendar };
  if (import.meta.env.DEV) {
    // Development helper: `await __prcdSeed()` in the console loads the design's sample semester.
    (window as unknown as Record<string, unknown>).__prcdSeed = async () => {
      const { seedDevData } = await import('../dev/seed');
      await seedDevData(services);
    };
    (window as unknown as Record<string, unknown>).__prcd = services;
  }
  return { services };
}
