# Importare un backup di Procedo

*Impostazioni → Dati e backup → Importa un backup di Procedo → Scegli file* (`procedo-backup-AAAA-MM-GG.json`). Anche dalla schermata iniziale vuota.

Codice: [`src/db/importProcedo.ts`](../src/db/importProcedo.ts) · test: [`tests/importProcedo.test.ts`](../tests/importProcedo.test.ts) (usa l'esempio ufficiale in `tests/fixtures/procedo-backup-example.json`).

## Come funziona

1. **Anteprima, senza scrivere nulla** (`planProcedoImport`): legge il file, applica le regole di `migrate()` di Procedo, valida, mappa e mostra quanti semestri, corsi, lezioni ed esami sono *nuovi*, gli avvisi e cosa non verrà importato.
2. **Import** (`applyProcedoImport`): snapshot del database (`pre-import-procedo-<data>`), poi **una sola transazione** — o tutto o niente.
3. **Si aggiunge, non sostituisce.** Ogni id di Procedo viene registrato nella tabella `import_map`: reimportare lo stesso file (o un backup più recente) aggiunge solo ciò che è nuovo e **non modifica** quello che esiste già, comprese le presenze cambiate nel frattempo in PRCD.

Sono accettate entrambe le forme del file: `{ app: "procedo", state: {…} }` e l'oggetto `state` nudo. Vengono rifiutati: file non JSON, file di un'altra app, `semesters`/`courses` che non sono array, versione dello schema > 1.

## Mappatura

| Procedo | PRCD | Note |
|---|---|---|
| `semester.title` + `year` | nome ("1° Semestre 2026/2027") | |
| `semester.start` | inizio | se manca: prima lezione, poi `createdAt` |
| — | fine | Procedo non la registra: ultima lezione/`autoUntil`, ma almeno 16 settimane |
| `semester.status` | `archived` → archiviato; il primo `current` → semestre in corso | |
| `course.name`, `tint`, `cfu` | nome, colore, CFU | colore non valido → colore della palette; `cfu: ""` → 0 |
| `course.days` + `autoUntil` | il corso **continua** nei suoi giorni | come l'`auto` di Procedo: dal giorno dopo l'ultima lezione registrata a fine semestre, lezioni "di giornata" senza orario (regole con `time_unknown`, schema v3). Anche reimportando lo stesso file, per i corsi importati prima che non hanno ancora un orario |
| `course.prof`, `code` | **non importati** | PRCD non ha docenti/aule; la sigla è calcolata dal nome |
| `lesson.date`, `topic` | lezione con data e argomento | senza orario: compare come lezione "di giornata" finché non le dai un orario (qualsiasi modifica di data/ora la rende normale) |
| `lesson.p` | `S` → presente · `M` → assente (da recuperare) · `R` → recuperata | `chk: true` → da confermare |
| `lesson.a`, `study`, `auto`, `t` | non importati | |
| `exam` con `courseId` di un corso importato | esito sul corso | CFU e tipo dell'esame prevalgono (il libretto li usa) |
| `exam` senza corso | nuovo corso nel semestre archiviato "Esami importati da Procedo" | |
| `exam.status: passed`, `grade` | tentativo superato e accettato | **31 = 30 e lode**; voti fuori 18–31 → esame saltato con avviso |
| `exam.kind: idoneita` | esame di idoneità (senza voto, non fa media) | `kind` mancante → `voto` |
| `exam.status: todo` con data futura | tentativo "in programma" | senza data: il corso resta "da sostenere" |
| `exam.sim` | non importato | la simulazione in PRCD non si salva |
| `degreeCfu` | obiettivo di CFU | |
| `theme`, `remind`, `remindDays`, `auto`, `autoP`, `target`, `degreeSet` | non importati | elencati nell'anteprima |

Esami senza `id` vengono scartati (come in Procedo); un secondo esito "superato" per lo stesso corso viene saltato con avviso; se in PRCD il corso ha già un esito accettato, non viene sovrascritto.
