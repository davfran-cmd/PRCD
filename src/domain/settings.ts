import type { Settings } from './types';

export const APP_NAME = 'PRCD.';
/** Name of the Apple Calendar that PRCD creates and manages. */
export const APPLE_MANAGED_CALENDAR_NAME = 'Procedo';

export const DEFAULT_SETTINGS: Settings = {
  attendanceThreshold: 80,
  recoveredCountsAsAttended: false,
  excludeToConfirm: true,
  excludeCancelled: true,
  lodeValue: 30,
  graduationScale: 110,
  weekStartsOnMonday: true,
  calendarView: 'week',
  visibleCategories: ['event', 'deadline', 'appointment', 'study'],
  showLessons: true,
  appleCalendarEnabled: false,
  appleManagedCalendarName: APPLE_MANAGED_CALENDAR_NAME,
  appleManagedCalendarId: null,
  appleDefaultCalendarId: null,
  appleVisibleCalendarIds: [],
  appleSyncLessons: false,
  appleLastSyncAt: null,
  endOfLessonReminder: true,
  lastBackupAt: null,
  currentSemesterId: null,
};

/** Course palette from the design system: every colour carries white text at >= 4.5:1. */
export const COURSE_COLORS: Array<{ name: string; hex: string }> = [
  { name: 'Viola', hex: '#6A4FB3' },
  { name: 'Petrolio', hex: '#1F7A8C' },
  { name: 'Muschio', hex: '#3F7D3A' },
  { name: 'Ocra', hex: '#B7791F' },
  { name: 'Prugna', hex: '#93306E' },
  { name: 'Grafite', hex: '#4A4A44' },
];

export const CATEGORY_LABELS = {
  event: 'Evento',
  deadline: 'Scadenza',
  appointment: 'Appuntamento',
  study: 'Sessione di studio',
} as const;
