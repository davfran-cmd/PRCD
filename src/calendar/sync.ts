/**
 * Apple Calendar synchronisation layer.
 *
 * Design rules (see docs/ARCHITECTURE.md §Calendar):
 *  - Sync unit = one occurrence. Each university lesson, and each occurrence of a recurring personal
 *    event, is its own EKEvent keyed by a stable internal id (lesson uuid / event uuid[@date]).
 *  - `sync_map` links local id → EventKit ids. EventKit ids are NOT trusted: every EKEvent PRCD creates
 *    carries a `prcd://kind/id` marker in its URL, and reconciliation re-finds events by marker, then by
 *    external id, so an identifier change never causes a duplicate or a loss.
 *  - Duplicate prevention: before creating, look for an existing event with the same marker.
 *  - Three-way, field-level merge against the baseline stored at the last sync. A field changed on both
 *    sides to different values is a conflict: nothing is applied for that item until the user chooses.
 *  - Only events PRCD created (those with a map) are ever modified or deleted in Apple Calendar.
 *    Third-party events are cached read-only.
 *  - Local data is never deleted by sync: an event deleted in Apple Calendar becomes `remote_deleted`
 *    and waits for the user's decision.
 */
import type { Repo } from '../db/repo';
import { selectAll } from '../db/rows';
import { addDays, splitLocalDateTime, type ISODate, type LocalDateTime } from '../domain/dates';
import { expandEvent } from '../domain/recurrence';
import { lessonEnd, lessonStart } from '../domain/timetable';
import type { Settings } from '../domain/types';
import { CalendarAccessError, markerUrl, parseMarker, type CalendarBridge, type NativeCalendar, type NativeEvent } from './bridge';

export type SyncKind = 'lesson' | 'event' | 'exam';
export type SyncStatus = 'pending' | 'synced' | 'conflict' | 'error' | 'remote_deleted';

export interface Fields {
  title: string;
  notes: string;
  start: LocalDateTime;
  end: LocalDateTime;
  allDay: boolean;
}
export const ALL_FIELDS: Array<keyof Fields> = ['title', 'notes', 'start', 'end', 'allDay'];

export interface LocalSyncItem extends Fields {
  kind: SyncKind;
  localId: string;
  alarm: number | null;
  /** null = the app-managed calendar. */
  calendarId: string | null;
}

export interface SyncMapRow {
  localKind: SyncKind;
  localId: string;
  ekEventId: string | null;
  ekExternalId: string | null;
  calendarId: string | null;
  lastSyncedAt: string | null;
  localFingerprint: string | null; // JSON baseline of the local side
  remoteFingerprint: string | null; // JSON baseline of the remote side
  remoteLastModified: string | null;
  status: SyncStatus;
  error: string | null;
}

export function fieldsOfRemote(e: NativeEvent): Fields {
  return { title: e.title, notes: e.notes, start: e.start, end: e.end, allDay: e.allDay };
}
export function fieldsOfLocal(i: LocalSyncItem): Fields {
  return { title: i.title, notes: i.notes, start: i.start, end: i.end, allDay: i.allDay };
}

/** Fields that must be equal for an item to count as "in sync". Lesson titles belong to PRCD and may drift. */
export function comparableFields(kind: SyncKind): Array<keyof Fields> {
  return kind === 'lesson' || kind === 'exam' ? ['start', 'end'] : ALL_FIELDS;
}

/** Which fields flow from Apple Calendar back into PRCD. Lessons only follow time changes. */
export function pullableFields(kind: SyncKind): Array<keyof Fields> {
  return kind === 'lesson' || kind === 'exam' ? ['start', 'end'] : ALL_FIELDS;
}

export interface MergeResult {
  push: Partial<Fields>;
  pull: Partial<Fields>;
  conflicts: Array<keyof Fields>;
}

