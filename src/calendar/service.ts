/**
 * CalendarService: the object the UI talks to. Owns permission state, the managed calendar, the
 * read-only cache of third-party events, the sync loop, and the triggers that keep things fresh
 * (EventKit store changes, app returning to the foreground, local edits).
 */
import type { Database } from '../db/database';
import type { Repo } from '../db/repo';
import { selectAll } from '../db/rows';
import { addDays, todayISO } from '../domain/dates';
import type { Settings } from '../domain/types';
import { CalendarAccessError, UnavailableBridge, type CalendarAuthStatus, type CalendarBridge, type NativeCalendar, type NativeEvent } from './bridge';
import {
  applyActions,
  collectLocalItems,
  defaultWindow,
  emptyReport,
  fieldsOfLocal,
  fieldsOfRemote,
  makeIsLocalGone,
  parseBase,
  planSync,
  readMaps,
  resolveConflict,
  resolveRemoteDeleted,
  type ConflictChoice,
  type Fields,
  type LocalSyncItem,
  type PendingConflict,
  type RemoteDeletedChoice,
  type SyncMapRow,
  type SyncReport,
  type SyncWindow,
} from './sync';

export interface AppleCalendarRow extends NativeCalendar {
  visible: boolean;
  isManaged: boolean;
}

export interface CalendarState {
  /** false on the web build: no EventKit. */
  available: boolean;
  auth: CalendarAuthStatus;
  enabled: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastReport: SyncReport | null;
  error: string | null;
  calendars: AppleCalendarRow[];
  conflicts: PendingConflict[];
}

type Listener = () => void;

