# Schema del database

Fonte di verità: [`src/db/migrations.ts`](../src/db/migrations.ts) (versione corrente: **3**, in `PRAGMA user_version`; la v2 aggiunge `lessons.time_unknown` e `import_map`, la v3 `timetable_rules.time_unknown`). SQLite (sql.js) con `PRAGMA foreign_keys = ON`. Date e orari sono stringhe *floating* (`YYYY-MM-DD`, `HH:MM`, `YYYY-MM-DDTHH:MM`); gli istanti (`created_at`…) sono ISO 8601 UTC. I booleani sono `INTEGER 0/1`. Gli id sono UUID v4 (`TEXT`).

> `start` e `end` sono parole riservate di SQL: le colonne si chiamano `starts_at` / `ends_at` (il codice le espone come `start` / `end`).

## Università

| Tabella | Scopo | Colonne principali |
|---|---|---|
| `semesters` | Periodo accademico | `name`, `start_date`, `end_date` (`CHECK end ≥ start`), `archived` |
| `courses` | Corso di un semestre | `semester_id` → semesters (RESTRICT), `name`, `color`, `cfu` (≥0), `exam_kind` (`graded`/`eligibility`), `archived`, `hidden` |
| `timetable_rules` | Slot settimanale ricorrente | `slot_id` (lineage degli split), `course_id` (CASCADE), `weekday` 1–7, `start_time`, `end_time`, `valid_from`, `valid_to` |
| `lessons` | **Occorrenza** di lezione con id permanente | `course_id` (CASCADE), `rule_id` (SET NULL), `original_date` (data dello slot), `date`/`start_time`/`end_time` (valori reali), `kind` (`regular`/`extra`), `cancelled` + `cancel_reason` (`cancelled`/`holiday`), `is_exception`, `time_unknown` (giorno noto, orario no: lezioni importate da Procedo), `topic`, `attendance` (`attended`/`absent`/`to_confirm`/`recovered`), `attendance_at`, `note` |
| `semester_closures` | Festività/sospensioni | `semester_id` (NULL = tutti), `start_date`, `end_date`, `label` |
| `exam_attempts` | Tentativi d'esame e prove in itinere | `course_id` (CASCADE), `date`, `time`, `component`, `is_midterm`, `outcome` (`planned`/`passed`/`failed`/`rejected`/`withdrawn`), `grade` (0–30), `lode`, `eligible`, `booked`, `label`, `note` |
| `study_topics` | Argomenti di studio segnati dall'utente | `course_id` (CASCADE), `title`, `progress` 0–100, `position` |

Indici notevoli: **`uq_lessons_slot`** = `UNIQUE(rule_id, original_date) WHERE rule_id IS NOT NULL AND original_date IS NOT NULL` — rende idempotente la generazione delle lezioni; `idx_lessons_course_date`, `idx_lessons_date`, `idx_rules_slot`, `idx_attempts_course`.

Note di modello:

- Una regola sostituita non si cancella: si chiude con `valid_to` (le regole con validità vuota e senza lezioni vengono ripulite come semplice manutenzione).
- Eliminare un corso rimuove lezioni, regole e argomenti; se ha tentativi d'esame il corso resta con `hidden = 1` così il libretto non perde storia.
- Una lezione spostata ha `date/start_time/end_time` diversi da quelli dello slot e `is_exception = 1`; `original_date` ricorda lo slot d'origine.

## Calendario personale

| Tabella | Scopo | Colonne principali |
|---|---|---|
| `calendar_events` | Evento/scadenza/appuntamento/sessione di studio (master) | `category`, `title`, `description`, `course_id` (SET NULL), `all_day`, `starts_at`, `ends_at` (`CHECK ends ≥ starts`), `recurrence` (JSON: `freq`, `interval`, `byWeekday`, `until`, `count`), `reminder_minutes`, `color`, `completed`, `apple_calendar_id` (NULL = solo locale, `'managed'` = calendario Procedo, o id EventKit) |
| `event_exceptions` | Annullamento/override di una singola occorrenza | `event_id` (CASCADE), `original_date`, `cancelled`, `starts_at`, `ends_at`, `title`; `UNIQUE(event_id, original_date)` |

Le lezioni **non** sono eventi ricorrenti: sono righe di `lessons` (vedi sopra).

## Apple Calendar

| Tabella | Scopo | Colonne principali |
|---|---|---|
| `apple_calendars` | Calendari EventKit noti | `id` (calendarIdentifier), `title`, `source_title`, `color`, `allows_modifications`, `visible`, `is_managed`, `last_seen_at` |
| `sync_map` | Legame elemento locale ↔ evento EventKit | PK `(local_kind, local_id)` con `local_kind` ∈ `event`/`lesson`/`exam`; `local_id` = uuid lezione, uuid evento o `uuid@data` per un'occorrenza ricorrente; `ek_event_id`, `ek_external_id`, `calendar_id`, `last_synced_at`, `local_fingerprint` e `remote_fingerprint` (baseline JSON dell'ultima sincronizzazione), `remote_last_modified`, `status` (`pending`/`synced`/`conflict`/`error`/`remote_deleted`), `error` |
| `external_events` | Cache **sola lettura** degli eventi di terzi dai calendari visibili | `id` = `calendarId::ekEventId`, `calendar_id`, `ek_event_id`, `title`, `starts_at`, `ends_at`, `all_day`, `location`, `last_modified`, `fetched_at` |

## Documenti

| Tabella | Scopo | Colonne principali |
|---|---|---|
| `folders` | Gerarchia | `parent_id` (CASCADE), `name`, `course_id` (SET NULL) |
| `documents` | Metadati; i byte stanno nel FileStore | `folder_id` (SET NULL), `name`, `file_name`, `kind` (`markdown`/`pdf`/`image`/`other`), `mime`, `size`, `storage_key` (UNIQUE, `f/<uuid>`), `course_id`, `favorite`, `tags` (JSON), `page_count`, `editable` (solo note create in PRCD), `added_at`, `last_opened_at`, `updated_at` |
| `document_text` | Testo delle note per la ricerca (sql.js non ha FTS5: `LIKE`) | `document_id` (CASCADE), `content` |
| `pdf_state` | Ultima posizione di lettura | `document_id`, `last_page`, `zoom` (0 = adatta larghezza) |
| `pdf_bookmarks` | Segnalibri | `document_id`, `page`, `label` |

## Varie

| Tabella | Scopo |
|---|---|
| `import_map` | Id della fonte importata → id locale (`source`, `source_kind`, `source_id`, `local_id`, `imported_at`): rende l'import da Procedo ripetibile senza doppioni |
| `settings` | Chiave/valore JSON (impostazioni dell'app: soglia presenze, valore della lode, scala di laurea, calendario visibile, stato dell'integrazione Apple…) |
| `meta` | Riservata a metadati interni |

## Migrazioni

1. Aggiungere un oggetto `{ version, name, up: [...] }` in fondo a `MIGRATIONS` (mai modificare quelle esistenti dopo il rilascio).
2. Ogni migrazione gira in una transazione; se fallisce si fa rollback e il database resta alla versione precedente.
3. Prima di migrare un database esistente si salva lo snapshot `pre-migration-v<N>`.
4. Test: `tests/db.test.ts` (migrazione avanti, rollback su errore, rifiuto di versioni future).