/** Three-way merge of one item. `localBase`/`remoteBase` are the states agreed at the last sync. */
export function mergeFields(kind: SyncKind, local: Fields, remote: Fields, localBase: Fields, remoteBase: Fields): MergeResult {
  const out: MergeResult = { push: {}, pull: {}, conflicts: [] };
  const pullable = new Set(pullableFields(kind));
  for (const f of ALL_FIELDS) {
    const lc = local[f] !== localBase[f];
    const rc = pullable.has(f) && remote[f] !== remoteBase[f];
    if (local[f] === remote[f]) continue;
    if (lc && rc) out.conflicts.push(f);
    else if (lc) (out.push as Record<string, unknown>)[f] = local[f];
    else if (rc) (out.pull as Record<string, unknown>)[f] = remote[f];
    else if (!pullable.has(f)) {
      // Field PRCD owns and Apple Calendar may drift on (e.g. a renamed lesson title): leave it alone.
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------ planning

export type SyncAction =
  | { type: 'create'; item: LocalSyncItem }
  | { type: 'adopt'; item: LocalSyncItem; remote: NativeEvent }
  | { type: 'update'; item: LocalSyncItem; map: SyncMapRow; remote: NativeEvent; merge: MergeResult }
  | { type: 'conflict'; item: LocalSyncItem; map: SyncMapRow; remote: NativeEvent; merge: MergeResult }
  | { type: 'relink'; item: LocalSyncItem; map: SyncMapRow; remote: NativeEvent }
  | { type: 'remote_deleted'; item: LocalSyncItem; map: SyncMapRow }
  | { type: 'delete_remote'; map: SyncMapRow; remote: NativeEvent | null }
  | { type: 'unlink'; map: SyncMapRow; reason: string };

export interface PlanInput {
  local: LocalSyncItem[];
  maps: SyncMapRow[];
  /** Events fetched from the managed calendar and every calendar a mapped event lives in. */
  remote: NativeEvent[];
  managedCalendarId: string;
  /** Is the local counterpart of this map gone for good (deleted/cancelled/opted out)? */
  isLocalGone: (m: SyncMapRow) => boolean;
  /** Mappings whose local item is only outside the sync window are left alone. */
}

export function parseBase(json: string | null, fallback: Fields): Fields {
  if (!json) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(json) as Partial<Fields>) };
  } catch {
    return fallback;
  }
}

