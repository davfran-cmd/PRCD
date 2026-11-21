# Backup e ripristino

Tutti i dati sono locali: **il backup è responsabilità dell'utente** (nessun cloud). PRCD offre tre livelli.

## 1. Archivio completo `.prcd` (consigliato)

*Impostazioni → Dati e backup → Esporta.* Produce un file ZIP con:

| Voce | Contenuto |
|---|---|
| `manifest.json` | formato (`prcd-archive`), versione dell'archivio, versione dello schema, data, elenco dei file con dimensione e **SHA-256**, conteggi per tabella |
| `database.sqlite` | l'immagine completa del database |
| `data.json` | dump leggibile di tutte le tabelle (per ispezione o importazioni future) |
| `files/f/<uuid>` | ogni documento importato, byte per byte |

- Se un documento citato dal database manca nello storage, la creazione dell'archivio **fallisce con un messaggio** (non si produce mai un backup parziale in silenzio).
- Su web il file viene scaricato; su iPad si apre il foglio di condivisione (Salva in File, AirDrop…).

### Ripristino

*Impostazioni → Dati e backup → Scegli file.* Sequenza, **tutto o niente**:

1. Lettura e verifica completa dell'archivio **prima di toccare qualunque dato**: ZIP valido, manifest, versione dello schema non più recente dell'app, presenza e dimensione di ogni file, checksum SHA-256, apertura del database in memoria (con migrazione in avanti), `PRAGMA integrity_check`, controllo delle chiavi esterne, riferimenti dei documenti.
2. Una finestra mostra cosa contiene (corsi, lezioni, documenti, data) e chiede conferma: «Sostituisce i dati attuali».
3. Si salva uno **snapshot dei dati attuali** (`pre-restore-<data>`).
4. Si scrivono i file (additivo: le chiavi sono uuid), poi si sostituisce il database.

Se la verifica fallisce (file corrotto, non PRCD, da una versione futura…) compare l'errore e **non cambia nulla**, nemmeno lo snapshot.

## 2. Snapshot locali del database

Copie del solo database nel dispositivo (non includono i PDF):

- `auto-<giorno>`: uno al giorno all'avvio (se ci sono dati), ultimi 7;
- `pre-migration-v<N>`: prima di una migrazione;
- `pre-restore-<data>` e `pre-erase-<data>`: prima di un ripristino o di «Elimina tutti i dati».

Servono come rete di sicurezza contro errori. Non sono un backup contro la perdita del dispositivo.

## 3. Esportazioni per altri strumenti

- Presenze e esami in **CSV** (UTF-8 con BOM, campi protetti da formule per fogli di calcolo).
- Calendario in **.ics** (lezioni ed eventi; orari floating).

## Cancellazione totale

*Impostazioni → Dati e backup → Elimina…* richiede conferma, salva `pre-erase-<data>` e svuota database e file. I file originali in File/iCloud non vengono mai toccati.

## Test

`tests/backup.test.ts`: esportazione e ripristino byte per byte, snapshot di sicurezza, manifest e checksum, rifiuto di file corrotti/non validi/dal futuro senza modificare nulla, rifiuto di backup parziali, cancellazione con snapshot; `tests/documents.test.ts`: i documenti sopravvivono al ripristino.
