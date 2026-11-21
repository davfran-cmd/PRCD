/**
 * Database migrations. `PRAGMA user_version` stores the applied version.
 * Rules: migrations are append-only, each runs in its own transaction, and a pre-migration
 * snapshot of the previous database is taken by the caller before the first pending one runs.
 */
export interface Migration {
  version: number;
  name: string;
  up: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: [
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

      `CREATE TABLE semesters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (end_date >= start_date)
      )`,

      `CREATE TABLE courses (
        id TEXT PRIMARY KEY,
        semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        cfu INTEGER NOT NULL DEFAULT 0 CHECK (cfu >= 0),
        exam_kind TEXT NOT NULL DEFAULT 'graded' CHECK (exam_kind IN ('graded','eligibility')),
        archived INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_courses_semester ON courses(semester_id)`,

      `CREATE TABLE timetable_rules (
        id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_rules_course ON timetable_rules(course_id)`,
      `CREATE INDEX idx_rules_slot ON timetable_rules(slot_id)`,

      `CREATE TABLE lessons (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        rule_id TEXT REFERENCES timetable_rules(id) ON DELETE SET NULL,
        original_date TEXT,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular','extra')),
        cancelled INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT CHECK (cancel_reason IN ('cancelled','holiday')),
        is_exception INTEGER NOT NULL DEFAULT 0,
        topic TEXT NOT NULL DEFAULT '',
        attendance TEXT NOT NULL DEFAULT 'to_confirm' CHECK (attendance IN ('attended','absent','to_confirm','recovered')),
        attendance_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // One occurrence per (rule, slot date): makes generation idempotent.
      `CREATE UNIQUE INDEX uq_lessons_slot ON lessons(rule_id, original_date) WHERE rule_id IS NOT NULL AND original_date IS NOT NULL`,
      `CREATE INDEX idx_lessons_course_date ON lessons(course_id, date)`,
      `CREATE INDEX idx_lessons_date ON lessons(date)`,

      `CREATE TABLE semester_closures (
        id TEXT PRIMARY KEY,
        semester_id TEXT REFERENCES semesters(id) ON DELETE CASCADE,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT ''
      )`,

      `CREATE TABLE exam_attempts (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        date TEXT,
        time TEXT,
        component TEXT NOT NULL DEFAULT 'written',
        is_midterm INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL CHECK (outcome IN ('planned','passed','failed','rejected','withdrawn')),
        grade INTEGER CHECK (grade IS NULL OR grade BETWEEN 0 AND 30),
        lode INTEGER NOT NULL DEFAULT 0,
        eligible INTEGER NOT NULL DEFAULT 0,
        booked INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_attempts_course ON exam_attempts(course_id)`,

      `CREATE TABLE study_topics (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        position INTEGER NOT NULL DEFAULT 0
      )`,

      `CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('event','deadline','appointment','study')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        recurrence TEXT,
        reminder_minutes INTEGER,
        color TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        apple_calendar_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (ends_at >= starts_at)
      )`,
      `CREATE INDEX idx_events_start ON calendar_events(starts_at)`,

      `CREATE TABLE event_exceptions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
        original_date TEXT NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0,
        starts_at TEXT,
        ends_at TEXT,
        title TEXT,
        UNIQUE (event_id, original_date)
      )`,

      `CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_folders_parent ON folders(parent_id)`,

      `CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        file_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('markdown','pdf','image','other')),
        mime TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        storage_key TEXT NOT NULL UNIQUE,
        course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        page_count INTEGER,
        editable INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        last_opened_at TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_documents_folder ON documents(folder_id)`,
      `CREATE INDEX idx_documents_course ON documents(course_id)`,
      `CREATE INDEX idx_documents_opened ON documents(last_opened_at)`,

      // Plain-text index of Markdown notes (the SQLite build in the WebView has no FTS5).
      `CREATE TABLE document_text (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL
      )`,

      `CREATE TABLE pdf_state (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        last_page INTEGER NOT NULL DEFAULT 1,
        zoom REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,

      `CREATE TABLE pdf_bookmarks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )`,

      // ---- Apple Calendar (EventKit) integration -------------------------------------------
      `CREATE TABLE apple_calendars (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_title TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#000000',
        allows_modifications INTEGER NOT NULL DEFAULT 0,
        visible INTEGER NOT NULL DEFAULT 0,
        is_managed INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL
      )`,

      // Local item <-> EventKit mapping. EventKit identifiers are not trusted to be permanent:
      // `ek_external_id` (calendarItemExternalIdentifier) + fingerprints drive reconciliation.
      `CREATE TABLE sync_map (
        local_kind TEXT NOT NULL CHECK (local_kind IN ('event','lesson','exam')),
        local_id TEXT NOT NULL,
        ek_event_id TEXT,
        ek_external_id TEXT,
        calendar_id TEXT,
        last_synced_at TEXT,
        local_fingerprint TEXT,
        remote_fingerprint TEXT,
        remote_last_modified TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','conflict','error','remote_deleted')),
        error TEXT,
        PRIMARY KEY (local_kind, local_id)
      )`,
      `CREATE INDEX idx_sync_ek ON sync_map(ek_event_id)`,

      // Read-only cache of third-party events (so they show up offline / after revocation is noticed).
      `CREATE TABLE external_events (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        ek_event_id TEXT NOT NULL,
        ek_external_id TEXT,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT NOT NULL DEFAULT '',
        last_modified TEXT,
        fetched_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_external_start ON external_events(starts_at)`,
    ],
  },
  {
    version: 2,
    name: 'lessons without a known time (imported from Procedo)',
    up: [
      // Procedo recorded the day of a lesson but not its time: such lessons are shown as all-day items
      // until the user sets a time (any edit of date/time clears the flag).
      `ALTER TABLE lessons ADD COLUMN time_unknown INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE import_map (
        source TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        local_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (source, source_kind, source_id)
      )`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
