# Build per iPad e permessi Apple Calendar

> **Avviso.** Tutto il codice nativo (plugin Swift, configurazione Xcode, notifiche locali, storage su filesystem Capacitor) è stato scritto su Windows **senza poterlo compilare né eseguire**. Nessuna funzione nativa è da considerare testata finché non si completa la checklist in fondo. Il test `tests/native-contract.test.ts` controlla solo che i nomi dei metodi e dei campi tra TypeScript e Swift coincidano: non sostituisce una build.

## Requisiti

- Mac con **Xcode 15 o successivo** (le API EventKit "full access" sono iOS 17+; il target minimo del progetto è iOS 15, con ripiego sulle API precedenti).
- Node.js 20+, npm. Nessun CocoaPods: Capacitor 8 usa Swift Package Manager.
- Un iPad (o il simulatore iPad). Il progetto è impostato **solo iPad** (`TARGETED_DEVICE_FAMILY = 2`).

## Passi

```bash
git clone <repo> && cd PRCD
npm install
npm test                 # deve passare prima di tutto
npm run build            # produce dist/
npx cap sync ios         # copia dist/ in ios/App/App/public e aggiorna Package.swift
npx cap open ios         # apre ios/App/App.xcodeproj in Xcode
```

In Xcode: seleziona il target **App**, scheda *Signing & Capabilities* → scegli il tuo Team (serve un Apple ID; per installare su un dispositivo personale basta il piano gratuito), cambia se vuoi il *Bundle Identifier* (`app.prcd.planner` di default), scegli un iPad come destinazione e premi ▶︎.

### Cosa contiene `ios/`

| File | Ruolo |
|---|---|
| `ios/App/CapApp-SPM/Sources/CapApp-SPM/PRCDCalendarPlugin.swift` | Plugin EventKit (`PRCDCalendar`) |
| `…/PRCDFilesPlugin.swift` | Selettore di cartelle da File (`PRCDFiles`) |
| `…/MainViewController.swift` | Registra i due plugin nel bridge Capacitor |
| `ios/App/App/SceneDelegate.swift` | Usa `MainViewController` come root |
| `ios/App/App/Info.plist` | Testi dei permessi Calendario, regione `it`, `arm64` |

I plugin stanno nel target SPM `CapApp-SPM` (che `cap sync` non sovrascrive: rigenera solo `Package.swift`), così non serve modificare `project.pbxproj`. Se `npx cap sync` dovesse mai rimuoverli, i tre file `.swift` sono in git.

### Altri plugin

`@capacitor/filesystem` (database e documenti in `Directory.Data`, non visibile in File), `@capacitor/share` (esportazione di archivi/CSV/ICS dal foglio di condivisione), `@capacitor/local-notifications` (promemoria "Eri a lezione?" con azioni Presente/Assente).

## Permessi Apple Calendar

**Info.plist** (già inseriti, in italiano):

- `NSCalendarsFullAccessUsageDescription` — iOS 17+
- `NSCalendarsUsageDescription` — iOS 15–16

Testo mostrato: *«PRCD legge i calendari che scegli tu per mostrarli accanto alle lezioni e scrive solo gli eventi creati da PRCD (nel calendario «Procedo» o in quello che indichi). Non modifica né elimina eventi di altre app e non invia nulla fuori dal dispositivo.»*

**Quando si chiede**: mai all'avvio. Solo quando l'utente apre *Calendario → Gestisci calendari* e preme **Continua** nella schermata che spiega cosa viene letto e scritto. Si richiede l'**accesso completo** (lettura + scrittura): senza lettura non si possono mostrare gli eventi né sincronizzare.

**Stati gestiti**

