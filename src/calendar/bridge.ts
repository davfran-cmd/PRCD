/**
 * Boundary between PRCD and Apple Calendar (EventKit).
 *
 * The web build has no access to system calendars, so everything above this interface (sync engine,
 * conflict handling, UI) is written against `CalendarBridge` and tested against a faithful in-memory
 * mock (`MockCalendarBridge`). The real implementation is the Swift plugin `PRCDCalendar`
 * (ios-plugin/Sources/PRCDCalendarPlugin) reached through Capacitor.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ISODate, LocalDateTime } from '../domain/dates';

export type CalendarAuthStatus =
  | 'notDetermined' // never asked
  | 'denied'
  | 'restricted' // e.g. parental controls
  | 'writeOnly' // iOS 17 "add events only" — not enough to read or sync
  | 'fullAccess'
  | 'unavailable'; // platform without EventKit (web)

export interface NativeCalendar {
  id: string; // EKCalendar.calendarIdentifier
  title: string;
  sourceTitle: string; // "iCloud", "Sul mio iPad", an Exchange account…
  color: string; // #RRGGBB
  allowsModifications: boolean;
  isSubscribed: boolean;
}

export interface NativeEvent {
  /** EKEvent.eventIdentifier — NOT guaranteed to be permanent (it can change on sync). */
  ekEventId: string;
  /** EKEvent.calendarItemExternalIdentifier — more stable across devices, still not guaranteed. */
  externalId: string | null;
  calendarId: string;
  title: string;
  notes: string;
  location: string;
  /** Floating wall-clock times, like PRCD's own model. */
  start: LocalDateTime;
  end: LocalDateTime;
  allDay: boolean;
  /** EKEvent.url — PRCD stamps `prcd://<kind>/<id>` here so events can be re-identified after an id change. */
  url: string | null;
  lastModified: string | null; // ISO instant
}

export interface EventInput {
  calendarId: string;
  title: string;
  notes: string;
  location?: string;
  start: LocalDateTime;
  end: LocalDateTime;
  allDay: boolean;
  url: string;
  alarmMinutesBefore: number | null;
}

export interface CalendarBridge {
  readonly native: boolean;
  status(): Promise<CalendarAuthStatus>;
  /** Triggers the system permission prompt (EKEventStore.requestFullAccessToEvents). Only call from a user action. */
  requestFullAccess(): Promise<CalendarAuthStatus>;
  listCalendars(): Promise<NativeCalendar[]>;
  /** Find or create the app-managed calendar (default name "Procedo"). Never touches other calendars. */
  ensureManagedCalendar(name: string, knownId: string | null): Promise<NativeCalendar>;
  fetchEvents(calendarIds: string[], from: ISODate, to: ISODate): Promise<NativeEvent[]>;
  getEvent(ekEventId: string): Promise<NativeEvent | null>;
  createEvent(input: EventInput): Promise<NativeEvent>;
  updateEvent(ekEventId: string, input: Partial<EventInput>): Promise<NativeEvent>;
  deleteEvent(ekEventId: string): Promise<void>;
  /** EKEventStoreChangedNotification. Returns an unsubscribe function. */
  onStoreChanged(cb: () => void): () => void;
  openSystemSettings(): Promise<void>;
}

export class CalendarAccessError extends Error {
  constructor(message = 'Accesso a Calendario non autorizzato.') {
    super(message);
  }
}

export class CalendarUnavailableError extends Error {
  constructor(message = 'Calendario di Apple non è disponibile su questa piattaforma.') {
    super(message);
  }
}

