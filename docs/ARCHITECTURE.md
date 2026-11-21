# Architettura

## Decisione di fondo

Il frontend consegnato era un export di *design canvas* (artboard con dati hardcoded e runtime proprietario `x-dc`), non un'applicazione con un framework riusabile. Il runtime è basato su React, quindi il design è stato portato in **React 19 + TypeScript + Vite**, mantenendo CSS e markup del design (`src/styles/app.css`, helper `st()` per gli stili inline originali). Per l'iPad si usa **Capacitor** (progetto in `ios/`) con due plugin Swift locali.

```
┌─────────────────────────────── UI (React) ───────────────────────────────┐
│ src/screens  src/ui  src/app (router, contesto, timeline, query)          │
├───────────────────────────────────────────────────────────────────────────┤
│ Logica pura (Node-testabile)      │ Servizi con effetti                    │
│ src/domain: dates, timetable,     │ src/db: Database, Repo, backup         │
│ attendance, grades, analytics,    │ src/documents: DocsRepo, markdown, pdf │
│ recurrence, conflicts             │ src/calendar: service, sync, bridge    │
├───────────────────────────────────┴───────────────────────────────────────┤
│ Storage: sql.js (SQLite WASM) → IndexedDB | Capacitor Filesystem           │
│ File binari (PDF, immagini, note) → FileStore, mai dentro il database      │
├───────────────────────────────────────────────────────────────────────────┤
│ Nativo (iPad): PRCDCalendar (EventKit), PRCDFiles (selettore cartelle)     │
└───────────────────────────────────────────────────────────────────────────┘
```

## Persistenza

