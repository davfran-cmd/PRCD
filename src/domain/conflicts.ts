import type { LocalDateTime } from './dates';

export interface TimedItem {
  id: string;
  kind: 'lesson' | 'event' | 'exam' | 'external';
  title: string;
  start: LocalDateTime;
  end: LocalDateTime;
  allDay?: boolean;
  /** Deadlines mark a moment, not a span: they never conflict. */
  pointInTime?: boolean;
}

export interface Conflict {
  a: TimedItem;
  b: TimedItem;
}

/** Two items conflict when their time spans overlap (touching ends are fine). */
export function overlaps(a: Pick<TimedItem, 'start' | 'end'>, b: Pick<TimedItem, 'start' | 'end'>): boolean {
  return a.start < b.end && b.start < a.end;
}

export function findConflicts(items: TimedItem[]): Conflict[] {
  const spans = items.filter((i) => !i.allDay && !i.pointInTime).sort((x, y) => x.start.localeCompare(y.start));
  const out: Conflict[] = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[j].start >= spans[i].end) break; // sorted by start: nothing later can overlap `i`
      if (overlaps(spans[i], spans[j])) out.push({ a: spans[i], b: spans[j] });
    }
  }
  return out;
}

/** Ids of every item involved in at least one conflict. */
export function conflictingIds(items: TimedItem[]): Set<string> {
  const ids = new Set<string>();
  for (const c of findConflicts(items)) {
    ids.add(c.a.id);
    ids.add(c.b.id);
  }
  return ids;
}
