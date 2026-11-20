/**
 * Recurring personal events. Only the master event is stored; occurrences are expanded on demand
 * for a visible range. Single occurrences can be cancelled or overridden through `EventException`
 * rows (keyed on the occurrence's original date). University lessons never use this module: they
 * are materialised rows (see timetable.ts), not recurrence rules.
 */
import { addDays, daysInMonth, dayNumber, diffDays, eachDay, makeISODate, parseISODate, splitLocalDateTime, startOfWeek, toLocalDateTime, weekdayISO, type ISODate, type LocalDateTime } from './dates';
import type { CalendarEvent, EventException, Recurrence } from './types';

export interface EventOccurrence {
  eventId: string;
  /** Date of the occurrence in the *series* (stable key for exceptions). */
  originalDate: ISODate;
  start: LocalDateTime;
  end: LocalDateTime;
  title: string;
  isRecurring: boolean;
  isException: boolean;
  event: CalendarEvent;
}

const MAX_OCCURRENCES = 5000;

/** Dates (as start dates) of the series that fall within [from, to]. */
export function seriesDates(masterStartDate: ISODate, rec: Recurrence, from: ISODate, to: ISODate): ISODate[] {
  const interval = Math.max(1, Math.floor(rec.interval || 1));
  const out: ISODate[] = [];
  const until = rec.until ?? null;
  const limit = until && until < to ? until : to;
  let produced = 0;
  const count = rec.count ?? null;

  const push = (d: ISODate): boolean => {
    if (d < masterStartDate) return true;
    produced += 1;
    if (count !== null && produced > count) return false;
    if (d > limit) return false;
    if (d >= from) out.push(d);
    return out.length < MAX_OCCURRENCES;
  };

  switch (rec.freq) {
    case 'daily': {
      for (let d = masterStartDate; d <= limit; d = addDays(d, interval)) if (!push(d)) break;
      break;
    }
    case 'weekly': {
      const days = (rec.byWeekday && rec.byWeekday.length ? [...rec.byWeekday] : [weekdayISO(masterStartDate)]).sort((a, b) => a - b);
      const firstMonday = startOfWeek(masterStartDate);
      for (let monday = firstMonday; monday <= limit; monday = addDays(monday, 7 * interval)) {
        let stop = false;
        for (const wd of days) {
          const d = addDays(monday, wd - 1);
          if (d < masterStartDate) continue;
          if (!push(d)) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
      break;
    }
    case 'monthly': {
      const { y: y0, m: m0, d: dom } = parseISODate(masterStartDate);
      for (let i = 0; ; i += interval) {
        const total = y0 * 12 + (m0 - 1) + i;
        const y = Math.floor(total / 12);
        const m = (total % 12) + 1;
        if (makeISODate(y, m, 1) > limit) break;
        if (dom > daysInMonth(y, m)) continue; // e.g. the 31st: months without it are skipped, not shifted
        if (!push(makeISODate(y, m, dom))) break;
      }
      break;
    }
    case 'yearly': {
      const { y: y0, m, d } = parseISODate(masterStartDate);
      for (let i = 0; ; i += interval) {
        const y = y0 + i;
        if (makeISODate(y, m, 1) > limit) break;
        if (d > daysInMonth(y, m)) continue; // 29 Feb in a non-leap year
        if (!push(makeISODate(y, m, d))) break;
      }
      break;
    }
  }
  return out;
}

/** Expand an event into occurrences intersecting [from, to] (inclusive dates). */
export function expandEvent(event: CalendarEvent, exceptions: EventException[], from: ISODate, to: ISODate): EventOccurrence[] {
  const { date: startDate, time: startTime } = splitLocalDateTime(event.start);
  const { date: endDate, time: endTime } = splitLocalDateTime(event.end);
  const spanDays = diffDays(endDate, startDate);

  const make = (origin: ISODate, ex: EventException | undefined): EventOccurrence | null => {
    if (ex?.cancelled) return null;
    const start = ex?.start ?? toLocalDateTime(origin, startTime);
    const end = ex?.end ?? toLocalDateTime(addDays(origin, spanDays), endTime);
    return { eventId: event.id, originalDate: origin, start, end, title: ex?.title ?? event.title, isRecurring: Boolean(event.recurrence), isException: Boolean(ex), event };
  };
  const byDate = new Map(exceptions.filter((e) => e.eventId === event.id).map((e) => [e.originalDate, e]));
  const intersects = (o: EventOccurrence) => o.start.slice(0, 10) <= to && o.end.slice(0, 10) >= from;

  if (!event.recurrence) {
    const o = make(startDate, undefined);
    return o && intersects(o) ? [o] : [];
  }
  // Widen the window backwards by the event span so long events still show up.
  const origins = seriesDates(startDate, event.recurrence, addDays(from, -spanDays), to);
  const out: EventOccurrence[] = [];
  for (const origin of origins) {
    const o = make(origin, byDate.get(origin));
    if (o && intersects(o)) out.push(o);
  }
  return out;
}

export function describeRecurrence(rec: Recurrence | null): string {
  if (!rec) return 'Mai';
  const n = rec.interval > 1 ? `ogni ${rec.interval} ` : 'ogni ';
  switch (rec.freq) {
    case 'daily':
      return rec.interval > 1 ? `${n}giorni` : 'Ogni giorno';
    case 'weekly':
      return rec.interval > 1 ? `${n}settimane` : 'Ogni settimana';
    case 'monthly':
      return rec.interval > 1 ? `${n}mesi` : 'Ogni mese';
    case 'yearly':
      return rec.interval > 1 ? `${n}anni` : 'Ogni anno';
  }
}

/** Days of the month grid etc. live in the UI; this tiny helper keeps imports tidy. */
export function daysBetween(from: ISODate, to: ISODate): ISODate[] {
  return dayNumber(to) >= dayNumber(from) ? eachDay(from, to) : [];
}
