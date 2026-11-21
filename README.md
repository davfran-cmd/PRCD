# PRCD.

App personale per università e vita quotidiana, **local-first**: lezioni, presenze, esami e medie, calendario (con Apple Calendar), note Markdown e PDF. Nessun account, nessun server, nessuna analisi: tutto resta sul dispositivo e funziona in modalità aereo.

> **Stato onesto.** Il prototipo **web** è completo e testato (131+ test automatici, verifica nel browser). Il codice **nativo iPad** (plugin Swift per EventKit e per il selettore di cartelle, progetto Capacitor) è **scritto ma mai compilato né eseguito**: lo sviluppo è avvenuto su Windows, senza Xcode. Non va considerato testato su iPad finché non è stato costruito e provato su simulatore o dispositivo — vedi [docs/IOS_BUILD.md](docs/IOS_BUILD.md).

## Da dove viene

Lo zip di partenza non era un'app ma un *design canvas* (22 artboard `.dc.html` con dati finti e un runtime proprietario). Il design è stato **portato** 1:1 (colori, tipografia, componenti, numeri) in una vera app React + TypeScript + Vite su dati reali. L'export originale è congelato in [`design/`](design/) come specifica di riferimento.

## Requisiti

- Node.js 20+ (sviluppato con 24) e npm.
- Per l'app iPad: **un Mac con Xcode 15+** (iOS 15+ come target, API EventKit complete da iOS 17).

## Comandi

```bash
npm install          # dipendenze
npm run dev          # sviluppo su http://localhost:5173
npm test             # test automatici (Vitest, ~2 s)
npm run typecheck    # tsc --noEmit
npm run build        # build di produzione in dist/ (offline: font, KaTeX, worker PDF, WASM inclusi)
npm run cap:sync     # build + copia in ios/ (da lanciare su Mac prima di aprire Xcode)
```

In sviluppo, dalla console del browser:

- `await __prcdSeed()` carica un semestre d'esempio (solo DEV, **non** presente nel build di produzione: il prodotto parte vuoto).
- `window.__prcd` espone i servizi (`repo`, `db`, `docs`, `calendar`).
- `?mockCalendar` nell'URL attiva un'implementazione simulata di EventKit per provare la UI di Apple Calendario nel browser.

## Struttura

| Percorso | Contenuto |
|---|---|
| `src/domain/` | Logica pura, testabile in Node: date, orario ricorrente → lezioni, presenze, voti e medie, ricorrenze, conflitti, analytics |
| `src/db/` | SQLite (sql.js), migrazioni, repository, backup/ripristino, esportatori CSV/ICS |
| `src/storage/` | File store (IndexedDB / filesystem Capacitor), persistenza del database |
| `src/calendar/` | Bridge EventKit (interfaccia + mock), motore di sincronizzazione, servizio |
| `src/documents/` | Libreria, import, pipeline Markdown, visualizzatore PDF |
| `src/app/`, `src/screens/`, `src/ui/` | Shell, router, schermate e componenti |
| `ios/` | Progetto Capacitor + plugin Swift (`ios/App/CapApp-SPM/Sources/CapApp-SPM/`) |
| `tests/` | Test automatici |
| `design/` | Export del design originale (sola lettura) |
| `docs/` | Documentazione |

## Documentazione

- [Architettura](docs/ARCHITECTURE.md) — livelli, invarianti, sincronizzazione Apple Calendar, sicurezza
- [Schema del database](docs/SCHEMA.md)
- [Build per iPad e permessi Apple Calendar](docs/IOS_BUILD.md) — con la checklist di verifica nativa
- [Backup e ripristino](docs/BACKUP.md)
- [Import dei backup di Procedo](docs/IMPORT_PROCEDO.md)
- [Funzionalità e limiti](docs/FEATURES.md)

## Principi non negoziabili

- Nessun backend, nessuna telemetria, nessuna rete richiesta dopo l'installazione.
- Nessun dato dell'utente viene eliminato o sovrascritto in silenzio: ogni azione distruttiva è esplicita, confermata e preceduta da uno snapshot.
- La presenza appartiene alla lezione, non all'orario: spostare una lezione non la azzera mai.
- Il contenuto dei documenti è non fidato: HTML scartato, schema allow-list, nessun caricamento automatico di immagini remote.
- Gli eventi di altre app in Apple Calendario non vengono mai modificati né eliminati.
