# Funzionalità implementate, verifiche e limiti

Legenda — **T** = coperto da test automatici (Vitest, nessun browser) · **B** = verificato a mano nel browser (Vite dev) · **N** = codice nativo scritto, **non compilato né eseguito** (nessun Xcode disponibile).

## Implementato

### Base
- App web offline (font, KaTeX, worker PDF e WASM nel bundle) · **B**
- Database SQLite con migrazioni, transazioni, validazione, persistenza dopo ogni commit; il dato sopravvive al ricaricamento della pagina · **T B**
- Persistenza IndexedDB con copia precedente (`db_prev`) nella stessa transazione e ripiego su di essa · **T**
- Backup/ripristino `.prcd` verificato, snapshot automatici, esportazioni CSV/ICS · **T**
- Scaffold Capacitor iOS (solo iPad), plugin Swift, permessi in `Info.plist` · **N**

### Università
- Semestri (crea, modifica, archivia), corsi (nome, colore, CFU, tipo esame), orario settimanale → **occorrenze con id permanente** · **T B**
- Modifica lezione con ambito esplicito (una / successive / tutto) e anteprima per lezione; annullamento, lezione extra, festività, eccezioni individuali; presenza mai azzerata · **T**, e **B**: split della regola, lezioni passate e presenze invariate, 8 eventi Apple aggiornati
- Presenze in 4 stati, registrazione rapida (tastiera P/A/R/T, ↑↓, tocco), percentuali, recuperi, soglia · **T B**
- Esami: tentativi multipli, prove in itinere, ritirato/respinto/non superato, idoneità, lode 30/31 · **T**
- Medie ponderata/aritmetica, base di laurea, simulazione dei voti futuri, media necessaria per un obiettivo · **T B** (numeri del design riprodotti: 26,42 / 26,33 / 96,9 / 56 CFU)
- Pagina corso (presenze, esame, argomenti di studio, materiali), analytics presenza/voto/trend/semestri/studio con linguaggio non causale · **T B**

### Calendario
- Viste giorno/settimana/mese, filtri, colori, sovrapposizioni · **B** (settimana e mese; la vista giorno condivide il codice della settimana ma non è stata ispezionata)
- Nuovo evento (creazione verificata, persistita) con ricorrenze, eccezioni per occorrenza, "questa e successive", promemoria, scadenze con spunta · **T B**

### Apple Calendar
- Motore di sincronizzazione per occorrenza: mappa, marcatore URL, riconciliazione se cambiano gli id, prevenzione duplicati, merge a tre vie, conflitti con scelta dell'utente, eventi eliminati in Apple, revoca permessi, trigger, eventi di terzi in sola lettura · **T** (contro `MockCalendarBridge`)
- Schermata Calendari con il mock (`?mockCalendar`): richiesta permesso → calendario "Procedo" → pubblicazione di 149 lezioni, tutte sincronizzate, nessun conflitto; rilevamento duplicati ("Dentista") · **B**
- Plugin Swift EventKit (`PRCDCalendar`) · **N**

### Documenti
- Cartelle annidate, import file/cartelle con gerarchia preservata, copia privata, rinomina/sposta/elimina con conferma, preferiti, tag, recenti, collegamento a corso, ricerca (nomi + testo note), drag & drop · **T**
- **Importazione guidata** (Scegli → Controlla → Fatto) con conteggi, collisioni, "mantieni la struttura", corso collegato: provata con una cartella simulata (gerarchia mantenuta, file nascosti e tipi non supportati saltati) · **B**
- Selettore cartelle nativo (`PRCDFiles`) · **N**
- Lettore Markdown: GFM, frontmatter, KaTeX, highlighting, wiki-link e embed Obsidian, immagini relative, sanitizzazione, indice con avanzamento e tempo di lettura, pannello Proprietà e "Note che citano questa", dimensione testo · **T B**
- Lettore PDF: rendering virtualizzato, zoom/adatta larghezza, cursore pagine, miniature, ricerca con evidenziazione, segnalibri, ultima posizione con avviso "Ripreso da p. N", modalità immersiva · **T** (logica) **B** (rendering di un PDF reale)
- Note create in-app con editor semplice; le note importate sono di sola lettura (anche il repository le rifiuta) · **T**; l'editor non è stato ispezionato visivamente