/** Used on the web: reports "unavailable" and refuses every operation. */
export class UnavailableBridge implements CalendarBridge {
  readonly native = false;
  async status(): Promise<CalendarAuthStatus> {
    return 'unavailable';
  }
  async requestFullAccess(): Promise<CalendarAuthStatus> {
    return 'unavailable';
  }
  private no(): never {
    throw new CalendarUnavailableError();
  }
  async listCalendars(): Promise<NativeCalendar[]> {
    return this.no();
  }
  async ensureManagedCalendar(): Promise<NativeCalendar> {
    return this.no();
  }
  async fetchEvents(): Promise<NativeEvent[]> {
    return this.no();
  }
  async getEvent(): Promise<NativeEvent | null> {
    return this.no();
  }
  async createEvent(): Promise<NativeEvent> {
    return this.no();
  }
  async updateEvent(): Promise<NativeEvent> {
    return this.no();
  }
  async deleteEvent(): Promise<void> {
    return this.no();
  }
  onStoreChanged(): () => void {
    return () => {};
  }
  async openSystemSettings(): Promise<void> {}
}

// ----------------------------------------------------------------------------- Capacitor (iOS)

interface PRCDCalendarPlugin {
  status(): Promise<{ status: CalendarAuthStatus }>;
  requestFullAccess(): Promise<{ status: CalendarAuthStatus }>;
  listCalendars(): Promise<{ calendars: NativeCalendar[] }>;
  ensureManagedCalendar(o: { name: string; knownId: string | null }): Promise<NativeCalendar>;
  fetchEvents(o: { calendarIds: string[]; from: string; to: string }): Promise<{ events: NativeEvent[] }>;
  getEvent(o: { id: string }): Promise<{ event: NativeEvent | null }>;
  createEvent(o: EventInput): Promise<NativeEvent>;
  updateEvent(o: { id: string; changes: Partial<EventInput> }): Promise<NativeEvent>;
  deleteEvent(o: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
  addListener(name: 'storeChanged', cb: () => void): Promise<{ remove: () => Promise<void> }>;
}

export class CapacitorCalendarBridge implements CalendarBridge {
  readonly native = true;
  private plugin = registerPlugin<PRCDCalendarPlugin>('PRCDCalendar');

  async status() {
    return (await this.plugin.status()).status;
  }
  async requestFullAccess() {
    return (await this.plugin.requestFullAccess()).status;
  }
  async listCalendars() {
    return (await this.plugin.listCalendars()).calendars;
  }
  ensureManagedCalendar(name: string, knownId: string | null) {
    return this.plugin.ensureManagedCalendar({ name, knownId });
  }
  async fetchEvents(calendarIds: string[], from: ISODate, to: ISODate) {
    return (await this.plugin.fetchEvents({ calendarIds, from, to })).events;
  }
  async getEvent(id: string) {
    return (await this.plugin.getEvent({ id })).event;
  }
  createEvent(input: EventInput) {
    return this.plugin.createEvent(input);
  }
  updateEvent(id: string, changes: Partial<EventInput>) {
    return this.plugin.updateEvent({ id, changes });
  }
  deleteEvent(id: string) {
    return this.plugin.deleteEvent({ id });
  }
  onStoreChanged(cb: () => void): () => void {
    let handle: { remove: () => Promise<void> } | null = null;
    let removed = false;
    void this.plugin.addListener('storeChanged', cb).then((h) => {
      if (removed) void h.remove();
      else handle = h;
    });
    return () => {
      removed = true;
      if (handle) void handle.remove();
    };
  }
  openSystemSettings() {
    return this.plugin.openSettings();
  }
}

export function createBridge(): CalendarBridge {
  return Capacitor.isNativePlatform() ? new CapacitorCalendarBridge() : new UnavailableBridge();
}

export const URL_PREFIX = 'prcd://';
export const markerUrl = (kind: string, id: string) => `${URL_PREFIX}${kind}/${encodeURIComponent(id)}`;
export function parseMarker(url: string | null): { kind: string; id: string } | null {
  if (!url || !url.startsWith(URL_PREFIX)) return null;
  const [kind, ...rest] = url.slice(URL_PREFIX.length).split('/');
  if (!kind || !rest.length) return null;
  return { kind, id: decodeURIComponent(rest.join('/')) };
}
