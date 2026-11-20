/**
 * In-memory stand-in for EventKit, used by the sync tests and by `?mockCalendar=1` during web development.
 * It mimics the behaviours the sync layer must survive: identifiers that change, events moved between
 * calendars, third-party edits, deleted events, denied/revoked permission and store-change notifications.
 */
import { addDays, type ISODate } from '../domain/dates';
import {
  CalendarAccessError,
  CalendarUnavailableError,
  type CalendarAuthStatus,
  type CalendarBridge,
  type EventInput,
  type NativeCalendar,
  type NativeEvent,
} from './bridge';

export class MockCalendarBridge implements CalendarBridge {
  readonly native = true;
  authStatus: CalendarAuthStatus = 'notDetermined';
  /** What the system permission prompt resolves to when requested. */
  promptResult: CalendarAuthStatus = 'fullAccess';
  calendars: NativeCalendar[] = [
    { id: 'cal-icloud', title: 'Personale', sourceTitle: 'iCloud', color: '#000000', allowsModifications: true, isSubscribed: false },
    { id: 'cal-family', title: 'Famiglia', sourceTitle: 'iCloud', color: '#8A8A83', allowsModifications: false, isSubscribed: false },
    { id: 'cal-holidays', title: 'Festività in Italia', sourceTitle: 'Abbonamento', color: '#93306E', allowsModifications: false, isSubscribed: true },
  ];
  events = new Map<string, NativeEvent>();
  private listeners = new Set<() => void>();
  private seq = 0;
  private clock = 0;
  calls: string[] = [];
  promptCount = 0;

  private stamp(): string {
    return new Date(Date.UTC(2026, 10, 20, 12, 0, this.clock++)).toISOString();
  }
  private requireAccess() {
    if (this.authStatus !== 'fullAccess') throw new CalendarAccessError();
  }

  async status() {
    return this.authStatus;
  }
  async requestFullAccess() {
    this.promptCount += 1;
    if (this.authStatus === 'notDetermined') this.authStatus = this.promptResult; // the system prompts only once
    return this.authStatus;
  }
  async listCalendars() {
    this.requireAccess();
    return this.calendars.map((c) => ({ ...c }));
  }
  async ensureManagedCalendar(name: string, knownId: string | null) {
    this.requireAccess();
    const byId = knownId ? this.calendars.find((c) => c.id === knownId) : undefined;
    if (byId) return { ...byId };
    // Reuse an app-created calendar with the same name rather than creating duplicates ("Procedo", "Procedo (2)").
    const byName = this.calendars.find((c) => c.title === name && c.allowsModifications && c.sourceTitle === 'iCloud' && c.id.startsWith('cal-managed'));
    if (byName) return { ...byName };
    const cal: NativeCalendar = { id: `cal-managed-${++this.seq}`, title: name, sourceTitle: 'iCloud', color: '#1F35C7', allowsModifications: true, isSubscribed: false };
    this.calendars.push(cal);
    this.calls.push(`createCalendar:${name}`);
    return { ...cal };
  }
  async fetchEvents(calendarIds: string[], from: ISODate, to: ISODate) {
    this.requireAccess();
    return [...this.events.values()]
      .filter((e) => calendarIds.includes(e.calendarId) && e.start.slice(0, 10) <= to && e.end.slice(0, 10) >= from)
      .map((e) => ({ ...e }));
  }
  async getEvent(id: string) {
    this.requireAccess();
    const e = this.events.get(id);
    return e ? { ...e } : null;
  }
  async createEvent(input: EventInput) {
    this.requireAccess();
    const cal = this.calendars.find((c) => c.id === input.calendarId);
    if (!cal || !cal.allowsModifications) throw new Error('Calendario non modificabile');
    const id = `ek-${++this.seq}`;
    const e: NativeEvent = {
      ekEventId: id,
      externalId: `ext-${id}`,
      calendarId: input.calendarId,
      title: input.title,
      notes: input.notes,
      location: input.location ?? '',
      start: input.start,
      end: input.end,
      allDay: input.allDay,
      url: input.url,
      lastModified: this.stamp(),
    };
    this.events.set(id, e);
    this.calls.push(`create:${id}`);
    return { ...e };
  }
  async updateEvent(id: string, changes: Partial<EventInput>) {
    this.requireAccess();
    const cur = this.events.get(id);
    if (!cur) throw new Error('Evento non trovato');
    const next: NativeEvent = { ...cur, lastModified: this.stamp() };
    if (changes.title !== undefined) next.title = changes.title;
    if (changes.notes !== undefined) next.notes = changes.notes;
    if (changes.start !== undefined) next.start = changes.start;
    if (changes.end !== undefined) next.end = changes.end;
    if (changes.allDay !== undefined) next.allDay = changes.allDay;
    if (changes.calendarId !== undefined) next.calendarId = changes.calendarId;
    if (changes.url !== undefined) next.url = changes.url;
    this.events.set(id, next);
    this.calls.push(`update:${id}`);
    return { ...next };
  }
  async deleteEvent(id: string) {
    this.requireAccess();
    this.events.delete(id);
    this.calls.push(`delete:${id}`);
  }
  onStoreChanged(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async openSystemSettings() {
    this.calls.push('openSettings');
  }

  // ----------------------------------------------------------------------- test helpers
  emitChange() {
    this.listeners.forEach((l) => l());
  }
  grant() {
    this.authStatus = 'fullAccess';
  }
  revoke() {
    this.authStatus = 'denied';
  }
  eventsWithUrlPrefix(prefix: string): NativeEvent[] {
    return [...this.events.values()].filter((e) => e.url?.startsWith(prefix));
  }
  /** The user drags an event to another time in the Calendar app. */
  userMoves(id: string, start: string, end: string) {
    const e = this.events.get(id)!;
    this.events.set(id, { ...e, start, end, lastModified: this.stamp() });
    this.emitChange();
  }
  userRenames(id: string, title: string) {
    const e = this.events.get(id)!;
    this.events.set(id, { ...e, title, lastModified: this.stamp() });
    this.emitChange();
  }
  userDeletes(id: string) {
    this.events.delete(id);
    this.emitChange();
  }
  /** EventKit sometimes re-issues eventIdentifier after a sync; url and externalId survive. */
  changeIdentifier(id: string): string {
    const e = this.events.get(id)!;
    this.events.delete(id);
    const newId = `ek-${++this.seq}`;
    this.events.set(newId, { ...e, ekEventId: newId });
    return newId;
  }
  userMovesToCalendar(id: string, calendarId: string) {
    const e = this.events.get(id)!;
    this.events.set(id, { ...e, calendarId, lastModified: this.stamp() });
  }
  addThirdParty(calendarId: string, p: { title: string; start: string; end: string; allDay?: boolean }): NativeEvent {
    const id = `ek-${++this.seq}`;
    const e: NativeEvent = { ekEventId: id, externalId: `ext-${id}`, calendarId, title: p.title, notes: '', location: '', start: p.start, end: p.end, allDay: p.allDay ?? false, url: null, lastModified: this.stamp() };
    this.events.set(id, e);
    return e;
  }
  shiftAll(days: number) {
    for (const [id, e] of this.events) this.events.set(id, { ...e, start: `${addDays(e.start.slice(0, 10), days)}${e.start.slice(10)}`, end: `${addDays(e.end.slice(0, 10), days)}${e.end.slice(10)}` });
  }
}

export { CalendarAccessError, CalendarUnavailableError };