### Layout e tastiera
- Breakpoint del design (Adattamenti): >1000 barra fissa; 600–1000 barra a scomparsa con dashboard a righe per importanza; <600 barra a icone con monogrammi dei corsi · **B** (Oggi, Università, Presenze, Calendario in verticale; Oggi a 520 px)
- Scorciatoie ⌘/Ctrl: 1–5 sezioni, K ricerca, N nuovo evento, ⇧N nuova nota, R presenze, T calendario su oggi, \ barra laterale · **non provate nel browser**

### Altro
- Ricerca globale, impostazioni (9 categorie), notifiche locali di fine lezione (**N**).

## Scostamenti dal design (nominati, non decisioni nascoste)

Il brief chiede di non ridisegnare; questi punti del design **non** sono implementati o lo sono in forma diversa:

| Design | Stato |
|---|---|
| "Aula B2" nelle lezioni | **Rimosso di proposito** (il brief vieta aula/docente) |
| Nome "Libretto", estensione `.libretto` | **PRCD.**, `.prcd` (scelta dell'utente) |
| Lezioni in Apple "di sola lettura" | **Bidirezionali** (lo richiede il brief) |
| Importa: "Collega la cartella" (aggiornamento live da File) | Non implementato: solo **copia** (il brief la prevede per la prima versione) |
| Importa: passo "3 Collega ai corsi", conteggio link rotti, "Sostituisci" per file esistenti | Il corso si sceglie nel passo "Controlla"; link rotti non contati; si **tengono sempre entrambi** (mai sovrascrivere) |
| Annotazione con Apple Pencil (Markdown e PDF) | Non implementata |
| Gesti: bordo sinistro, pizzico settimana↔mese, trascinare eventi nel calendario | Non implementati (la barra si apre con il pulsante o ⌘\) |
| Ricerca ⌘K con sezione "PDF, nel testo" e "Azioni" | Cerca corsi, note (nome e testo), documenti, eventi; **niente testo dei PDF a livello di libreria**, niente azioni |
| Mac (>1400 pt): pannello contestuale sempre aperto, misura del testo fissa | Non implementato |
| Lettore Markdown: segmento "Leggi / Modifica", schermo intero | Solo il pulsante "Modifica" (note create in-app); schermo intero solo nel PDF (modalità immersiva) |
| Libretto: "Esporta PDF" | "Stampa o PDF" tramite la stampa del sistema (nessun generatore PDF dedicato) |
| Backup notturno su iCloud Drive | Non implementato: esportazione manuale + snapshot locali |
| Presenze: riquadro di notifica "Dalla notifica" illustrato | Sostituito da un testo; la notifica reale esiste solo nel nativo (**N**) |
| Layout a 1194×834 fissi | Rese **fluide**; in orizzontale coincidono con il design, il resto segue il testo di Adattamenti |

## Limiti e punti aperti

**Nativo**
- Nulla del codice iOS è stato compilato o eseguito. Vedi [IOS_BUILD.md](IOS_BUILD.md).
- La sincronizzazione Apple è stata provata solo contro il mock: il comportamento reale di EventKit (identificatori, eventi *all-day*, fusi orari, iCloud lento) va verificato su dispositivo.
- Se l'utente elimina il calendario "Procedo" in Calendario, ogni lezione pubblicata risulta "eliminata in Apple" e va risolta una per una (manca una scelta in blocco).

**Dati e prestazioni**
- sql.js riscrive l'intero database a ogni commit: ottimo per i metadati, da monitorare con molti anni di dati.
- Nessun FTS5: la ricerca usa `LIKE`.
- Creazione e ripristino dell'archivio avvengono **interamente in memoria**: problematici per librerie da molti GB.
- I PDF si aprono da blob URL: su nativo il file viene letto in memoria.

**Funzionale**
- **Importatore da file JSON strutturato**: non implementato — si attende il formato dell'utente.
- Eventi ricorrenti personali sincronizzati con Apple per occorrenza (finestra −30/+180 giorni), non come serie.
- Le modifiche al titolo/note di un evento *lezione* fatte in Apple vengono ignorate (il titolo appartiene al corso).
- Le correlazioni statistiche richiedono esami superati **con presenze registrate nell'app**.
- Il bundle principale è ~1,8 MB (nessun code-splitting ancora).
- Le scorciatoie ⌘ non sono state provate; su browser desktop alcune (Ctrl+N/T/R) sono riservate dal browser.