export function planSync(input: PlanInput): SyncAction[] {
  const actions: SyncAction[] = [];
  const byEkId = new Map(input.remote.map((e) => [e.ekEventId, e]));
  const byMarker = new Map<string, NativeEvent>();
  const byExternal = new Map<string, NativeEvent>();
  for (const e of input.remote) {
    const m = parseMarker(e.url);
    if (m) byMarker.set(`${m.kind}:${m.id}`, e);
    if (e.externalId) byExternal.set(e.externalId, e);
  }
  const mapOf = new Map(input.maps.map((m) => [`${m.localKind}:${m.localId}`, m]));
  const claimed = new Set<string>();

  for (const item of input.local) {
    const key = `${item.kind}:${item.localId}`;
    const map = mapOf.get(key);
    if (!map || !map.ekEventId) {
      // Duplicate prevention: an event with our marker may already exist (restore, reinstall, lost map).
      const existing = byMarker.get(key);
      if (existing && !claimed.has(existing.ekEventId)) {
        claimed.add(existing.ekEventId);
        actions.push({ type: 'adopt', item, remote: existing });
      } else actions.push({ type: 'create', item });
      continue;
    }
    // Re-find the remote event: by id, then by our marker, then by external id.
    let remote = byEkId.get(map.ekEventId) ?? byMarker.get(key) ?? (map.ekExternalId ? byExternal.get(map.ekExternalId) : undefined);
    if (remote && claimed.has(remote.ekEventId)) remote = undefined;
    if (!remote) {
      actions.push({ type: 'remote_deleted', item, map });
      continue;
    }
    claimed.add(remote.ekEventId);
    const local = fieldsOfLocal(item);
    const remoteFields = fieldsOfRemote(remote);
    const localBase = parseBase(map.localFingerprint, local);
    const remoteBase = parseBase(map.remoteFingerprint, remoteFields);
    const merge = mergeFields(item.kind, local, remoteFields, localBase, remoteBase);
    const idChanged = remote.ekEventId !== map.ekEventId || remote.calendarId !== map.calendarId || remote.externalId !== map.ekExternalId;
    const cmp = comparableFields(item.kind);
    const stillDiffering = cmp.filter((f) => local[f] !== remoteFields[f]);
    if (merge.conflicts.length) actions.push({ type: 'conflict', item, map, remote, merge });
    else if (map.status === 'conflict' && stillDiffering.length) {
      // An unresolved conflict stays a conflict until the user picks a side (or makes both sides equal).
      actions.push({ type: 'conflict', item, map, remote, merge: { push: {}, pull: {}, conflicts: stillDiffering } });
    } else if (Object.keys(merge.push).length || Object.keys(merge.pull).length) actions.push({ type: 'update', item, map, remote, merge });
    else if (idChanged || map.status !== 'synced') actions.push({ type: 'relink', item, map, remote });
  }

  // Mapped events with no desired local item.
  const desired = new Set(input.local.map((i) => `${i.kind}:${i.localId}`));
  for (const map of input.maps) {
    if (desired.has(`${map.localKind}:${map.localId}`)) continue;
    if (!input.isLocalGone(map)) continue; // outside the window / paused: leave it alone
    const remote = (map.ekEventId ? byEkId.get(map.ekEventId) : undefined) ?? byMarker.get(`${map.localKind}:${map.localId}`) ?? null;
    if (!remote) {
      actions.push({ type: 'unlink', map, reason: 'already removed' });
      continue;
    }
    // If the user edited the event in Apple Calendar after our last sync, do not delete their edit.
    const base = parseBase(map.remoteFingerprint, fieldsOfRemote(remote));
    const f = fieldsOfRemote(remote);
    const edited = ALL_FIELDS.some((k) => k !== 'notes' && f[k] !== base[k]);
    if (edited) actions.push({ type: 'unlink', map, reason: 'modificato in Calendario di Apple dopo l’ultima sincronizzazione: lasciato lì' });
    else actions.push({ type: 'delete_remote', map, remote });
  }
  return actions;
}

// ------------------------------------------------------------------------------------ collecting

export interface SyncWindow {
  from: ISODate;
  to: ISODate;
}

export function defaultWindow(today: ISODate): SyncWindow {
  return { from: addDays(today, -30), to: addDays(today, 180) };
}

export function collectLocalItems(repo: Repo, settings: Settings, win: SyncWindow, managedCalendarId: string): LocalSyncItem[] {
  const items: LocalSyncItem[] = [];
  const courses = new Map(repo.courses({ includeArchived: true, includeHidden: true }).map((c) => [c.id, c]));
  if (settings.appleSyncLessons) {
    for (const l of repo.lessonsInRange(win.from, win.to)) {
      if (l.cancelled) continue;
      const c = courses.get(l.courseId);
      if (!c) continue;
      items.push({ kind: 'lesson', localId: l.id, title: c.name, notes: l.topic, start: lessonStart(l), end: lessonEnd(l), allDay: false, alarm: null, calendarId: managedCalendarId });
    }
  }
  const exceptions = repo.eventExceptions();
  for (const e of repo.eventsMaybeIn(win.from, win.to)) {
    if (!e.appleCalendarId) continue;
    const calendarId = e.appleCalendarId === 'managed' ? managedCalendarId : e.appleCalendarId;
    for (const o of expandEvent(e, exceptions, win.from, win.to)) {
      items.push({
        kind: 'event',
        localId: e.recurrence ? `${e.id}@${o.originalDate}` : e.id,
        title: o.title,
        notes: e.description,
        start: o.start,
        end: o.end,
        allDay: e.allDay,
        alarm: e.reminderMinutes,
        calendarId,
      });
    }
  }
  return items;
}

