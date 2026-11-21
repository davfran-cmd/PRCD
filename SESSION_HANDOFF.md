# SESSION_HANDOFF — PRCD.

Ultimo aggiornamento: fine sessione 2 (2026-11-21). Sostituisce la versione della sessione 1, ormai superata.

**Per riprendere:** `git status` (deve essere pulito) → `npm install` → `npm test` (154 verdi) → `npx tsc --noEmit` (0 errori) → `npm run build`.

---

## 1. In una riga

App web **React 19 + TypeScript + Vite** completa e funzionante su dati locali reali (SQLite/sql.js, offline), con il design portato 1:1, 144 test automatici e verifica a mano nel browser; **codice nativo iPad scritto ma mai compilato né eseguito** (nessun Mac/Xcode). Il formato JSON da importare è stato fornito dall'utente: sono i **backup della vecchia app Procedo**, ora importabili (vedi `docs/IMPORT_PROCEDO.md`).

## 2. Decisioni dell'utente

| Tema | Decisione |
|---|---|
| Nome | **PRCD.** (costante `APP_NAME`); calendario Apple gestito **"Procedo"** |
| Mac/Xcode | **Non disponibile per ora** → prima il prototipo web |
| Dati demo | Il prodotto parte **vuoto**. Importazione da un `.json` strutturato "in un formato che dirà più avanti" → **in attesa** |

