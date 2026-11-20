import { describe, expect, it } from 'vitest';
import { expandEvent, seriesDates } from '../src/domain/recurrence';
import { findConflicts, overlaps } from '../src/domain/conflicts';
import type { CalendarEvent } from '../src/domain/types';

const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e1', category: 'event', title: 'Evento', description: '', courseId: null, allDay: false, start: '2026-11-02T15:00', end: '2026-11-02T16:00',
  recurrence: null, reminderMinutes: null, color: null, completed: false, appleCalendarId: null, createdAt: '', updatedAt: '', ...p,
});

describe('recurring events', () => {
  it('expands weekly series within a range', () => {
    const e = ev({ recurrence: { freq: 'weekly', interval: 1 } });
    expect(expandEvent(e, [], '2026-11-01', '2026-11-30').map((o) => o.start)).toEqual([
      '2026-11-02T15:00', '2026-11-09T15:00', '2026-11-16T15:00', '2026-11-23T15:00', '2026-11-30T15:00',
    ]);
  });

  it('supports multiple weekdays, intervals, until and count', () => {
    expect(seriesDates('2026-11-02', { freq: 'weekly', interval: 1, byWeekday: [1, 3] }, '2026-11-01', '2026-11-15')).toEqual(['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']);
    expect(seriesDates('2026-11-02', { freq: 'weekly', interval: 2 }, '2026-11-01', '2026-12-31')).toEqual(['2026-11-02', '2026-11-16', '2026-11-30', '2026-12-14', '2026-12-28']);
    expect(seriesDates('2026-11-02', { freq: 'daily', interval: 1, until: '2026-11-05' }, '2026-11-01', '2026-12-31')).toHaveLength(4);
    expect(seriesDates('2026-11-02', { freq: 'daily', interval: 3, count: 3 }, '2026-11-01', '2026-12-31')).toEqual(['2026-11-02', '2026-11-05', '2026-11-08']);
  });

  it('skips months without the day instead of drifting (31st) and handles leap days', () => {
    expect(seriesDates('2026-01-31', { freq: 'monthly', interval: 1 }, '2026-01-01', '2026-06-30')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(seriesDates('2028-02-29', { freq: 'yearly', interval: 1 }, '2028-01-01', '2033-12-31')).toEqual(['2028-02-29', '2032-02-29']);
  });

  it('applies single-occurrence exceptions: cancel and move', () => {
    const e = ev({ recurrence: { freq: 'weekly', interval: 1 } });
    const occ = expandEvent(
      e,
      [
        { id: 'x1', eventId: 'e1', originalDate: '2026-11-09', cancelled: true, start: null, end: null, title: null },
        { id: 'x2', eventId: 'e1', originalDate: '2026-11-16', cancelled: false, start: '2026-11-17T10:00', end: '2026-11-17T11:00', title: 'Spostato' },
      ],
      '2026-11-01',
      '2026-11-30',
    );
    expect(occ.map((o) => o.start)).toEqual(['2026-11-02T15:00', '2026-11-17T10:00', '2026-11-23T15:00', '2026-11-30T15:00']);
    expect(occ[1]).toMatchObject({ title: 'Spostato', isException: true, originalDate: '2026-11-16' });
  });

  it('keeps multi-day events visible on every day they span', () => {
    const e = ev({ start: '2026-11-02T20:00', end: '2026-11-04T09:00' });
    expect(expandEvent(e, [], '2026-11-03', '2026-11-03')).toHaveLength(1);
    expect(expandEvent(e, [], '2026-11-05', '2026-11-06')).toHaveLength(0);
  });
});

describe('conflict detection', () => {
  const it1 = (id: string, start: string, end: string, extra = {}) => ({ id, kind: 'lesson' as const, title: id, start, end, ...extra });

  it('detects overlapping spans but not touching ends', () => {
    expect(overlaps(it1('a', '2026-11-18T10:30', '2026-11-18T12:15'), it1('b', '2026-11-18T10:00', '2026-11-18T12:00'))).toBe(true);
    expect(overlaps(it1('a', '2026-11-18T10:00', '2026-11-18T12:00'), it1('b', '2026-11-18T12:00', '2026-11-18T13:00'))).toBe(false);
  });

  it('finds conflicts between lessons and events; ignores all-day items and deadlines', () => {
    const items = [
      it1('ps', '2026-11-18T10:30', '2026-11-18T12:15'),
      it1('an2', '2026-11-18T10:00', '2026-11-18T12:00'),
      it1('dead', '2026-11-18T11:00', '2026-11-18T11:00', { pointInTime: true }),
      it1('allday', '2026-11-18T00:00', '2026-11-18T23:59', { allDay: true }),
      it1('later', '2026-11-18T14:00', '2026-11-18T15:00'),
    ];
    const c = findConflicts(items);
    expect(c).toHaveLength(1);
    expect([c[0].a.id, c[0].b.id].sort()).toEqual(['an2', 'ps']);
  });
});