/** Is the local counterpart of a map definitively gone (as opposed to merely outside the window)? */
export function makeIsLocalGone(repo: Repo, settings: Settings): (m: SyncMapRow) => boolean {
  return (m) => {
    if (m.localKind === 'lesson') {
      if (!settings.appleSyncLessons) return false; // paused, handled by an explicit "remove from Apple" action
      const l = repo.lesson(m.localId);
      return !l || l.cancelled;
    }
    if (m.localKind === 'event') {
      const [eventId, occ] = m.localId.split('@');
      const e = repo.event(eventId);
      if (!e || !e.appleCalendarId) return true;
      if (occ) {
        const ex = repo.eventExceptions(eventId).find((x) => x.originalDate === occ);
        if (ex?.cancelled) return true;
      }
      return false;
    }
    return true;
  };
}

// ------------------------------------------------------------------------------------ persistence

const MAP_SPEC = { bool: [] as string[] };

export function readMaps(repo: Repo): SyncMapRow[] {
  return selectAll<SyncMapRow>(repo.db, 'SELECT * FROM sync_map', [], MAP_SPEC);
}

function saveMap(repo: Repo, row: SyncMapRow): void {
  repo.db.run(
    `INSERT INTO sync_map(local_kind, local_id, ek_event_id, ek_external_id, calendar_id, last_synced_at, local_fingerprint, remote_fingerprint, remote_last_modified, status, error)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(local_kind, local_id) DO UPDATE SET ek_event_id=excluded.ek_event_id, ek_external_id=excluded.ek_external_id, calendar_id=excluded.calendar_id,
       last_synced_at=excluded.last_synced_at, local_fingerprint=excluded.local_fingerprint, remote_fingerprint=excluded.remote_fingerprint,
       remote_last_modified=excluded.remote_last_modified, status=excluded.status, error=excluded.error`,
    [row.localKind, row.localId, row.ekEventId, row.ekExternalId, row.calendarId, row.lastSyncedAt, row.localFingerprint, row.remoteFingerprint, row.remoteLastModified, row.status, row.error],
  );
}

function deleteMap(repo: Repo, kind: string, id: string) {
  repo.db.run('DELETE FROM sync_map WHERE local_kind = ? AND local_id = ?', [kind, id]);
}

// ------------------------------------------------------------------------------------ applying

export interface SyncReport {
  created: number;
  updated: number;
  pulled: number;
  adopted: number;
  deletedRemote: number;
  relinked: number;
  conflicts: number;
  remoteDeleted: number;
  warnings: string[];
  errors: string[];
}

export const emptyReport = (): SyncReport => ({ created: 0, updated: 0, pulled: 0, adopted: 0, deletedRemote: 0, relinked: 0, conflicts: 0, remoteDeleted: 0, warnings: [], errors: [] });

const toInput = (item: LocalSyncItem, calendarId: string) => ({
  calendarId,
  title: item.title,
  notes: item.notes,
  start: item.start,
  end: item.end,
  allDay: item.allDay,
  url: markerUrl(item.kind, item.localId),
  alarmMinutesBefore: item.alarm,
});

/** Writes remote-originated fields back into PRCD without touching attendance or identity. */
export function pullIntoLocal(repo: Repo, item: LocalSyncItem, pull: Partial<Fields>): void {
  if (item.kind === 'lesson') {
    const l = repo.lesson(item.localId);
    if (!l) return;
    const start = pull.start ?? item.start;
    const end = pull.end ?? item.end;
    const s = splitLocalDateTime(start);
    const e = splitLocalDateTime(end);
    // A move changes date/time only. Attendance, topic and identity are untouched.
    repo.editLesson(l.id, 'one', { date: s.date, startTime: s.time, endTime: e.time });
    return;
  }
  if (item.kind === 'event') {
    const [eventId, occ] = item.localId.split('@');
    const ev = repo.event(eventId);
    if (!ev) return;
    if (occ) {
      repo.setEventException(eventId, occ as ISODate, { start: pull.start ?? item.start, end: pull.end ?? item.end, title: pull.title ?? item.title });
    } else {
      repo.updateEvent(eventId, {
        ...(pull.title !== undefined ? { title: pull.title } : {}),
        ...(pull.notes !== undefined ? { description: pull.notes } : {}),
        ...(pull.start !== undefined ? { start: pull.start } : {}),
        ...(pull.end !== undefined ? { end: pull.end } : {}),
        ...(pull.allDay !== undefined ? { allDay: pull.allDay } : {}),
      });
    }
  }
}