export class CalendarService {
  private state: CalendarState;
  private listeners = new Set<Listener>();
  private inFlight: Promise<SyncReport> | null = null;
  private rerun = false;
  private unsubs: Array<() => void> = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private repo: Repo,
    private bridge: CalendarBridge,
    private opts: { debounceMs?: number; clock?: () => Date } = {},
  ) {
    const s = repo.getSettings();
    this.state = {
      available: bridge.native,
      auth: bridge.native ? 'notDetermined' : 'unavailable',
      enabled: s.appleCalendarEnabled,
      syncing: false,
      lastSyncAt: s.appleLastSyncAt,
      lastReport: null,
      error: null,
      calendars: [],
      conflicts: [],
    };
  }

  private get db(): Database {
    return this.repo.db;
  }
  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }

  // ----------------------------------------------------------------------------- state

  getState = (): CalendarState => this.state;

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private set(patch: Partial<CalendarState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private settings(): Settings {
    return this.repo.getSettings();
  }

  // ----------------------------------------------------------------------------- lifecycle

  /** Called at app start. Never prompts: it only reads the current permission. */
  async init(): Promise<void> {
    if (!this.bridge.native) return;
    await this.refreshAuth();
    this.loadCalendarsFromDb();
    this.loadConflicts();
    if (this.state.enabled && this.state.auth === 'fullAccess') {
      this.startWatchers();
      void this.syncNow('startup');
    }
  }

  private async refreshAuth(): Promise<CalendarAuthStatus> {
    const auth = await this.bridge.status();
    this.set({ auth });
    return auth;
  }

  /** User turned the integration on. This is the only place that triggers the system permission prompt. */
  async enable(): Promise<CalendarAuthStatus> {
    let auth = await this.refreshAuth();
    if (auth === 'notDetermined') auth = await this.bridge.requestFullAccess();
    this.set({ auth });
    if (auth !== 'fullAccess') return auth; // denied / restricted / write-only: stay off, app keeps working
    this.repo.updateSettings({ appleCalendarEnabled: true });
    this.set({ enabled: true, error: null });
    this.startWatchers();
    await this.syncNow('enable');
    return auth;
  }

  disable(): void {
    this.repo.updateSettings({ appleCalendarEnabled: false });
    this.stopWatchers();
    this.set({ enabled: false });
  }

  dispose(): void {
    this.stopWatchers();
    clearTimeout(this.debounce);
  }

  openSystemSettings(): Promise<void> {
    return this.bridge.openSystemSettings();
  }

  // ----------------------------------------------------------------------------- watchers

  private startWatchers() {
    if (this.unsubs.length) return;
    const trigger = (reason: string) => this.schedule(reason);
    this.unsubs.push(this.bridge.onStoreChanged(() => trigger('store-changed')));
    if (typeof document !== 'undefined') {
      const onVis = () => document.visibilityState === 'visible' && trigger('foreground');
      document.addEventListener('visibilitychange', onVis);
      this.unsubs.push(() => document.removeEventListener('visibilitychange', onVis));
      // and every 5 minutes while the app is open, for changes EventKit does not report
      const timer = setInterval(() => document.visibilityState === 'visible' && trigger('periodic'), 5 * 60 * 1000);
      this.unsubs.push(() => clearInterval(timer));
    }
    this.unsubs.push(
      this.db.subscribe((tables) => {
        if (tables.has('lessons') || tables.has('calendar_events') || tables.has('event_exceptions') || tables.has('*')) trigger('local-change');
      }),
    );
  }

  private stopWatchers() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  private schedule(reason: string) {
    if (!this.state.enabled) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(reason), this.opts.debounceMs ?? 1200);
  }

  // ----------------------------------------------------------------------------- sync

  /** Single-flight: a request that arrives during a sync schedules exactly one more run. */
  async syncNow(_reason = 'manual'): Promise<SyncReport> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = this.runSync().finally(async () => {
      this.inFlight = null;
      if (this.rerun) {
        this.rerun = false;
        void this.syncNow('rerun');
      }
    });
    return this.inFlight;
  }

  private async runSync(): Promise<SyncReport> {
    if (!this.bridge.native) return emptyReport();
    this.set({ syncing: true });
    try {
      const auth = await this.refreshAuth();
      if (auth !== 'fullAccess') {
        // Permission revoked (or never granted): keep every mapping and all local data; just pause.
        this.set({ syncing: false, error: auth === 'denied' || auth === 'restricted' ? 'Accesso ai calendari revocato. Riattivalo da Impostazioni iPad > Privacy > Calendari.' : null });
        return emptyReport();
      }
      const settings = this.settings();
      const today = todayISO(this.now());
      const win = defaultWindow(today);
      const managed = await this.bridge.ensureManagedCalendar(settings.appleManagedCalendarName, settings.appleManagedCalendarId);
      if (managed.id !== settings.appleManagedCalendarId) this.repo.updateSettings({ appleManagedCalendarId: managed.id });
      const calendars = await this.bridge.listCalendars();
      this.storeCalendars(calendars, managed.id);

      const fresh = this.settings(); // visible calendars may have just been initialised
      const maps = readMaps(this.repo);
      const local = collectLocalItems(this.repo, fresh, win, managed.id);
      const remote = await this.fetchRemote(win, managed.id, maps, local, fresh);
      const actions = planSync({ local, maps, remote: remote.all, managedCalendarId: managed.id, isLocalGone: makeIsLocalGone(this.repo, fresh) });
      const nowIso = this.now().toISOString();
      const report = await applyActions(this.repo, this.bridge, actions, nowIso);
      this.refreshExternalCache(remote.visibleEvents, calendars, settings, win);
      this.repo.updateSettings({ appleLastSyncAt: nowIso });
      this.loadConflicts();
      this.set({ syncing: false, lastSyncAt: nowIso, lastReport: report, error: report.errors.length ? report.errors[0] : null });
      return report;
    } catch (e) {
      if (e instanceof CalendarAccessError) {
        await this.refreshAuth();
        this.set({ syncing: false, error: 'Accesso ai calendari revocato.' });
        return emptyReport();
      }
      this.set({ syncing: false, error: e instanceof Error ? e.message : String(e) });
      return emptyReport();
    }
  }

  private async fetchRemote(win: SyncWindow, managedId: string, maps: SyncMapRow[], local: LocalSyncItem[], settings: Settings) {
    const ids = new Set<string>([managedId]);
    for (const m of maps) if (m.calendarId) ids.add(m.calendarId);
    for (const i of local) if (i.calendarId) ids.add(i.calendarId);
    const visible = settings.appleVisibleCalendarIds;
    for (const v of visible) ids.add(v);
    const fetched = await this.bridge.fetchEvents([...ids], win.from, win.to);
    const all = new Map<string, NativeEvent>(fetched.map((e) => [e.ekEventId, e]));
    // An event moved outside the window (or whose id changed) must not look "deleted": ask for it by id.
    for (const i of local) {
      const m = maps.find((x) => x.localKind === i.kind && x.localId === i.localId);
      if (m?.ekEventId && !all.has(m.ekEventId)) {
        const e = await this.bridge.getEvent(m.ekEventId);
        if (e) all.set(e.ekEventId, e);
      }
    }
    return { all: [...all.values()], visibleEvents: fetched.filter((e) => visible.includes(e.calendarId)) };
  }

  private storeCalendars(calendars: NativeCalendar[], managedId: string) {
    const settings = this.settings();
    const prevVisible = new Set(settings.appleVisibleCalendarIds);
    const firstTime = !settings.appleVisibleCalendarIds.length && !this.db.get('SELECT 1 FROM apple_calendars LIMIT 1');
    const nowIso = this.now().toISOString();
    this.db.transaction(() => {
      const known = new Set<string>();
      for (const c of calendars) {
        known.add(c.id);
        const visible = firstTime ? c.id !== managedId : prevVisible.has(c.id);
        this.db.run(
          `INSERT INTO apple_calendars(id, title, source_title, color, allows_modifications, visible, is_managed, last_seen_at) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, source_title=excluded.source_title, color=excluded.color, allows_modifications=excluded.allows_modifications, is_managed=excluded.is_managed, last_seen_at=excluded.last_seen_at`,
          [c.id, c.title, c.sourceTitle, c.color, c.allowsModifications ? 1 : 0, visible ? 1 : 0, c.id === managedId ? 1 : 0, nowIso],
        );
      }
      // Calendars that disappeared in Apple Calendar are dropped from the list (their cached events go too).
      for (const row of this.db.all<{ id: string }>('SELECT id FROM apple_calendars')) {
        if (!known.has(row.id)) {
          this.db.run('DELETE FROM apple_calendars WHERE id = ?', [row.id]);
          this.db.run('DELETE FROM external_events WHERE calendar_id = ?', [row.id]);
        }
      }
      const visibleIds = this.db.all<{ id: string }>('SELECT id FROM apple_calendars WHERE visible = 1').map((r) => r.id);
      this.repo.updateSettings({ appleVisibleCalendarIds: visibleIds });
    });
    this.loadCalendarsFromDb();
  }

  private refreshExternalCache(events: NativeEvent[], calendars: NativeCalendar[], settings: Settings, win: SyncWindow) {
    const visible = new Set(this.settings().appleVisibleCalendarIds);
    const managedIds = new Set(readMaps(this.repo).map((m) => m.ekEventId).filter(Boolean) as string[]);
    const nowIso = this.now().toISOString();
    this.db.transaction(() => {
      this.db.run('DELETE FROM external_events WHERE substr(starts_at,1,10) <= ? AND substr(ends_at,1,10) >= ?', [win.to, win.from]);
      for (const e of events) {
        if (!visible.has(e.calendarId) || managedIds.has(e.ekEventId)) continue;
        this.db.run(
          `INSERT OR REPLACE INTO external_events(id, calendar_id, ek_event_id, ek_external_id, title, starts_at, ends_at, all_day, location, last_modified, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [`${e.calendarId}::${e.ekEventId}`, e.calendarId, e.ekEventId, e.externalId, e.title, e.start, e.end, e.allDay ? 1 : 0, e.location, e.lastModified, nowIso],
        );
      }
    });
    void calendars;
    void settings;
  }

  private loadCalendarsFromDb() {
    const rows = selectAll<{ id: string; title: string; sourceTitle: string; color: string; allowsModifications: number; visible: number; isManaged: number }>(
      this.db,
      'SELECT id, title, source_title, color, allows_modifications, visible, is_managed FROM apple_calendars ORDER BY is_managed DESC, source_title, title',
    );
    this.set({
      calendars: rows.map((r) => ({ id: r.id, title: r.title, sourceTitle: r.sourceTitle, color: r.color, allowsModifications: Boolean(r.allowsModifications), isSubscribed: false, visible: Boolean(r.visible), isManaged: Boolean(r.isManaged) })),
    });
  }

  // ----------------------------------------------------------------------------- user choices

  setCalendarVisible(id: string, visible: boolean): void {
    this.db.run('UPDATE apple_calendars SET visible = ? WHERE id = ?', [visible ? 1 : 0, id]);
    const ids = this.db.all<{ id: string }>('SELECT id FROM apple_calendars WHERE visible = 1').map((r) => r.id);
    this.repo.updateSettings({ appleVisibleCalendarIds: ids });
    if (!visible) this.db.run('DELETE FROM external_events WHERE calendar_id = ?', [id]);
    this.loadCalendarsFromDb();
    this.schedule('visibility');
  }

  setDefaultCalendar(id: string | null): void {
    this.repo.updateSettings({ appleDefaultCalendarId: id });
  }

  setPublishLessons(on: boolean): void {
    this.repo.updateSettings({ appleSyncLessons: on });
    if (on) void this.syncNow('publish-lessons');
  }

  /** Explicitly remove the lesson events PRCD created in Apple Calendar (e.g. after turning publishing off). */
  async removeLessonEventsFromApple(): Promise<number> {
    let n = 0;
    for (const m of readMaps(this.repo).filter((x) => x.localKind === 'lesson')) {
      if (m.ekEventId) {
        try {
          const remote = await this.bridge.getEvent(m.ekEventId);
          if (remote) await this.bridge.deleteEvent(remote.ekEventId);
        } catch (e) {
          if (e instanceof CalendarAccessError) throw e;
        }
      }
      this.db.run("DELETE FROM sync_map WHERE local_kind = 'lesson' AND local_id = ?", [m.localId]);
      n += 1;
    }
    return n;
  }

  /** Route a personal event to Apple Calendar ('managed' = the Procedo calendar, null = local only). */
  async setEventDestination(eventId: string, destination: string | null): Promise<void> {
    this.repo.updateEvent(eventId, { appleCalendarId: destination });
    if (this.state.enabled) await this.syncNow('event-destination');
  }

  // ----------------------------------------------------------------------------- conflicts

  private loadConflicts() {
    const settings = this.settings();
    const managed = settings.appleManagedCalendarId ?? '';
    const items = new Map(collectLocalItems(this.repo, { ...settings, appleSyncLessons: true }, defaultWindow(todayISO(this.now())), managed).map((i) => [`${i.kind}:${i.localId}`, i]));
    const pending: PendingConflict[] = [];
    for (const m of readMaps(this.repo)) {
      if (m.status !== 'conflict' && m.status !== 'remote_deleted') continue;
      const item = items.get(`${m.localKind}:${m.localId}`) ?? null;
      const local: Fields | null = item ? fieldsOfLocal(item) : null;
      const remoteBase = m.remoteFingerprint ? parseBase(m.remoteFingerprint, local ?? { title: '', notes: '', start: '', end: '', allDay: false }) : null;
      pending.push({ map: m, kind: m.status === 'conflict' ? 'conflict' : 'remote_deleted', title: item?.title ?? m.localId, local, remote: remoteBase, fields: m.error ? [m.error] : [] });
    }
    this.set({ conflicts: pending });
  }

  /** Fresh remote snapshot for the conflict sheet. */
  async remoteSnapshot(map: SyncMapRow): Promise<Fields | null> {
    if (!map.ekEventId) return null;
    const e = await this.bridge.getEvent(map.ekEventId);
    return e ? fieldsOfRemote(e) : null;
  }

  async resolve(map: SyncMapRow, choice: ConflictChoice | RemoteDeletedChoice): Promise<void> {
    const settings = this.settings();
    const managed = settings.appleManagedCalendarId ?? '';
    const win = defaultWindow(todayISO(this.now()));
    const item = collectLocalItems(this.repo, { ...settings, appleSyncLessons: true }, win, managed).find((i) => i.kind === map.localKind && i.localId === map.localId) ?? null;
    const nowIso = this.now().toISOString();
    if (map.status === 'remote_deleted') {
      await resolveRemoteDeleted(this.repo, this.bridge, item, map, choice as RemoteDeletedChoice, managed, nowIso);
    } else {
      if (!item) throw new Error('L’elemento locale non esiste più.');
      await resolveConflict(this.repo, this.bridge, item, map, choice as ConflictChoice, nowIso);
    }
    this.loadConflicts();
    void this.syncNow('after-resolve');
  }

  // ----------------------------------------------------------------------------- external range

  /** Make sure read-only events for a visible range are cached (called when the user navigates the calendar). */
  async ensureExternalRange(from: string, to: string): Promise<void> {
    if (!this.state.enabled || this.state.auth !== 'fullAccess') return;
    const settings = this.settings();
    if (!settings.appleVisibleCalendarIds.length) return;
    try {
      const events = await this.bridge.fetchEvents(settings.appleVisibleCalendarIds, from, to);
      const managedIds = new Set(readMaps(this.repo).map((m) => m.ekEventId).filter(Boolean) as string[]);
      const nowIso = this.now().toISOString();
      this.db.transaction(() => {
        this.db.run('DELETE FROM external_events WHERE substr(starts_at,1,10) <= ? AND substr(ends_at,1,10) >= ?', [to, from]);
        for (const e of events) {
          if (managedIds.has(e.ekEventId)) continue;
          this.db.run(
            `INSERT OR REPLACE INTO external_events(id, calendar_id, ek_event_id, ek_external_id, title, starts_at, ends_at, all_day, location, last_modified, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            [`${e.calendarId}::${e.ekEventId}`, e.calendarId, e.ekEventId, e.externalId, e.title, e.start, e.end, e.allDay ? 1 : 0, e.location, e.lastModified, nowIso],
          );
        }
      });
    } catch {
      /* offline or revoked: the cached events keep showing */
    }
  }
}

export function createUnavailableService(repo: Repo): CalendarService {
  return new CalendarService(repo, new UnavailableBridge());
}

export { addDays };