Lo zip di partenza era un *design canvas* (22 artboard `.dc.html` con dati finti), non un'app: è stato **portato** in React. L'originale è intatto in `design/` e in `C:\Users\david\Downloads\`.

## 3. Stato del codice

- **Git:** working tree pulito dopo l'ultimo commit di questa sessione. Cronologia: `120a8b1` design+scaffold → `6296756` dominio/DB → `c660eb8` backup/sync → `1069320` documenti/markdown → `7159774` UI + scaffold iOS → `7d802cd` handoff v1 → `bec9d85` plugin Swift → `c848e90` documentazione → `2a4df16` fix layout → (ultimo) adattamenti al design, wizard di import, lettore, scorciatoie, handoff v2. Autore impostato per-commit (`PRCD dev`); la config git globale non è stata toccata.
- `tsc --noEmit`: 0 errori · `vitest`: **15 file, 154 test** · `npm run build`: ok.
- **Native (`ios/`)**: generato con `npx cap add ios` (funziona anche su Windows, SPM). Aggiunti:
  - `ios/App/CapApp-SPM/Sources/CapApp-SPM/PRCDCalendarPlugin.swift` (EventKit), `PRCDFilesPlugin.swift` (selettore cartelle), `MainViewController.swift` (registra i plugin);
  - `SceneDelegate.swift` usa `MainViewController`; `Info.plist` con `NSCalendarsFullAccessUsageDescription` + `NSCalendarsUsageDescription`, regione `it`, `arm64`; `project.pbxproj` impostato **solo iPad** (`TARGETED_DEVICE_FAMILY = 2`).
  - `tests/native-contract.test.ts` verifica che metodi/campi TypeScript↔Swift coincidano (**non** sostituisce una build).
- Documentazione completa in `README.md` e `docs/` (ARCHITECTURE, SCHEMA, IOS_BUILD con checklist, BACKUP, FEATURES con elenco **nominato** degli scostamenti dal design).

## 4. Cosa è stato verificato (e come)

**Nel browser (Vite dev), con dati di seed:** Oggi (numeri reali: 26,42 / 96,9 / 56 CFU / 13 giorni), Università, Corso, Libretto con simulazione, Statistiche, Documenti, lettore Markdown (KaTeX, wiki-link, immagine mancante, indice, pannello Proprietà, "Note che citano questa"), lettore PDF con un PDF reale, Calendario settimana/mese, Nuovo evento (creato e persistito), Impostazioni → Dati, Calendari Apple con il **mock** (permesso → "Procedo" → 149 lezioni pubblicate, duplicato "Dentista" rilevato), modifica lezione "questa e successive" (regola divisa, presenze passate intatte, 8 eventi Apple aggiornati), import guidato di una cartella simulata (gerarchia mantenuta, file nascosti saltati), layout a 1194/820/520 px, persistenza dopo reload.

**Con test automatici:** dominio (date, orario, presenze, voti, ricorrenze, conflitti, analytics), DB/migrazioni/rollback, backup/ripristino, sync Apple contro `MockCalendarBridge`, documenti/import, Markdown/sanitizzazione, PDF reale (caricamento, ricerca, rettangoli), esportatori, backlinks, `IndexedDbPersistence`.

**NON verificato:** tutto il nativo (compilazione Swift, EventKit reale, selettore cartelle, notifiche locali, `CapacitorFileStore`/`CapacitorDbPersistence`, Share) · vista Giorno · editor delle note in-app · scorciatoie ⌘ · schermate Impostazioni diverse da "Dati" · Corso tab Lezioni/Esame/Materiali · iPad verticale per Statistiche, Libretto, Documenti, Corso.

## 5. Da fare (in ordine)

1. ~~Import JSON~~ → fatto: import dei backup di Procedo (schema v2: `lessons.time_unknown`, `import_map`), 10 test, provato nel browser col file d'esempio. Da provare con un **backup reale** dell'utente.
2. **Build su Mac** (`npm run build && npx cap sync ios && npx cap open ios`) e checklist in `docs/IOS_BUILD.md`: i file Swift non sono mai stati compilati, aspettarsi qualche correzione.
3. Verifiche visive mancanti (§4, "NON verificato"), comprese le scorciatoie.
4. Qualità: code-splitting (bundle ~1,8 MB; warning `INEFFECTIVE_DYNAMIC_IMPORT` su `@capacitor/filesystem`), `npm audit` (4 vulnerabilità *low* non esaminate), eventuale scelta in blocco per le lezioni "eliminate in Apple" se si cancella il calendario Procedo.
5. Scostamenti dal design ancora aperti (elenco completo in `docs/FEATURES.md`): collegamento live alla cartella, Apple Pencil, gesti, ricerca nel testo dei PDF a livello di libreria, pannello contestuale Mac >1400 pt, backup iCloud notturno.

## 6. Problemi aperti / attenzioni

- **Il dato di sviluppo nel browser** (IndexedDB su localhost:5173) è stato migrato davvero da v1 a v2 (snapshot `pre-migration-v1`), poi cancellato e ora contiene solo il **backup d'esempio di Procedo** importato. Per ripartire da vuoto: *Impostazioni → Dati e backup → Elimina tutti i dati* o cancellare i dati del sito.
- **EventKit reale**: id che cambiano, eventi *all-day* (fine normalizzata a `T23:59`), fusi orari, `lastModifiedDate`, iCloud lento → comportamento da verificare; su iOS la revoca di un permesso di solito **termina** l'app, quindi il caso reale è la riapertura (checklist aggiornata).
- sql.js riscrive l'intero DB a ogni commit; archivio e ripristino in memoria; niente FTS5 (LIKE).
- Le scorciatoie Ctrl+N/T/R sono riservate dai browser desktop (sull'iPad con tastiera usano ⌘).
- Il dev server è fermato a fine sessione (riavvio: `npm run dev`, oppure `preview_start "prcd-dev"` da `.claude/launch.json`).

## 7. Comandi

```powershell
cd D:\Progetti\ClaudeCode\PRCD
npm install
npm test               # 154 test
npx tsc --noEmit
npm run dev            # http://localhost:5173
npm run build
npx cap sync ios       # su Mac, prima di aprire Xcode
```

Sviluppo, dalla console del browser: `await __prcdSeed()` (dati d'esempio, **solo DEV**, non nel build), `window.__prcd` (servizi), `?mockCalendar` nell'URL (EventKit simulato).

## 8. Convenzioni da non rompere

Logica pura in `src/domain` (testabile in Node) · accesso ai dati solo da `Repo`/`DocsRepo` · ogni azione distruttiva esplicita + confermata + preceduta da snapshot · le lezioni non si eliminano (si annullano) · la presenza non cambia mai con data/ora · i documenti importati restano di sola lettura · contenuto dei documenti sempre non fidato · nessuna rete, nessun backend · mai affermare "testato su iPad" finché non lo è.
