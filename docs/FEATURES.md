# Funzionalità implementate e limiti

Legenda — **T** = coperto da test automatici · **B** = verificato a mano nel browser · **N** = codice nativo scritto, **non verificato** (nessun Xcode disponibile).

## Implementato

### Base
- App web offline (font, KaTeX, worker PDF e WASM inclusi nel bundle) · **B**
- Database SQLite con migrazioni, transazioni, validazione, persistenza dopo ogni commit · **T B**
- Backup/ripristino `.prcd` verificato, snapshot automatici, esportazioni CSV/ICS · **T**
- Scaffold Capacitor iOS (solo iPad) con plugin Swift · **N**

### Università
- Semestri (crea, modifica, archivia), corsi (nome, colore, CFU, tipo esame), orario settimanale → **occorrenze con id permanente** · **T B**
- Modifica lezione con ambito esplicito (una / successive / tutto) e anteprima per lezione; annullamento, lezione extra, festività, eccezioni individuali; presenza mai azzerata · **T**
- Presenze in 4 stati, registrazione rapida (tastiera, tocco), percentuali, recuperi, soglia · **T B**
- Esami: tentativi multipli, prove in itinere, ritirato/respinto/non superato, idoneità, lode 30/31 · **T**
- Medie ponderata/aritmetica, base di laurea, simulazione dei voti futuri, media necessaria per un obiettivo · **T B**
- Pagina corso (presenze, esame, argomenti di studio, materiali) e analytics presenza/voto/trend/semestri/studio con linguaggio non causale · **T B**

### Calendario
- Viste giorno/settimana/mese, filtri, colori, sovrapposizioni · **B** per la vista settimana; giorno e mese **non ancora ispezionate visivamente**
- Eventi personali con ricorrenze, eccezioni per occorrenza, "questa e successive", promemoria, scadenze con spunta · **T**
- Distinzione netta tra regole d'orario, occorrenze di lezione ed eventi personali · **T**

### Apple Calendar
- Motore di sincronizzazione per occorrenza, mappa, marcatore URL, riconciliazione se cambiano gli id, prevenzione duplicati, merge a tre vie, conflitti con scelta dell'utente, eventi eliminati in Apple, revoca dei permessi, trigger (store change, foreground, modifiche locali), eventi di terzi in sola lettura · **T** (contro `MockCalendarBridge`)
- Schermata Calendari: permessi, visibilità per calendario, calendario predefinito, pubblicazione lezioni, conflitti, possibili duplicati · **T** (logica) — UI non ispezionata visivamente
- Plugin Swift EventKit (`PRCDCalendar`) · **N**

### Documenti
- Cartelle annidate, import file e cartelle con gerarchia preservata, copia privata, rinomina/sposta/elimina con conferma, preferiti, tag, recenti, collegamento a corso, ricerca (nomi + testo note), drag & drop · **T**
- Selettore cartelle nativo (`PRCDFiles`) · **N**
- Lettore Markdown: GFM, frontmatter, KaTeX, highlighting, wiki-link e embed Obsidian, immagini relative, sanitizzazione · **T B**
- Lettore PDF: rendering virtualizzato, zoom/adatta larghezza, miniature, ricerca con evidenziazione, segnalibri, ultima posizione, modalità immersiva · **T** (logica) **B** (rendering)
- Note create in-app con editor semplice (le note importate sono sola lettura, rifiutato anche dal repository) · **T** (repository); editor **non ancora ispezionato visivamente**

### Altro
- Ricerca globale, impostazioni (9 categorie), notifiche locali di fine lezione (**N**), layout fluido con breakpoint ≤900 px.

## Limiti e punti aperti

**Nativo**
- Nulla del codice iOS è stato compilato o eseguito. Vedi la checklist in [IOS_BUILD.md](IOS_BUILD.md).
- La sincronizzazione Apple è stata provata solo contro il mock: il comportamento reale di EventKit (identificatori, eventi *all-day*, fusi orari, iCloud lento) va verificato su dispositivo.
- Se l'utente elimina il calendario "Procedo" in Calendario, ogni lezione pubblicata risulta "eliminata in Apple" e va risolta una per una (manca una scelta in blocco).

**Dati e prestazioni**
- sql.js riscrive l'intero database a ogni commit: ottimo per i metadati (pochi MB), da monitorare con molti anni di dati.
- Nessun FTS5: la ricerca usa `LIKE`; i PDF non sono indicizzati a livello di libreria (la ricerca nel PDF avviene nel lettore).
- Creazione e ripristino dell'archivio avvengono **interamente in memoria**: problematici per librerie da molti GB.
- I PDF si aprono da blob URL: su nativo il file viene letto in memoria.

**Funzionale**
- Importatore da **file JSON strutturato**: non implementato — si attende il formato che l'utente comunicherà.
- Gli eventi ricorrenti personali sono sincronizzati con Apple per occorrenza (finestra −30/+180 giorni), non come serie Apple.
- Le modifiche al titolo/note di un evento *lezione* fatte in Apple Calendario vengono ignorate (il titolo appartiene al corso).
- "Schermo intero" del PDF è una modalità immersiva (la Fullscreen API non esiste su iPad).
- Il backup notturno su iCloud del design non c'è (solo export manuale e snapshot locali).
- Le correlazioni statistiche richiedono esami superati **con presenze registrate nell'app**.
- Il layout per iPad verticale/Mac è un'interpretazione (artboard "Adattamenti" non rifinito) e va ricontrollato con le schermate del design.

**Scelte volontarie rispetto al design**
- Nessun campo aula/docente. Nome **PRCD.** e calendario "Procedo". Archivio `.prcd`. Lezioni bidirezionali con Apple.