| Stato | Comportamento |
|---|---|
| Non ancora chiesto | Schermata esplicativa + «Continua» |
| Negato / limitato | Spiegazione + «Apri Impostazioni iPad»; il resto dell'app funziona normalmente |
| Solo scrittura (iOS 17 "aggiungi eventi") | Trattato come insufficiente: si chiede di concedere l'accesso completo |
| Revocato (con l'app chiusa o in uso) | La sincronizzazione si ferma, **le mappature restano**, compare l'avviso; alla riconcessione riparte. Nota: iOS tende a terminare l'app quando un permesso privacy cambia, quindi il caso reale è la **riapertura** dopo la revoca (da verificare su dispositivo) |

Per revocare: *Impostazioni iPad → Privacy e sicurezza → Calendari → PRCD.*

**Calendario "Procedo"**: creato nella sorgente iCloud dell'utente (altrimenti "Sul mio iPad"). È l'unico calendario che PRCD crea; se esiste già lo riusa. Se l'utente lo elimina da Calendario, le lezioni pubblicate risulteranno "eliminate in Apple" e andranno risolte dalla schermata Calendari.

## Backup e ripristino su iPad

Vedi [BACKUP.md](BACKUP.md). L'esportazione apre il foglio di condivisione di iPadOS (Salva in File, AirDrop…); il ripristino usa il selettore di File.

## Checklist di verifica nativa (da eseguire, da spuntare)

Compilazione e avvio
- [ ] Il progetto compila senza errori Swift (verificare soprattutto `PRCDCalendarPlugin.swift` e `PRCDFilesPlugin.swift`).
- [ ] L'app si avvia su simulatore iPad e su un iPad reale; compare "Benvenuto in PRCD.".
- [ ] Creare un semestre, un corso con orario, registrare presenze; chiudere e riaprire l'app: i dati ci sono.
- [ ] **Modalità aereo**: tutto funziona (font, KaTeX, PDF, database).

Apple Calendar
- [ ] Il prompt di sistema compare solo dopo «Continua»; i testi sono quelli attesi.
- [ ] Negare il permesso: nessun crash, l'app funziona, «Apri Impostazioni iPad» funziona.
- [ ] Concedere: compare il calendario «Procedo» (una sola volta, anche dopo più avvii).
- [ ] Attivare «Pubblica le lezioni»: ogni lezione diventa un evento a sé; titolo = nome corso; **nessun campo aula/luogo**.
- [ ] Spostare una lezione in PRCD → l'evento Apple si sposta. Spostare l'evento in Calendario → la lezione locale si sposta **e la presenza resta**.
- [ ] Modificare lo stesso evento su entrambi i lati → compare un conflitto e nulla viene sovrascritto.
- [ ] Eliminare un evento in Calendario → "Eliminato da Apple Calendario" con le tre scelte; non viene ricreato da solo.
- [ ] Evento di un'altra app (es. "Dentista"): visibile in sola lettura, mai modificato; verificare che `update`/`delete` falliscano con `NOT_PRCD_EVENT`.
- [ ] Revocare il permesso da Impostazioni: **iOS di solito termina l'app** quando si cambia un permesso privacy. Verificare invece che alla **riapertura** l'app parta senza crash, mostri "Accesso ai calendari revocato", mantenga tutti i dati locali e le mappature, e che riconcedendo il permesso la sincronizzazione riprenda senza duplicati. (Il caso "revocato mentre l'app è in primo piano" è coperto da test solo contro il mock.)
- [ ] Modificare un evento da un altro dispositivo iCloud: la modifica arriva (notifica `EKEventStoreChanged`) e rientrando in primo piano l'app si aggiorna.
- [ ] Verificare eventi *all-day* (fine inclusiva `T23:59`), fusi orari diversi, eventi ricorrenti di terzi (ogni occorrenza deve comparire una volta).
- [ ] Cambio di ora legale: gli orari delle lezioni restano gli stessi sul muro.

Documenti
- [ ] «Scegli una cartella o un vault Obsidian» apre il selettore di File; la gerarchia viene importata; `.obsidian` e file nascosti saltati; un file iCloud non ancora scaricato viene scaricato.
- [ ] Un PDF grande (centinaia di MB): apertura, scorrimento, ricerca, memoria stabile.
- [ ] Immagini relative e `![[…]]` in una nota importata si vedono; il file originale in File non è stato modificato.
- [ ] Il lettore Markdown rende LaTeX e codice; link a note interne funzionano.

Notifiche e altro
- [ ] Notifica di fine lezione: i pulsanti Presente/Assente aggiornano la presenza anche ad app chiusa.
- [ ] Esporta archivio `.prcd` → Salva in File; ripristino da File su un'altra installazione.
- [ ] Orientamenti: orizzontale, verticale, Split View/Slide Over.

Quando una voce è verificata, annotarlo nel commit o in `docs/FEATURES.md` ("Verificato su iPad (modello, iPadOS) il …").
