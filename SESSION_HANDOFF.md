# SESSION_HANDOFF — PRCD.

Ultimo aggiornamento: 2026-11-21, fine sessione 1. **Nessuna nuova implementazione è stata iniziata dopo la richiesta di interruzione.**

Per riprendere: leggi questo file, poi `git log --oneline` (5 commit, working tree pulito) e lancia `npm install && npm test && npx tsc --noEmit`.

---

## 1. Cosa è stato fatto (riassunto in una riga)

Un'app web **React 19 + TypeScript + Vite** che porta il design approvato su **dati locali reali** (SQLite/sql.js, offline, nessun backend), con logica di dominio testata (131 test verdi), backup/restore, calendario, documenti (Markdown + PDF), motore di sincronizzazione Apple Calendar **testato solo contro un mock**, e uno scaffold Capacitor iOS **generato ma mai compilato**. **Il codice Swift (EventKit e selettore cartelle) non è stato scritto.**

## 2. Decisioni prese (e dall'utente)

| Tema | Decisione |
|---|---|
| Natura dello zip | **Non è un'app**: è un export di *design canvas* (22 artboard `.dc.html`, runtime proprietario `x-dc`/`DCLogic`, dati finti hardcoded). Non è un framework riusabile → il design è stato **portato** (CSS e markup 1:1) in React/Vite. L'export originale è intatto in `design/` (commit `120a8b1`) e come zip in `C:\Users\david\Downloads\`. |
| Nome app | **PRCD.** (scelta utente). Calendario Apple gestito: **"Procedo"**. Il design diceva "Libretto": la costante è `APP_NAME` in `src/domain/settings.ts`. |
| Mac/Xcode | **Non disponibile per ora** (risposta utente). Ambiente: Windows 11. Nulla di nativo è stato compilato o testato. |
| Dati demo | Il prodotto parte **vuoto**. Nessun dato demo nel prodotto. L'utente fornirà **più avanti** il formato di un file `.json` strutturato da importare → **importatore JSON non implementato, in attesa del formato**. Esiste solo un seed **solo-DEV** (`src/dev/seed.ts`, vedi §7). |
| Brief vs design | Campo "Aula"/docente **rimosso** (il brief lo vieta). Estensione archivio `.prcd` (non `.libretto`). Lezioni sincronizzate con Apple Calendario in **modo bidirezionale** (il brief prevale sul "sola lettura" del design). Backup notturno iCloud del design **non implementato** (solo export manuale + snapshot locali). |

## 3. Funzionalità completate (verificate = test automatici o prova nel browser)

**Fondamenta**
- Vite + React 19 + TS 7, font self-hosted (@fontsource), KaTeX e worker pdf.js bundled → niente rete. `npm run build` passa.
- DB: **sql.js** (SQLite WASM), una sola migrazione `v1` in `src/db/migrations.ts` (tutte le tabelle), `PRAGMA user_version`, snapshot pre-migrazione, rollback su errore, transazioni annidate (savepoint), foreign key attive, notifiche di cambiamento per tabella. Persistenza: IndexedDB (web, verificata con reload reale nel browser) e `CapacitorDbPersistence`/`CapacitorFileStore` (iPad, **scritti ma non provati**).
- Backup/restore completo: archivio ZIP `.prcd` (manifest + sha256, `database.sqlite`, `data.json` leggibile, `files/…`), verifica integrità/FK/versione **prima** di toccare i dati, snapshot automatico `pre-restore-*` / `pre-erase-*`, restore tutto-o-niente. Snapshot automatici giornalieri (ultimi 7) in `src/db/autoBackup.ts`. Export CSV (presenze, esami) e `.ics` (`src/db/exporters.ts`).

**Università** (`src/domain/*`, `src/db/repo.ts`)
- Semestri, corsi (colore, CFU, tipo esame voto/idoneità), regole orarie settimanali, **occorrenze di lezione materializzate** con id permanente (UNIQUE `(rule_id, original_date)` → generazione idempotente).
- Modifiche con **ambito esplicito** (`planLessonEdit`): una lezione / questa e successive / tutto l'orario; split delle regole con `slot_id` (lineage), lezioni passate o con presenza registrata mai toccate, eccezioni singole conservate in "successive" e sostituite solo in "tutto" **dopo conferma**; anteprima per lezione; annullamento (riga conservata), lezione extra, festività/sospensioni, estensione semestre senza cancellare nulla. La presenza vive sull'id lezione: spostare non la azzera mai (testato).
- Presenze: 4 stati, calcolo in un'unica funzione (`computeAttendance`): tenute, presenti, assenze aperte, recuperate, % (esclude "da confermare"/annullate, opzioni in Impostazioni), avanzamento recuperi. Numeri del design riprodotti (Fisica 2: 18/24 = 75%).
- Esami: tentativi multipli, prove in itinere, ritirato/respinto/rifiutato, idoneità, lode 30/31, **media ponderata, aritmetica, base di laurea ×110/30**, simulazione voti futuri e "media necessaria per arrivare a X". Riprodotti i numeri del design (26,42 / 26,33 / 96,9 / 56 CFU).
- Analytics: correlazione presenza–voto (Pearson; con i dati del design r≈0,86 come stampato), outlier, trend settimanale, assenze per giorno, confronto semestri, ore di studio. Testo sempre "associazione, non causa".

**Calendario**
- Viste giorno/settimana/mese, filtri per categoria, colori, linea "adesso", rilevamento sovrapposizioni, lane per eventi concorrenti, click su slot vuoto → nuovo evento.
- Eventi personali (evento/scadenza/appuntamento/studio) con ricorrenze (daily/weekly con giorni/monthly/yearly, until/count), eccezioni per singola occorrenza, "questa e successive" (split serie), promemoria, colore, destinazione Apple.
- Lezioni, eventi, esami pianificati ed eventi Apple (read-only) uniti in un'unica timeline (`src/app/timeline.ts`) restando tipi distinti.

**Apple Calendar — lato TypeScript completo** (`src/calendar/`)
- `bridge.ts`: interfaccia `CalendarBridge` + `UnavailableBridge` (web) + `CapacitorCalendarBridge` (plugin `PRCDCalendar`, **lato Swift mancante**). Marker URL `prcd://kind/id` su ogni evento creato.
- `sync.ts`: unità di sync = singola occorrenza (ogni lezione = un evento Apple); mappa `sync_map`; **riconciliazione** per id → marker → externalId (cambi di identificatore non creano duplicati); prevenzione duplicati (adopt per marker); **merge a tre vie per campo** con baseline; conflitti non sovrascritti e risolvibili dall'utente; evento cancellato in Apple → stato `remote_deleted`, mai ricreato/cancellato in silenzio; mai modificati eventi di terzi; lo spostamento in Apple aggiorna la lezione locale **senza toccare la presenza**.
- `service.ts`: permesso richiesto solo da `enable()` (azione utente), calendario gestito "Procedo", elenco calendari/visibilità, cache eventi esterni read-only, trigger (EKEventStoreChanged, foreground, modifiche locali, debounce, single-flight), revoca permessi senza rompere l'app.
- `mock.ts`: `MockCalendarBridge` fedele (id che cambiano, spostamenti tra calendari, edit di terzi, permessi negati/revocati…). 22 test di sync.

**Documenti** (`src/documents/`)
- Cartelle annidate, import file e **cartelle con gerarchia preservata** (`importTree`), copia in storage privato (originali mai modificati), rinomina/sposta/elimina con conferma e conteggio impatto, preferiti, tag, recenti, collegamento a corso, ricerca su nomi + testo delle note (LIKE: sql.js non ha FTS5), mai sovrascritture (suffisso " (2)").
- **Markdown** (`markdown.ts`): CommonMark+GFM, frontmatter YAML, KaTeX inline/display, code highlighting, wiki-link Obsidian `[[Nota|alias#titolo]]`, embed `![[img|300]]`, link relativi, indice dei titoli, **sanitizzazione** (HTML grezzo scartato, schema allow-list, schemi `javascript:`/`data:` rimossi, nessun caricamento automatico di immagini remote). Risoluzione immagini relative/Obsidian nel viewer, box d'errore "Immagine non trovata" con "Scegli il file".
- **PDF** (`PdfViewer.tsx`, `pdf.ts`): rendering a pagine virtualizzate, navigazione, zoom + adatta larghezza, miniature, ricerca testo (incrementale, annullabile, highlight), segnalibri, ultima posizione salvata, "schermo intero" come modalità immersiva. Verificato nel browser con un PDF reale.
- Note create in-app (`editable=1`) sono modificabili con semplice textarea; **i documenti importati sono di sola lettura**.

**UI collegata ai dati reali** (`src/screens/`): Oggi, Calendario (3 viste), Università, Corso (4 tab), Registra presenze (tastiera P/A/R/T, ↑↓), Libretto (+simulazione), Statistiche, Documenti (colonne + anteprima + import + drag&drop), Lettore (MD/PDF/immagine), Calendari Apple (permessi, visibilità, default, pubblicazione lezioni, conflitti, duplicati), Impostazioni (9 categorie, backup/restore/export/erase), ricerca globale, modali (corso, semestre, evento, modifica lezione con anteprima, tentativo d'esame, import…). Router hash, layout fluido con breakpoint ≤900px.

**Altro**: notifiche di fine lezione con azioni Presente/Assente (`src/app/notifications.ts`, plugin ufficiale `@capacitor/local-notifications`, **non provate**).

## 4. Stato attuale del codice

- **Git**: working tree **pulito**, 5 commit (`120a8b1` design+scaffold → `6296756` dominio/DB → `c660eb8` backup/sync → `1069320` documenti/markdown → `7159774` UI completa + iOS scaffold). Autore impostato per-commit (`PRCD dev`), config git globale non modificata. Il commit di questo file è l'ultimo.
- `npx tsc --noEmit`: **0 errori**. `npx vitest run`: **12 file, 131 test, tutti verdi** (~2 s). `npm run build`: OK (warning bundle >1,5 MB).
- ~10.7k righe in `src/`, ~1.7k di test. Struttura: `src/{domain,db,storage,calendar,documents,app,screens,ui,styles,dev}`, `tests/`, `design/` (spec congelata), `ios/` (progetto Capacitor generato), `docs/` e `ios-plugin/` (**cartelle vuote**, non tracciate da git).
- Stack: React 19.3, TS 7.0.2 (nota: `baseUrl` rimosso, usato `paths` con `./`), Vite 8.3, Vitest 5.1, sql.js 1.17, pdfjs-dist 5.6, Capacitor 8.6.2 (SPM, iOS 15+), unified/remark/rehype, fflate, KaTeX.
- `ios/` generato con `npx cap add ios` (funziona anche su Windows). **Non è stato modificato a mano**: Info.plist e storyboard sono quelli di default.

## 5. Da implementare (in ordine di priorità)

1. **Plugin Swift `PRCDCalendar` (EventKit)** — contratto già definito in `src/calendar/bridge.ts` (interfaccia `PRCDCalendarPlugin`): `status`, `requestFullAccess`, `listCalendars`, `ensureManagedCalendar(name, knownId)`, `fetchEvents`, `getEvent`, `createEvent`, `updateEvent`, `deleteEvent`, `openSettings`, evento `storeChanged`. Punti da rispettare: `requestFullAccessToEvents` (iOS 17+) con fallback `requestAccess(to:.event)` per iOS 15–16 e stato `writeOnly`; eventi **floating** (`timeZone = nil`), date come stringhe locali `yyyy-MM-ddTHH:mm`; all-day → fine normalizzata a `T23:59`; salvare/leggere `url = prcd://kind/id`; restituire `eventIdentifier`, `calendarItemExternalIdentifier`, `lastModifiedDate`; `ensureManagedCalendar` crea "Procedo" nella sorgente iCloud (altrimenti locale) **senza creare duplicati** e senza toccare altri calendari; osservare `EKEventStoreChanged`; alarm opzionale.
2. **Plugin Swift `PRCDFiles`** (`pickFolder`, `cleanup`) con `UIDocumentPickerViewController` in modalità cartella + security-scoped URL + copia ricorsiva in temp (il wrapper TS è già in `src/documents/importSources.ts`; su iOS `<input webkitdirectory>` non funziona).
3. **Collegare i plugin al progetto iOS** senza toccare `project.pbxproj`: mettere i `.swift` in `ios/App/CapApp-SPM/Sources/CapApp-SPM/` (classi `public`, conformi a `CAPBridgedPlugin`), definire `MainViewController: CAPBridgeViewController` dentro `AppDelegate.swift` con `registerPluginInstance(...)` in `capacitorDidLoad()`, e cambiare in `Main.storyboard` `customClass="MainViewController" customModule="App" customModuleProvider="target"`. Aggiungere a `Info.plist`: `NSCalendarsFullAccessUsageDescription`, `NSCalendarsUsageDescription` (iOS<17), eventualmente `NSCalendarsWriteOnlyAccessUsageDescription`, testo italiano chiaro sul perché serve l'accesso. Idealmente uno script `scripts/setup-ios.*` ripetibile.
4. **Documentazione** (richiesta dal brief; `docs/` è vuota): `README.md` (installazione, comandi), `docs/ARCHITECTURE.md`, `docs/SCHEMA.md` (schema DB, vedi `src/db/migrations.ts`), `docs/IOS_BUILD.md` (build iPad + checklist di verifica nativa), permessi Apple Calendar, procedura backup/restore, **elenco funzionalità e limiti**. Dichiarare esplicitamente che il nativo **non è stato testato**.
5. **Importatore JSON** strutturato — attendere il formato che l'utente comunicherà (il formato di backup interno `data.json` esiste ma è un dump di tabelle, non l'input pensato dall'utente).
6. **Verifica visiva/funzionale mancante** (vedi §6) e confronto con gli artboard non ancora letti: `Importa`, `Markdown`, `PDF`, `Navigazione`, `Adattamenti` (iPad verticale e Mac), `Stati`.
7. Qualità/performance: code-splitting (pdf.js, KaTeX/unified, Capacitor in chunk dinamici; il main chunk è ~1,75 MB; warning `INEFFECTIVE_DYNAMIC_IMPORT` su `@capacitor/filesystem`), `npm audit` (4 vulnerabilità *low* non esaminate), test del flusso di import cartelle da `FileList`.
8. **Build e test su Mac/Simulatore/iPad** (`npm run build && npx cap sync ios`, aprire `ios/App/App.xcodeproj`), poi test reali di EventKit, notifiche, selettore cartelle, grandi PDF, airplane mode.
9. Chiamata all'**advisor** pianificata a fine lavoro (era in corso quando la sessione è stata interrotta): rivedere architettura/sync/rischi prima di dichiarare completato.

## 6. Problemi aperti e cose non verificate

- **Nativo = zero verifica.** Mai compilato su Xcode/simulatore/dispositivo. Non dichiarare "testato su iPad" finché non lo è. `CapacitorFileStore`, `CapacitorDbPersistence`, `CapacitorCalendarBridge`, notifiche locali, `saveFile` via Share sono **solo scritti**.
- **Sync Apple**: testata solo su `MockCalendarBridge`. Il comportamento reale di EventKit (identificatori che cambiano, eventi all-day, fusi orari, `lastModifiedDate`, iCloud lento) va verificato su dispositivo.
- **Schermate non ispezionate visivamente**: Modifica lezione (nel browser integrato il time-picker nativo ha coperto la modale al click, non è chiaro se sia solo un artefatto del browser: **riprovare**), Nuovo evento, Calendari Apple (testabile in DEV con `?mockCalendar`), Impostazioni, tab Lezioni/Esame/Materiali del Corso, vista Giorno e Mese, modale Import, tutti i layout **iPad verticale**/Mac.
- Layout: i breakpoint ≤900px sono una **mia interpretazione** (artboard `Adattamenti` non letto). Il design è a 1194×834 fisso; nella versione fluida il tile "Presenze del semestre" di Oggi scorre internamente a 834 px d'altezza.
- Statistiche: lo scatter "presenza→voto" richiede esami superati **con lezioni registrate nell'app**; con il seed DEV i corsi dell'anno precedente non hanno presenze, quindi mostra il testo "servono dati".
- Limiti noti di progettazione: sql.js **riscrive l'intero DB** a ogni commit (ok per metadati, da monitorare); nessun FTS5 (ricerca con LIKE; i PDF non sono indicizzati a livello libreria, solo ricerca dentro il visualizzatore); creazione/ripristino archivio **interamente in memoria** (problematico per librerie di GB); PDF caricati via blob URL (su nativo `fetch` del file → memoria); "schermo intero" è modalità immersiva (la Fullscreen API non esiste su iPad); sync degli eventi ricorrenti **per occorrenza** nella finestra −30/+180 giorni (non come serie Apple); i titoli/note degli eventi lezione modificati in Apple vengono ignorati (appartengono al corso); eventi di terzi mai modificati.
- Il campo `lastBackupAt` e il "backup automatico iCloud" del design: solo export manuale.
- Nessuna modifica è stata fatta all'originale in `C:\Users\david\Downloads\`.