- **SQLite (sql.js)** in memoria, serializzato interamente dopo ogni transazione committata (scritture coalescenti e serializzate; `flush()` attende l'ultima). Lo stesso codice e le stesse migrazioni girano nel browser, nel WebView Capacitor e in Node (test), quindi lo schema si verifica una volta sola.
- **Migrazioni** append-only (`src/db/migrations.ts`), versione in `PRAGMA user_version`. Prima di migrare un database esistente si salva `pre-migration-vN`; ogni migrazione è in una transazione con rollback; un database *più nuovo* dell'app viene rifiutato.
- **Web**: IndexedDB. **iPad**: `CapacitorDbPersistence` scrive su file temporaneo + rename e tiene l'ultima copia valida come `.prev`.
- **Snapshot**: pre-migrazione, pre-ripristino, pre-cancellazione totale e uno al giorno (ultimi 7).
- Le transazioni annidate diventano savepoint; ogni errore fa rollback completo.

## Orario ricorrente → lezioni (`src/domain/timetable.ts`)

Tre concetti distinti:

1. **Regola** (`timetable_rules`): giorno, orario, validità. Nessun evento ricorrente per corso.
2. **Occorrenza** (`lessons`): una riga per lezione con **id permanente**; `UNIQUE(rule_id, original_date)` rende la generazione idempotente.
3. **Evento personale** (`calendar_events`): separato, con ricorrenza espansa solo per l'intervallo visibile.

Invarianti (coperti da test):

- La presenza è sull'id della lezione; nessuna operazione sull'orario tocca la presenza.
- Le lezioni non si eliminano: si **annullano** (flag), così presenza e storico restano.
- Una regola sostituita viene **chiusa** (`valid_to`), non riscritta: il pattern originale resta. Le regole nate da uno split condividono `slot_id` (lineage).
- Le modifiche massive ("questa e successive", "tutto l'orario") non toccano lezioni passate o con presenza registrata; le eccezioni singole sopravvivono a "successive" e vengono sostituite solo da "tutto l'orario" **dopo conferma**; c'è un'anteprima per lezione (`planLessonEdit`).
- Le date sono **floating** (`YYYY-MM-DD`, `HH:MM`): niente salti con l'ora legale.

## Presenze, voti, analytics

Definizioni in un solo punto (`attendance.ts`, `grades.ts`): tenute = presente + assente + recuperata; percentuale = presenti / tenute; "da confermare" e annullate escluse (opzioni); media ponderata Σ(voto·CFU)/ΣCFU, aritmetica, base di laurea = ponderata × 110/30; lode configurabile (30/31); idoneità, bocciati, ritirati, rifiutati e prove in itinere esclusi dalle medie. Le correlazioni presenza–voto sono descritte come **associazioni in un campione piccolo, mai come cause** (test dedicato).

## Apple Calendar

**Confine**: `CalendarBridge` (`src/calendar/bridge.ts`). Sopra: motore di sync, UI, test (con `MockCalendarBridge`). Sotto: `PRCDCalendarPlugin.swift` (EventKit). Sul web c'è `UnavailableBridge`.

**Permessi**: la richiesta parte **solo** da `CalendarService.enable()` (azione dell'utente, dopo una schermata che spiega cosa fa e cosa non fa). `init()` legge soltanto lo stato. Gestiti `notDetermined`, `denied`, `restricted`, `writeOnly` (insufficiente) e revoca a runtime: la sincronizzazione si ferma, **le mappature restano**, l'app continua con i calendari locali e riprende alla riconcessione.

**Unità di sincronizzazione = singola occorrenza**: ogni lezione è un evento Apple a sé (non un evento ripetuto), perché le lezioni si spostano e hanno presenza individuale. Gli eventi personali ricorrenti sono sincronizzati per occorrenza nella finestra −30/+180 giorni.

**Identità e duplicati**: UUID interno stabile + tabella `sync_map` (id EventKit, `calendarItemExternalIdentifier`, calendario, timestamp, baseline, stato). Gli identificatori EventKit **non** sono considerati permanenti: ogni evento creato da PRCD porta nel campo `url` il marcatore `prcd://kind/id`; la riconciliazione ritrova l'evento per id → marcatore → external id. Prima di creare si cerca il marcatore ("adopt"), quindi perdere la mappa o reinstallare non genera duplicati.

**Merge a tre vie per campo** contro la baseline dell'ultima sincronizzazione: modifica solo locale → push; solo remota → pull; stesso campo cambiato in modo diverso su entrambi i lati → **conflitto**: non si applica nulla finché l'utente sceglie "tieni quello di PRCD" o "tieni quello di Apple". Per le lezioni si importano da Apple solo orario di inizio/fine (il titolo appartiene al corso); lo spostamento in Apple aggiorna la lezione locale come eccezione **senza toccare la presenza**.

**Eliminazioni**: un evento cancellato in Apple diventa `remote_deleted` (mai ricreato né cancellato localmente in silenzio; l'utente sceglie ricrea / annulla la lezione qui / smetti di sincronizzare). Una lezione annullata o un evento eliminato in PRCD rimuovono l'evento Apple, ma solo se l'utente non l'ha modificato in Apple nel frattempo.

**Eventi di terzi**: letti in sola lettura, solo dai calendari scelti, memorizzati in `external_events`. Il livello nativo rifiuta `update`/`delete` su qualunque evento senza marcatore `prcd://`. Il calendario "Procedo" è l'unico che il plugin crea (e lo riusa per nome/id, senza duplicarlo).

**Trigger**: `EKEventStoreChanged`, ritorno in primo piano, modifiche locali (debounce), pulsante manuale; esecuzione *single-flight*.

## Documenti

File copiati nel `FileStore` (chiave `f/<uuid>`); i metadati e la gerarchia in SQLite. L'import preserva le cartelle, non sovrascrive mai (suffisso " (2)"), salta file nascosti/di sistema e tipi non supportati e riporta cosa è stato fatto. Le note importate sono **sola lettura**; solo le note create in PRCD (`editable=1`) si modificano.

**Markdown** (`unified`/remark/rehype): GFM, frontmatter YAML, KaTeX, evidenziazione, wiki-link e embed Obsidian, link e immagini relativi risolti sul percorso della nota (con fallback per nome come Obsidian). **Sicurezza**: HTML grezzo scartato; sanitizzazione allow-list *prima* di KaTeX/highlight; `javascript:`/`data:` rimossi; le immagini non vengono mai caricate dal parser — il viewer risolve solo i riferimenti locali verso blob URL e **non scarica immagini remote**.

**PDF** (pdf.js, worker incluso nel bundle): pagine virtualizzate (si disegna solo ciò che è vicino alla vista), zoom/adatta larghezza, miniature, ricerca incrementale e annullabile con evidenziazione, segnalibri, ultima posizione per documento.

## Backup

Vedi [BACKUP.md](BACKUP.md).

## Decisioni derivate dal brief (rispetto al design)

- Niente campi aula/docente (il design mostrava "Aula B2").
- Estensione archivio `.prcd`; nome app **PRCD.**, calendario Apple **"Procedo"**.
- Lezioni in Apple Calendario **bidirezionali** (il design diceva "sola lettura").
- Backup notturno su iCloud del design non implementato: export manuale + snapshot locali.