function merged(item: LocalSyncItem, merge: MergeResult): Fields {
  return { ...fieldsOfLocal(item), ...merge.pull };
}

export async function applyActions(repo: Repo, bridge: CalendarBridge, actions: SyncAction[], nowIso: string): Promise<SyncReport> {
  const report = emptyReport();
  const synced = (item: LocalSyncItem, remote: NativeEvent, base: Fields, status: SyncStatus = 'synced'): SyncMapRow => ({
    localKind: item.kind,
    localId: item.localId,
    ekEventId: remote.ekEventId,
    ekExternalId: remote.externalId,
    calendarId: remote.calendarId,
    lastSyncedAt: nowIso,
    localFingerprint: JSON.stringify(base),
    remoteFingerprint: JSON.stringify(fieldsOfRemote(remote)),
    remoteLastModified: remote.lastModified,
    status,
    error: null,
  });

  for (const a of actions) {
    try {
      switch (a.type) {
        case 'create': {
          const remote = await bridge.createEvent(toInput(a.item, a.item.calendarId as string));
          saveMap(repo, synced(a.item, remote, fieldsOfLocal(a.item)));
          report.created += 1;
          break;
        }
        case 'adopt': {
          const local = fieldsOfLocal(a.item);
          const remoteFields = fieldsOfRemote(a.remote);
          const same = comparableFields(a.item.kind).every((f) => local[f] === remoteFields[f]);
          if (same) saveMap(repo, synced(a.item, a.remote, local));
          else {
            // Both exist and differ and there is no baseline: we cannot know which is newer.
            saveMap(repo, synced(a.item, a.remote, local, 'conflict'));
            report.conflicts += 1;
          }
          report.adopted += 1;
          break;
        }
        case 'update': {
          let remote = a.remote;
          let base = fieldsOfLocal(a.item);
          if (Object.keys(a.merge.pull).length) {
            pullIntoLocal(repo, a.item, a.merge.pull);
            base = merged(a.item, a.merge);
            report.pulled += 1;
          }
          if (Object.keys(a.merge.push).length) {
            remote = await bridge.updateEvent(a.remote.ekEventId, { ...a.merge.push, url: markerUrl(a.item.kind, a.item.localId) });
            report.updated += 1;
          }
          saveMap(repo, synced(a.item, remote, base));
          break;
        }
        case 'conflict': {
          saveMap(repo, { ...a.map, ekEventId: a.remote.ekEventId, ekExternalId: a.remote.externalId, calendarId: a.remote.calendarId, status: 'conflict', error: `Modificato in entrambi: ${a.merge.conflicts.join(', ')}` });
          report.conflicts += 1;
          break;
        }
        case 'relink': {
          saveMap(repo, synced(a.item, a.remote, parseBase(a.map.localFingerprint, fieldsOfLocal(a.item))));
          report.relinked += 1;
          break;
        }
        case 'remote_deleted': {
          saveMap(repo, { ...a.map, status: 'remote_deleted', error: 'Eliminato da Calendario di Apple' });
          report.remoteDeleted += 1;
          break;
        }
        case 'delete_remote': {
          if (a.remote) await bridge.deleteEvent(a.remote.ekEventId);
          deleteMap(repo, a.map.localKind, a.map.localId);
          report.deletedRemote += 1;
          break;
        }
        case 'unlink': {
          deleteMap(repo, a.map.localKind, a.map.localId);
          report.warnings.push(`${a.map.localKind} ${a.map.localId}: ${a.reason}`);
          break;
        }
      }
    } catch (e) {
      if (e instanceof CalendarAccessError) throw e;
      report.errors.push(e instanceof Error ? e.message : String(e));
      if ('map' in a && a.map) saveMap(repo, { ...a.map, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

// ------------------------------------------------------------------------------------ conflicts

export type ConflictChoice = 'keep_local' | 'keep_remote';
export type RemoteDeletedChoice = 'recreate' | 'remove_local' | 'unlink';

export interface PendingConflict {
  map: SyncMapRow;
  kind: 'conflict' | 'remote_deleted';
  title: string;
  local: Fields | null;
  remote: Fields | null;
  fields: string[];
}

/** Resolve a conflict explicitly chosen by the user. */
export async function resolveConflict(repo: Repo, bridge: CalendarBridge, item: LocalSyncItem, map: SyncMapRow, choice: ConflictChoice, nowIso: string): Promise<void> {
  const remote = map.ekEventId ? await bridge.getEvent(map.ekEventId) : null;
  if (!remote) throw new Error('L’evento non esiste più in Calendario di Apple.');
  if (choice === 'keep_local') {
    const r = await bridge.updateEvent(remote.ekEventId, { title: item.title, notes: item.notes, start: item.start, end: item.end, allDay: item.allDay, url: markerUrl(item.kind, item.localId) });
    saveMap(repo, { localKind: item.kind, localId: item.localId, ekEventId: r.ekEventId, ekExternalId: r.externalId, calendarId: r.calendarId, lastSyncedAt: nowIso, localFingerprint: JSON.stringify(fieldsOfLocal(item)), remoteFingerprint: JSON.stringify(fieldsOfRemote(r)), remoteLastModified: r.lastModified, status: 'synced', error: null });
  } else {
    const rf = fieldsOfRemote(remote);
    const pull: Partial<Fields> = {};
    for (const f of pullableFields(item.kind)) (pull as Record<string, unknown>)[f] = rf[f];
    pullIntoLocal(repo, item, pull);
    const nextLocal: Fields = { ...fieldsOfLocal(item), ...pull };
    saveMap(repo, { localKind: item.kind, localId: item.localId, ekEventId: remote.ekEventId, ekExternalId: remote.externalId, calendarId: remote.calendarId, lastSyncedAt: nowIso, localFingerprint: JSON.stringify(nextLocal), remoteFingerprint: JSON.stringify(rf), remoteLastModified: remote.lastModified, status: 'synced', error: null });
  }
}

export async function resolveRemoteDeleted(repo: Repo, bridge: CalendarBridge, item: LocalSyncItem | null, map: SyncMapRow, choice: RemoteDeletedChoice, calendarId: string, nowIso: string): Promise<void> {
  if (choice === 'unlink') {
    deleteMap(repo, map.localKind, map.localId);
    return;
  }
  if (choice === 'recreate') {
    if (!item) throw new Error('L’elemento locale non esiste più.');
    const r = await bridge.createEvent(toInput(item, map.calendarId ?? calendarId));
    saveMap(repo, { localKind: item.kind, localId: item.localId, ekEventId: r.ekEventId, ekExternalId: r.externalId, calendarId: r.calendarId, lastSyncedAt: nowIso, localFingerprint: JSON.stringify(fieldsOfLocal(item)), remoteFingerprint: JSON.stringify(fieldsOfRemote(r)), remoteLastModified: r.lastModified, status: 'synced', error: null });
    return;
  }
  // remove_local: soft for lessons (cancelled, attendance kept), explicit delete for personal events.
  if (map.localKind === 'lesson') repo.cancelLesson(map.localId, true);
  else {
    const [eventId, occ] = map.localId.split('@');
    if (occ) repo.setEventException(eventId, occ as ISODate, { cancelled: true });
    else repo.deleteEvent(eventId);
  }
  deleteMap(repo, map.localKind, map.localId);
}

export type { NativeCalendar };
