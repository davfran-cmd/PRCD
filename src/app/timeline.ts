/**
 * Unified calendar timeline: university lessons, personal events (recurrence expanded), exams and
 * read-only Apple Calendar events — kept as distinct kinds, merged only for display.
 */
import type { Repo } from '../db/repo';
import { addDays, splitLocalDateTime, type ISODate, type LocalDateTime } from '../domain/dates';
import { expandEvent } from '../domain/recurrence';
import { conflictingIds } from '../domain/conflicts';
import { lessonEnd, lessonStart } from '../domain/timetable';
import type { AttendanceStatus, EventCategory, Settings } from '../domain/types';
import { selectAll } from '../db/rows';

export type TimelineKind = 'lesson' | 'event' | 'exam' | 'external';

export interface TimelineItem {
  key: string;
  kind: TimelineKind;
  date: ISODate;
  start: LocalDateTime;
  end: LocalDateTime;
  allDay: boolean;
  title: string;
  subtitle: string;
  color: string;
  courseId: string | null;
  category?: EventCategory;
  lessonId?: string;
  eventId?: string;
  attemptId?: string;
  originalDate?: ISODate;
  cancelled?: boolean;
  moved?: boolean;
  completed?: boolean;
  readOnly?: boolean;
  conflict?: boolean;
  attendance?: AttendanceStatus;
  calendarName?: string;
  recurring?: boolean;
  pointInTime?: boolean;
}

export interface ExternalEventRow {
  id: string;
  calendarId: string;
  title: string;
  start: LocalDateTime;
  end: LocalDateTime;
  allDay: boolean;
  location: string;
  ekEventId: string;
}

export const STUDY_COLOR = '#1F35C7';
export const DEADLINE_COLOR = '#C2410C';

export function buildTimeline(repo: Repo, from: ISODate, to: ISODate, settings: Settings = repo.getSettings()): TimelineItem[] {
  const items: TimelineItem[] = [];
  const courses = new Map(repo.courses({ includeArchived: true, includeHidden: true }).map((c) => [c.id, c]));

  if (settings.showLessons) {
    for (const l of repo.lessonsInRange(from, to)) {
      const c = courses.get(l.courseId);
      if (!c) continue;
      items.push({
        key: `lesson:${l.id}`,
        kind: 'lesson',
        date: l.date,
        start: lessonStart(l),
        end: lessonEnd(l),
        allDay: l.timeUnknown, // imported without a time: shown as an all-day item
        title: c.name,
        subtitle: l.topic,
        color: c.color,
        courseId: c.id,
        lessonId: l.id,
        cancelled: l.cancelled,
        moved: l.isException && !l.cancelled,
        attendance: l.attendance,
        originalDate: l.originalDate ?? undefined,
      });
    }
  }

  const exceptions = repo.eventExceptions();
  for (const e of repo.eventsMaybeIn(from, to)) {
    if (!settings.visibleCategories.includes(e.category)) continue;
    for (const o of expandEvent(e, exceptions, from, to)) {
      const course = e.courseId ? courses.get(e.courseId) : undefined;
      const color = e.color ?? (e.category === 'study' ? STUDY_COLOR : e.category === 'deadline' ? DEADLINE_COLOR : course?.color ?? '#000000');
      items.push({
        key: `event:${e.id}:${o.originalDate}`,
        kind: 'event',
        date: splitLocalDateTime(o.start).date,
        start: o.start,
        end: o.end,
        allDay: e.allDay,
        title: o.title,
        subtitle: course?.name ?? '',
        color,
        courseId: e.courseId,
        category: e.category,
        eventId: e.id,
        originalDate: o.originalDate,
        completed: e.completed,
        recurring: o.isRecurring,
        pointInTime: e.category === 'deadline',
      });
    }
  }

  for (const a of repo.attempts()) {
    if (!a.date || a.outcome !== 'planned' || a.date < from || a.date > to) continue;
    const c = courses.get(a.courseId);
    if (!c) continue;
    const time = a.time ?? '09:00';
    items.push({
      key: `exam:${a.id}`,
      kind: 'exam',
      date: a.date,
      start: `${a.date}T${time}`,
      end: `${a.date}T${time}`,
      allDay: !a.time,
      title: `${a.isMidterm ? (a.label || 'Prova in itinere') : 'Esame'}: ${c.name}`,
      subtitle: a.booked ? 'prenotato' : 'da prenotare',
      color: DEADLINE_COLOR,
      courseId: c.id,
      attemptId: a.id,
      pointInTime: true,
    });
  }

  if (settings.appleCalendarEnabled && settings.appleVisibleCalendarIds.length) {
    const cals = new Map(selectAll<{ id: string; title: string }>(repo.db, 'SELECT id, title FROM apple_calendars').map((c) => [c.id, c.title]));
    const managed = new Set(repo.db.all<{ ek_event_id: string }>('SELECT ek_event_id FROM sync_map WHERE ek_event_id IS NOT NULL').map((r) => r.ek_event_id));
    const rows = selectAll<ExternalEventRow>(
      repo.db,
      'SELECT id, calendar_id, ek_event_id, title, starts_at, ends_at, all_day, location FROM external_events WHERE substr(starts_at,1,10) <= ? AND substr(ends_at,1,10) >= ?',
      [to, from],
      { bool: ['allDay'] },
    );
    for (const r of rows) {
      if (!settings.appleVisibleCalendarIds.includes(r.calendarId)) continue;
      // Events that PRCD itself pushed to Apple Calendar are already shown as local items.
      if (managed.has(r.ekEventId)) continue;
      items.push({
        key: `external:${r.id}`,
        kind: 'external',
        date: splitLocalDateTime(r.start).date,
        start: r.start,
        end: r.end,
        allDay: r.allDay,
        title: r.title,
        subtitle: cals.get(r.calendarId) ?? 'Apple Calendario',
        color: '#8A8A83',
        courseId: null,
        readOnly: true,
        calendarName: cals.get(r.calendarId) ?? '',
      });
    }
  }

  const ids = conflictingIds(
    items
      .filter((i) => !i.cancelled && (i.kind === 'lesson' || i.kind === 'event' || i.kind === 'external'))
      .map((i) => ({ id: i.key, kind: i.kind === 'event' ? ('event' as const) : i.kind === 'lesson' ? ('lesson' as const) : ('external' as const), title: i.title, start: i.start, end: i.end, allDay: i.allDay, pointInTime: i.pointInTime })),
  );
  for (const i of items) if (ids.has(i.key)) i.conflict = true;

  // Same start: alphabetical, except lessons without a time (imported from Procedo), which the user
  // wants in the reverse order, as Procedo showed them.
  return items.sort((a, b) => a.start.localeCompare(b.start) || (a.kind === 'lesson' && b.kind === 'lesson' && a.allDay && b.allDay ? b.title.localeCompare(a.title) : a.title.localeCompare(b.title)));
}

export function itemsOnDay(items: TimelineItem[], date: ISODate): TimelineItem[] {
  return items.filter((i) => i.start.slice(0, 10) <= date && i.end.slice(0, 10) >= date);
}

export function rangeAround(date: ISODate, before: number, after: number): [ISODate, ISODate] {
  return [addDays(date, -before), addDays(date, after)];
}
