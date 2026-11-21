import type { HM, ISODate, LocalDateTime } from './dates';

export type Id = string; // UUID v4

export interface Semester {
  id: Id;
  name: string; // "1° semestre 2026/27"
  startDate: ISODate;
  endDate: ISODate;
  archived: boolean;
  createdAt: string; // ISO instant
  updatedAt: string;
}

export interface Course {
  id: Id;
  semesterId: Id;
  name: string;
  color: string; // hex, one of the course palette (or custom)
  cfu: number;
  examKind: ExamKind; // graded (voto) or eligibility (idoneità)
  archived: boolean;
  /** Hidden courses only exist to keep their exam history in the libretto after the course was deleted. */
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ExamKind = 'graded' | 'eligibility';

/** A weekly slot. Superseded rules are end-dated (validTo), never deleted: the original pattern is preserved. */
export interface TimetableRule {
  id: Id;
  /** Rules created by splitting a pattern share the `slotId` of the original: they form one "slot lineage". */
  slotId: Id;
  courseId: Id;
  weekday: number; // ISO 1..7
  startTime: HM;
  endTime: HM;
  validFrom: ISODate;
  validTo: ISODate;
  /** Day-only slot (continuation of a Procedo course): its lessons are all-day items with no known time. */
  timeUnknown?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AttendanceStatus = 'attended' | 'absent' | 'to_confirm' | 'recovered';
export type LessonKind = 'regular' | 'extra';
export type CancelReason = 'cancelled' | 'holiday';

/**
 * One concrete occurrence of a lesson, with its own permanent id.
 * `ruleId` + `originalDate` identify the slot it came from; `date/startTime/endTime` are the
 * *actual* values (they differ from the slot after a move). Attendance hangs on `id`, never on the time.
 */
export interface Lesson {
  id: Id;
  courseId: Id;
  ruleId: Id | null; // null for extra lessons
  originalDate: ISODate | null;
  date: ISODate;
  startTime: HM;
  endTime: HM;
  kind: LessonKind;
  cancelled: boolean;
  cancelReason: CancelReason | null;
  /** True once the user moved/edited this single occurrence away from its rule. */
  isException: boolean;
  /** Day known, time not (lessons imported from Procedo). Shown as all-day until a time is set. */
  timeUnknown: boolean;
  topic: string; // optional free text ("Circuiti RL, extracorrente")
  attendance: AttendanceStatus;
  attendanceAt: string | null; // ISO instant of the last attendance change
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface SemesterClosure {
  id: Id;
  semesterId: Id | null; // null = applies to every semester
  startDate: ISODate;
  endDate: ISODate;
  label: string;
}

// ------------------------------------------------------------------ exams

export type AttemptOutcome = 'planned' | 'passed' | 'failed' | 'rejected' | 'withdrawn';
export type AttemptComponent = 'written' | 'oral' | 'written_oral' | 'project' | 'test' | 'other';

export interface ExamAttempt {
  id: Id;
  courseId: Id;
  date: ISODate | null; // null = "da fissare"
  time: HM | null;
  component: AttemptComponent;
  /** Mid-term (prova in itinere): never counts as an attempt nor in the averages. */
  isMidterm: boolean;
  outcome: AttemptOutcome;
  grade: number | null; // 18..30, null for eligibility / planned / withdrawn
  lode: boolean;
  /** Eligibility-only exams (idoneità) pass without a grade. */
  eligible: boolean;
  booked: boolean; // planned attempt already booked on the university portal
  label: string; // "1ª prova in itinere"
  note: string;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ personal calendar

export type EventCategory = 'event' | 'deadline' | 'appointment' | 'study';

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface Recurrence {
  freq: RecurrenceFreq;
  interval: number; // every N units (>=1)
  byWeekday?: number[]; // ISO weekdays, weekly only
  until?: ISODate | null;
  count?: number | null;
}

export interface CalendarEvent {
  id: Id; // stable internal UUID, also used as the Apple Calendar mapping key
  category: EventCategory;
  title: string;
  description: string;
  courseId: Id | null;
  allDay: boolean;
  start: LocalDateTime; // floating local time
  end: LocalDateTime;
  recurrence: Recurrence | null;
  reminderMinutes: number | null;
  color: string | null; // null = course color / category default
  completed: boolean; // deadlines only
  /** Destination in Apple Calendar: null = local only. */
  appleCalendarId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Single-occurrence override/cancellation of a recurring event. */
export interface EventException {
  id: Id;
  eventId: Id;
  originalDate: ISODate;
  cancelled: boolean;
  start: LocalDateTime | null;
  end: LocalDateTime | null;
  title: string | null;
}

// ------------------------------------------------------------------ documents

export type DocKind = 'markdown' | 'pdf' | 'image' | 'other';

export interface Folder {
  id: Id;
  parentId: Id | null;
  name: string;
  courseId: Id | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord {
  id: Id;
  folderId: Id | null;
  name: string; // display name (file name w/o forced extension)
  fileName: string; // original file name with extension
  kind: DocKind;
  mime: string;
  size: number;
  /** Key in the FileStore (never the original path). */
  storageKey: string;
  courseId: Id | null;
  favorite: boolean;
  tags: string[];
  pageCount: number | null;
  /** True only for notes created inside PRCD. Imported files are never edited. */
  editable: boolean;
  addedAt: string;
  lastOpenedAt: string | null;
  updatedAt: string;
}

export interface PdfState {
  documentId: Id;
  lastPage: number;
  zoom: number; // 0 = fit width
  updatedAt: string;
}

export interface PdfBookmark {
  id: Id;
  documentId: Id;
  page: number;
  label: string;
  createdAt: string;
}

export interface StudyTopic {
  id: Id;
  courseId: Id;
  title: string;
  progress: number; // 0..100
  position: number;
}

// ------------------------------------------------------------------ settings

export interface Settings {
  attendanceThreshold: number; // percent
  recoveredCountsAsAttended: boolean;
  excludeToConfirm: boolean;
  excludeCancelled: boolean;
  lodeValue: number; // 30 or 31
  graduationScale: number; // 110
  degreeCfuTarget: number; // 180 (triennale), 120 (magistrale)…
  weekStartsOnMonday: boolean;
  calendarView: 'day' | 'week' | 'month';
  visibleCategories: EventCategory[];
  showLessons: boolean;
  appleCalendarEnabled: boolean;
  appleManagedCalendarName: string;
  appleManagedCalendarId: string | null;
  appleDefaultCalendarId: string | null;
  appleVisibleCalendarIds: string[];
  appleSyncLessons: boolean;
  dismissedDuplicates: string[];
  appleLastSyncAt: string | null;
  endOfLessonReminder: boolean;
  lastBackupAt: string | null;
  currentSemesterId: Id | null;
}