## 7. Come lavorare / riprendere

```powershell
cd D:\Progetti\ClaudeCode\PRCD
npm install            # se node_modules manca
npm test               # 131 test, ~2 s
npx tsc --noEmit       # typecheck
npm run dev            # http://localhost:5173  (anche: preview_start "prcd-dev", .claude/launch.json)
npm run build          # produce dist/
npx cap sync ios       # dopo un build, copia dist/ in ios/ (su Mac prima di aprire Xcode)
```

- **Dati di sviluppo**: in modalità `npm run dev`, nella console del browser `await __prcdSeed()` carica un semestre d'esempio (5 corsi, esami, eventi, 3 note). `window.__prcd` espone i servizi (`repo`, `db`, `docs`, `calendar`). `?mockCalendar` nell'URL attiva il bridge EventKit simulato. Il seed **non è nel build di produzione**.
- Il browser di sviluppo contiene ora i dati di seed in IndexedDB (database `prcd-db`/`prcd-files`): per ripartire da vuoto usa *Impostazioni → Dati e backup → Elimina tutti i dati* oppure cancella i dati del sito localhost:5173.
- Il server di sviluppo avviato in questa sessione (porta 5173) potrebbe essere ancora attivo: riavviarlo con `npm run dev`.
- Convenzioni da mantenere: logica pura in `src/domain` (testabile in Node), accesso dati solo da `Repo`/`DocsRepo`, ogni operazione distruttiva **esplicita + confermata + con snapshot**, mai cancellare lezioni (si annullano), la presenza non cambia mai con data/ora, contenuto dei documenti sempre trattato come non fidato.

## 8. Prossimi passi concreti per domani

1. `git status` (deve essere pulito) → `npm test` → `npx tsc --noEmit`.
2. Scrivere `PRCDCalendarPlugin.swift` (punto 1 del §5) e `PRCDFilesPlugin.swift`, registrarli (§5.3) e aggiungere le chiavi di `Info.plist`. Commit.
3. Scrivere README + `docs/*` (§5.4) con elenco onesto di funzioni e limiti.
4. Leggere gli artboard `Adattamenti`, `Importa`, `Markdown`, `PDF`, `Stati` e allineare layout iPad verticale/Mac; ispezionare le schermate elencate in §6.
5. Se l'utente ha un Mac: build iOS e checklist di verifica nativa; altrimenti consegnare come prototipo web + codice nativo "non verificato".
6. Chiedere all'utente il **formato JSON** per l'importazione e implementarlo (con validazione, transazione, report, mai sovrascrittura).
7. Chiamata finale all'advisor, poi riepilogo di funzionalità e limiti.
