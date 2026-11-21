# Provare PRCD su iPad come web app (GitHub Pages + Safari)

Il repository contiene già tutto: a ogni push sul ramo `main`, GitHub esegue i test, costruisce l'app e la pubblica su GitHub Pages (workflow `.github/workflows/deploy-pages.yml`). L'app funziona offline dopo la prima apertura (service worker generato in `vite.config.ts`).

> I tuoi dati **non** vanno su GitHub: il repository contiene solo il codice. Corsi, presenze, esami e documenti restano nella memoria di Safari sull'iPad.

## 1. Crea il repository e carica il codice (una volta)

1. Su github.com: **New repository** → nome per esempio `prcd` → **non** aggiungere README, .gitignore o licenza → *Create repository*.
   - **Pubblico o privato?** GitHub Pages è gratuito sui repository **pubblici**. Su un repository privato serve un piano a pagamento (GitHub Pro). Il codice diventa visibile a chi conosce l'indirizzo del repository; i dati no.
2. Dal PC, nella cartella del progetto (sostituisci `TUO-UTENTE`):

```powershell
cd D:\Progetti\ClaudeCode\PRCD
git branch -M main
git remote add origin https://github.com/TUO-UTENTE/prcd.git
git push -u origin main
```

3. Su GitHub, nel repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Scheda **Actions**: il workflow "Web app su GitHub Pages" parte (o rilancialo con *Run workflow*). Dopo 1–2 minuti l'indirizzo è
   `https://TUO-UTENTE.github.io/prcd/`

Gli aggiornamenti successivi: `git push` e basta. Se un test fallisce, la pubblicazione non avviene (resta online la versione precedente).

## 2. Installala sull'iPad

1. Apri l'indirizzo in **Safari** (non in un'altra app).
2. Pulsante **Condividi → Aggiungi alla schermata Home**.
3. Apri PRCD **dall'icona** sulla Home, non dalla scheda di Safari.

Perché è importante: per i normali siti Safari può **cancellare i dati** se non li visiti per 7 giorni. Le web app aggiunte alla Home non hanno questo limite. Inoltre dalla Home l'app è a tutto schermo e funziona in modalità aereo.

Nota: i dati della web app in Home sono separati da quelli della scheda di Safari. Usa sempre l'icona.

## 3. Porta dentro i tuoi dati di Procedo

1. Metti `procedo-backup-AAAA-MM-GG.json` in File (iCloud Drive o "Sul mio iPad").
2. In PRCD: **Impostazioni → Dati e backup → Importa un backup di Procedo → Scegli file**, controlla l'anteprima, **Importa**.

## 4. Backup

Su iPad i dati vivono solo lì. Ogni tanto: **Impostazioni → Dati e backup → Esporta** → *Salva in File*. Il file `.prcd` contiene tutto (anche i PDF) e si ripristina dalla stessa pagina.

## Cosa funziona e cosa no nella versione web

| Funziona | Non disponibile sul web |
|---|---|
| Tutto: università, presenze, esami, calendario, documenti, Markdown, PDF, backup, import Procedo, offline | **Calendario di Apple** (EventKit esiste solo nell'app nativa: la schermata Calendari lo spiega) |
| Import di file (PDF, note, immagini) dal selettore di File | **Import di una cartella intera**: Safari su iPad non permette di scegliere cartelle; si possono selezionare più file insieme |
| | Notifiche "Eri a lezione?" (solo app nativa) |

## Se qualcosa non va

- **Vedo una versione vecchia dopo un aggiornamento:** chiudi l'app (scorri via dal multitasking) e riaprila: la nuova versione si attiva al riavvio.
- **Pagina bianca o errore all'apertura:** controlla che il workflow sia verde in *Actions* e che Pages usi "GitHub Actions" come sorgente.
- **Errore "Non riesco ad aprire il database locale":** i dati non vengono toccati; prova a riaprire. Se persiste, mandami il testo del messaggio.
