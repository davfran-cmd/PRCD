# Installare l'app vera su iPad con Sideloadly (senza Mac, gratis)

L'app nativa (con Calendario di Apple, notifiche "Eri a lezione?", selettore di cartelle e dati che Safari non può cancellare) viene **compilata da GitHub** su un Mac in cloud a ogni push sul ramo `main` (workflow `.github/workflows/ipad-app.yml`). Il risultato è un file **`PRCD.ipa` non firmato**: Sideloadly lo firma con il tuo Apple ID gratuito e lo installa sull'iPad.

## Cosa serve (una volta)

1. **iTunes per Windows** dal sito di Apple (non la versione del Microsoft Store) e **iCloud per Windows**: Sideloadly ne usa i driver per parlare con l'iPad.
2. **Sideloadly** da sideloadly.io.
3. Un **Apple ID** (va bene quello di sempre; se preferisci, creane uno solo per questo).
4. Il cavo per collegare l'iPad al PC.

## Installare

1. Scarica l'ultima versione: pagina del repository → **Releases** → **App iPad (ultima versione)** → `PRCD.ipa`
   (`https://github.com/davfran-cmd/PRCD/releases/tag/ipad-latest`).
2. Collega l'iPad al PC, sbloccalo e tocca **Autorizza** se lo chiede.
3. Apri Sideloadly: trascina `PRCD.ipa` nella finestra, scegli l'iPad, scrivi l'Apple ID, premi **Start** e inserisci la password (ed eventualmente il codice a due fattori) quando lo chiede.
4. Sull'iPad: **Impostazioni → Generali → VPN e gestione dispositivi** → tocca il tuo Apple ID → **Autorizza**.
5. Solo la prima volta, da iPadOS 16: **Impostazioni → Privacy e sicurezza → Modalità sviluppatore → attiva** e riavvia l'iPad.

## Ogni 7 giorni

Con un Apple ID gratuito la firma dura **7 giorni**: dopo, l'app non si apre più finché non la rifirmi. **I dati restano**: ricollega l'iPad e ripeti il punto 3 con lo stesso file (o con la versione più nuova). Sideloadly può farlo da solo se lasci attiva l'opzione di rinnovo automatico con PC e iPad sulla stessa rete Wi‑Fi.

Altri limiti dell'Apple ID gratuito: al massimo 3 app installate così contemporaneamente.

## Portare i dati dalla web app

L'app vera ha una memoria **separata** da quella della web app di Safari.

1. Nella web app (icona sulla Home): **Impostazioni → Dati e backup → Esporta** → salva il file `.prcd` in File.
2. Nell'app vera: **Impostazioni → Dati e backup → Ripristina da un archivio** → scegli quel file.

Oppure reimporta il backup di Procedo nell'app vera.

## Aggiornare

A ogni modifica pubblicata, dopo circa 10 minuti la release `ipad-latest` contiene la nuova `PRCD.ipa`. Reinstallala con Sideloadly sopra quella vecchia: i dati restano (stesso Apple ID, stesso identificativo dell'app).

## Stato onesto

La compilazione su GitHub controlla che il codice Swift compili; il comportamento sull'iPad (permesso del Calendario, eventi reali, notifiche, selettore di cartelle, salvataggio dei dati) si verifica solo installandola: segui la checklist in [IOS_BUILD.md](IOS_BUILD.md).
