import { useEffect, useRef, useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { A, navigate } from '../app/router';
import { useNow, useQuery, useServices, useUi } from '../app/AppContext';
import { Btn, ConfirmDialog, Toggle } from '../ui/components';
import { st } from '../ui/style';
import { createArchive, eraseAllData, inspectArchive, restoreArchive } from '../db/backup';
import { attendanceCsv, calendarIcs, examsCsv } from '../db/exporters';
import { saveFile } from '../storage/saveFile';
import { addDays, formatDateMedium } from '../domain/dates';
import { SemestersModal } from './Universita';
import { APP_NAME } from '../domain/settings';
import { requestNotificationPermission } from '../app/notifications';
import { applyProcedoImport, planProcedoImport, type ProcedoPlan } from '../db/importProcedo';
import { Modal } from '../ui/components';

const CATS = [
  ['generale', 'Generale'],
  ['semestri', 'Semestri e orario'],
  ['presenze', 'Presenze'],
  ['esami', 'Esami e media'],
  ['calendari', 'Calendari'],
  ['documenti', 'Documenti'],
  ['dati', 'Dati e backup'],
  ['aspetto', 'Aspetto'],
  ['tastiera', 'Scorciatoie da tastiera'],
] as const;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
}

export function Impostazioni({ cat }: { cat: string }) {
  const active = (CATS.find((c) => c[0] === cat)?.[0] ?? 'generale') as (typeof CATS)[number][0];
  return (
    <div className="app">
      <Sidebar active="imp" />
      <nav aria-label="Categorie" className="scroll" style={st('width:230px;flex:none;border-right:1px solid #DCDCD6;padding:24px 12px;display:flex;flex-direction:column;gap:2px')}>
        <h1 style={st('margin:0 12px 14px;font-size:26px;font-weight:750;letter-spacing:-0.03em')}>Impostazioni</h1>
        {CATS.map(([k, l]) => (
          <button key={k} onClick={() => navigate(`/impostazioni/${k}`)} aria-current={active === k} style={{ display: 'flex', alignItems: 'center', height: 44, padding: '0 12px', borderRadius: 6, fontSize: 15, border: 0, background: active === k ? '#000' : 'transparent', color: active === k ? '#fff' : '#000', width: '100%', textAlign: 'left', fontWeight: active === k ? 600 : 400 }}>{l}</button>
        ))}
      </nav>
      <main className="main scroll" style={st('padding:28px 36px')}>
        <div style={st('max-width:640px')}>
          {active === 'generale' && <General />}
          {active === 'semestri' && <SemestriCat />}
          {active === 'presenze' && <Presenze />}
          {active === 'esami' && <Esami />}
          {active === 'calendari' && <CalendariCat />}
          {active === 'documenti' && <Documenti />}
          {active === 'dati' && <Dati />}
          {active === 'aspetto' && <Aspetto />}
          {active === 'tastiera' && <Tastiera />}
        </div>
      </main>
    </div>
  );
}

const H = ({ t, sub }: { t: string; sub?: string }) => (
  <>
    <h2 style={st('margin:0;font-size:30px;font-weight:750;letter-spacing:-0.03em')}>{t}</h2>
    {sub && <p className="mu" style={st('margin:6px 0 0')}>{sub}</p>}
    <div style={st('margin-top:20px;border-top:2px solid #000')} />
  </>
);

function SRow({ t, small, children }: { t: string; small?: string; children?: React.ReactNode }) {
  return (
    <div className="sr">
      <span className="t">{t}{small && <small>{small}</small>}</span>
      {children}
    </div>
  );
}

function General() {
  const { repo } = useServices();
  const sem = useQuery((r) => r.currentSemester());
  const settings = useQuery((r) => r.getSettings());
  return (
    <>
      <H t="Generale" sub={`${APP_NAME} funziona interamente su questo dispositivo. Nessun account, nessun server, nessuna analisi.`} />
      <SRow t="Semestre in corso" small={sem ? `${formatDateMedium(sem.startDate)} – ${formatDateMedium(sem.endDate)}` : 'Nessun semestre'}><b>{sem?.name ?? '–'}</b></SRow>
      <SRow t="Obiettivo di CFU" small="Per la barra di avanzamento del percorso"><span className="stp"><button aria-label="Diminuisci" onClick={() => repo.updateSettings({ degreeCfuTarget: Math.max(30, settings.degreeCfuTarget - 30) })}>−</button><span style={st('width:52px')}>{settings.degreeCfuTarget}</span><button aria-label="Aumenta" onClick={() => repo.updateSettings({ degreeCfuTarget: Math.min(360, settings.degreeCfuTarget + 30) })}>+</button></span></SRow>
      <SRow t="Versione" small="Dati salvati in locale, funzionamento offline"><span className="mu">0.1.0</span></SRow>
    </>
  );
}

function SemestriCat() {
  const ui = useUi();
  const semesters = useQuery((r) => r.semesters(), []);
  return (
    <>
      <H t="Semestri e orario" sub="Il semestre definisce le date entro cui l’orario ricorrente genera le lezioni." />
      {semesters.map((s) => <SRow key={s.id} t={s.name} small={`${formatDateMedium(s.startDate)} – ${formatDateMedium(s.endDate)}${s.archived ? ' · archiviato' : ''}`} />)}
      <SRow t="Gestisci semestri" small="Crea, modifica, archivia"><Btn onClick={() => ui.modal((close) => <SemestersModal onClose={close} />)}>Apri</Btn></SRow>
      <p className="mu" style={st('font-size:13px')}>Le modifiche all’orario si fanno dal calendario o dalla pagina del corso: una singola lezione, questa e le successive, oppure tutto l’orario.</p>
    </>
  );
}

function Presenze() {
  const { repo } = useServices();
  const ui = useUi();
  const s = useQuery((r) => r.getSettings());
  const set = repo.updateSettings.bind(repo);
  return (
    <>
      <H t="Presenze" sub="Come PRCD registra e conta le lezioni." />
      <SRow t="Soglia di presenza" small="Sotto questa percentuale il corso viene segnalato in arancio">
        <span className="stp"><button aria-label="Diminuisci" onClick={() => set({ attendanceThreshold: Math.max(0, s.attendanceThreshold - 5) })}>−</button><span style={st('width:56px')}>{s.attendanceThreshold}%</span><button aria-label="Aumenta" onClick={() => set({ attendanceThreshold: Math.min(100, s.attendanceThreshold + 5) })}>+</button></span>
      </SRow>
      <SRow t="Chiedi a fine lezione" small="Una notifica locale con Presente e Assente (solo nell’app per iPad)"><Toggle label="Chiedi a fine lezione" on={s.endOfLessonReminder} onChange={(v) => { set({ endOfLessonReminder: v }); if (v) void requestNotificationPermission().then((ok) => !ok && ui.toast('Le notifiche non sono disponibili o non sono state consentite.')); }} /></SRow>
      <SRow t="Le lezioni recuperate contano come presenze"><Toggle label="Recuperate contano come presenze" on={s.recoveredCountsAsAttended} onChange={(v) => set({ recoveredCountsAsAttended: v })} /></SRow>
      <SRow t="Escludi “da confermare” dalla percentuale" small="Le lezioni non registrate non contano finché non le confermi"><Toggle label="Escludi da confermare" on={s.excludeToConfirm} onChange={(v) => set({ excludeToConfirm: v })} /></SRow>
      <SRow t="Le lezioni annullate non contano"><Toggle label="Annullate non contano" on={s.excludeCancelled} onChange={(v) => set({ excludeCancelled: v })} /></SRow>
    </>
  );
}

function Esami() {
  const { repo } = useServices();
  const s = useQuery((r) => r.getSettings());
  return (
    <>
      <H t="Esami e media" sub="Come vengono calcolate le medie del libretto." />
      <SRow t="Valore della lode" small="Con 30 e lode, la media usa questo valore"><span className="seg">{[30, 31].map((v) => <button key={v} className={s.lodeValue === v ? 'on' : ''} onClick={() => repo.updateSettings({ lodeValue: v })}>{v}</button>)}</span></SRow>
      <SRow t="Scala del voto di laurea" small="Base di laurea = media ponderata × scala / 30"><span className="seg">{[110, 100].map((v) => <button key={v} className={s.graduationScale === v ? 'on' : ''} onClick={() => repo.updateSettings({ graduationScale: v })}>{v}</button>)}</span></SRow>
      <p className="mu" style={st('font-size:13px')}>Idoneità, tentativi non superati, ritirati o rifiutati e prove in itinere non entrano mai nelle medie.</p>
    </>
  );
}

function CalendariCat() {
  const cal = useQuery((r) => r.getSettings().appleCalendarEnabled);
  return (
    <>
      <H t="Calendari" sub="Calendario di Apple e categorie visibili." />
      <SRow t="Calendario di Apple" small={cal ? 'Integrazione attiva' : 'Integrazione non attiva'}><A to="/calendari" className="btn">Gestisci</A></SRow>
    </>
  );
}

function Documenti() {
  const { files, docs } = useServices();
  const [usage, setUsage] = useState<number | null>(null);
  const count = useQuery(() => docs.documents().length, []);
  useEffect(() => void files.usage().then(setUsage), [files, count]);
  return (
    <>
      <H t="Documenti" sub="Le copie importate vivono nella memoria privata dell’app; gli originali non vengono mai modificati." />
      <SRow t="Documenti importati" small={usage === null ? '' : fmtBytes(usage)}><b>{count}</b></SRow>
      <SRow t="Libreria"><A to="/documenti" className="btn">Apri</A></SRow>
    </>
  );
}

function Dati() {
  const { db, repo, files, docs } = useServices();
  const ui = useUi();
  const now = useNow();
  const settings = useQuery((r) => r.getSettings());
  const [usage, setUsage] = useState({ files: 0, db: 0, notes: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const procedoInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const docCount = useQuery(() => docs.documents().length, []);

  useEffect(() => {
    void files.usage().then((u) => {
      const notes = docs.documents({ kind: 'markdown' }).reduce((a, d) => a + d.size, 0);
      setUsage({ files: Math.max(0, u - notes), db: db.exportBytes().length, notes });
    });
  }, [files, db, docs, docCount]);

  const total = usage.files + usage.db + usage.notes || 1;
  const exportArchive = () =>
    ui.run(async () => {
      setBusy('Creo l’archivio…');
      try {
        const blob = await createArchive(db, files);
        await saveFile(`PRCD-${now.today}.prcd`, blob);
        repo.updateSettings({ lastBackupAt: new Date().toISOString() });
        ui.toast(`Archivio creato (${fmtBytes(blob.size)})`);
      } finally {
        setBusy(null);
      }
    });

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    await ui.run(async () => {
      setBusy('Verifico l’archivio…');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await inspectArchive(bytes); // throws on any problem, before touching data
      setBusy(null);
      ui.modal((close) => (
        <ConfirmDialog
          title="Ripristinare questo archivio?"
          body={`Contiene ${info.manifest.counts.courses ?? 0} corsi, ${info.manifest.counts.lessons ?? 0} lezioni e ${info.manifest.files.length} documenti, creato il ${formatDateMedium(info.manifest.createdAt.slice(0, 10))}. Sostituisce i dati attuali. Una copia dei dati di adesso viene conservata automaticamente.`}
          confirmLabel="Sostituisci i dati"
          danger
          onConfirm={() => void ui.run(async () => { setBusy('Ripristino…'); try { const r = await restoreArchive(db, files, bytes); ui.toast(`Ripristinati ${r.courses} corsi e ${r.files} documenti`); } finally { setBusy(null); } })}
          onClose={close}
        />
      ));
    });
    if (fileInput.current) fileInput.current.value = '';
  };

  const onPickProcedo = async (file: File | undefined) => {
    if (procedoInput.current) procedoInput.current.value = '';
    if (!file) return;
    await ui.run(async () => {
      const plan = planProcedoImport(await file.text(), repo); // read-only: throws on invalid files
      ui.modal((close) => <ProcedoImportModal plan={plan} fileName={file.name} onClose={close} />);
    });
  };

  return (
    <>
      <H t="Dati e backup" sub="Tutto è salvato solo su questo dispositivo. Nessun account, nessun server." />
      <div style={st('padding-top:14px')}>
        <div style={st('display:flex;justify-content:space-between;align-items:baseline')}><span style={st('font-size:28px;font-weight:750;letter-spacing:-0.03em')}>{fmtBytes(usage.files + usage.db + usage.notes)}</span><span className="mu" style={st('font-size:13px')}>{docCount} documenti</span></div>
        <div style={st('display:flex;height:10px;margin:10px 0 8px;gap:2px')}>
          <span style={{ flex: usage.files / total, background: '#000' }} /><span style={{ flex: usage.notes / total, background: '#1F35C7' }} /><span style={{ flex: usage.db / total, background: '#9A9A93' }} />
        </div>
        <div style={st('display:flex;gap:18px;font-size:13px;flex-wrap:wrap')}>
          <Leg c="#000" l={`PDF e immagini ${fmtBytes(usage.files)}`} /><Leg c="#1F35C7" l={`Note ${fmtBytes(usage.notes)}`} /><Leg c="#9A9A93" l={`Orari, presenze, esami ${fmtBytes(usage.db)}`} />
        </div>
      </div>
      <h3 style={st('margin:26px 0 6px;font-size:15px;font-weight:650')}>Backup</h3>
      <SRow t="Esporta un archivio completo" small={`Un file .prcd con dati, note e PDF${settings.lastBackupAt ? `. Ultimo: ${formatDateMedium(settings.lastBackupAt.slice(0, 10))}` : ''}`}><Btn disabled={!!busy} onClick={() => void exportArchive()}>Esporta</Btn></SRow>
      <SRow t="Ripristina da un archivio" small="Sostituisce i dati attuali dopo una conferma e un controllo di integrità"><Btn disabled={!!busy} onClick={() => fileInput.current?.click()}>Scegli file</Btn></SRow>
      <input ref={fileInput} type="file" accept=".prcd,.zip,application/zip" hidden onChange={(e) => void onPick(e.target.files?.[0])} />
      <SRow t="Importa un backup di Procedo" small="Il file procedo-backup-….json della vecchia app. Si aggiunge ai dati attuali: niente viene sovrascritto e reimportarlo non crea doppioni."><Btn disabled={!!busy} onClick={() => procedoInput.current?.click()}>Scegli file</Btn></SRow>
      <input ref={procedoInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onPickProcedo(e.target.files?.[0])} />
      {busy && <p className="mu" style={st('font-size:13px')}>{busy}</p>}
      <SRow t="Copie di sicurezza automatiche" small="PRCD conserva una copia del database all’avvio (una al giorno, le ultime 7) e prima di ogni aggiornamento o ripristino."><SnapshotsInfo /></SRow>
      <h3 style={st('margin:26px 0 6px;font-size:15px;font-weight:650')}>Esporta dati</h3>
      <SRow t="Presenze in CSV" small="Per un foglio di calcolo"><Btn onClick={() => void ui.run(() => saveFile(`presenze-${now.today}.csv`, new Blob([attendanceCsv(repo)], { type: 'text/csv' })))}>Esporta CSV</Btn></SRow>
      <SRow t="Esami in CSV"><Btn onClick={() => void ui.run(() => saveFile(`esami-${now.today}.csv`, new Blob([examsCsv(repo)], { type: 'text/csv' })))}>Esporta CSV</Btn></SRow>
      <SRow t="Calendario in formato .ics" small="Lezioni ed eventi dell’ultimo e del prossimo anno"><Btn onClick={() => void ui.run(() => saveFile(`prcd-${now.today}.ics`, new Blob([calendarIcs(repo, { from: addDays(now.today, -365), to: addDays(now.today, 365) })], { type: 'text/calendar' })))}>Esporta</Btn></SRow>
      <h3 style={st('margin:26px 0 6px;font-size:15px;font-weight:650;color:#B23A0A')}>Zona irreversibile</h3>
      <SRow t="Elimina tutti i dati" small="Orari, presenze, esami, note e documenti importati. Una copia di sicurezza dei dati resta nel dispositivo.">
        <Btn style={st('color:#B23A0A;border-color:#C2410C')} onClick={() => ui.modal((close) => <ConfirmDialog title="Eliminare tutti i dati?" body="Verranno eliminati corsi, presenze, esami, eventi e documenti importati da questo dispositivo. Una copia di sicurezza del database viene conservata (non i file importati): esporta prima un archivio se vuoi poter tornare indietro." confirmLabel="Elimina tutto" danger onConfirm={() => void ui.run(async () => { await eraseAllData(db, files); ui.toast('Dati eliminati'); navigate('/oggi'); })} onClose={close} />)}>Elimina…</Btn>
      </SRow>
    </>
  );
}

function Leg({ c, l }: { c: string; l: string }) {
  return <span style={st('display:flex;align-items:center;gap:6px')}><span style={{ width: 10, height: 10, background: c }} />{l}</span>;
}

function SnapshotsInfo() {
  const { db } = useServices();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => void db.persistence.listSnapshots().then((l) => setN(l.length)), [db]);
  return <span className="mu">{n ?? '–'} copie</span>;
}

function Aspetto() {
  return (
    <>
      <H t="Aspetto" sub="Carta bianca, inchiostro nero, un solo colore d’azione." />
      <SRow t="Tema" small="Il design di PRCD è unico e non cambia con il tema del sistema."><span className="mu">Chiaro</span></SRow>
      <SRow t="Dimensioni del testo" small="Segue le impostazioni di Accessibilità del dispositivo."><span className="mu">Automatico</span></SRow>
    </>
  );
}

function Tastiera() {
  return (
    <>
      <H t="Scorciatoie da tastiera" sub="Con una tastiera collegata." />
      <SRow t="Registra presenze: Presente / Assente / Recuperata / Da confermare"><b>P · A · R · T</b></SRow>
      <SRow t="Registra presenze: riga successiva o precedente"><b>↓ · ↑</b></SRow>
      <SRow t="Chiudere un foglio o una finestra"><b>Esc</b></SRow>
      <SRow t="Lettore PDF: pagina successiva o precedente"><b>→ · ←</b></SRow>
    </>
  );
}

function ProcedoImportModal({ plan, fileName, onClose }: { plan: ProcedoPlan; fileName: string; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const [working, setWorking] = useState(false);
  const c = plan.counts;
  const nothing = c.semesters + c.courses + c.lessons + c.exams === 0;
  const go = () =>
    void ui.run(async () => {
      setWorking(true);
      try {
        const r = await applyProcedoImport(plan, repo);
        onClose();
        ui.toast(`Importati ${r.courses} corsi, ${r.lessons} lezioni e ${r.attempts} esiti d’esame da Procedo`);
        navigate('/universita');
      } finally {
        setWorking(false);
      }
    });
  return (
    <Modal title="Importa da Procedo" onClose={onClose} width={580} actions={<Btn variant="p" disabled={working || nothing} onClick={go}>{working ? 'Importo…' : 'Importa'}</Btn>}>
      <div style={st('padding:16px 28px 24px')}>
        <div style={st('font-weight:650')}>{fileName}</div>
        {plan.exportedAt && <div className="mu" style={st('font-size:13px')}>esportato il {formatDateMedium(plan.exportedAt.slice(0, 10))}</div>}
        <div style={st('display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:12px;border-top:2px solid #000')}>
          {([[c.semesters, 'semestri nuovi'], [c.courses, 'corsi nuovi'], [c.lessons, 'lezioni nuove'], [c.exams, 'esami nuovi']] as Array<[number, string]>).map(([n, l]) => (
            <div key={l} style={st('padding:10px 0')}><div style={st('font-size:28px;font-weight:750;letter-spacing:-0.03em')}>{n}</div><div className="mu" style={st('font-size:13px')}>{l}</div></div>
          ))}
        </div>
        {c.alreadyImported > 0 && <p className="mu" style={st('font-size:13px;margin:6px 0 0')}>{c.alreadyImported} elementi erano già stati importati: restano come sono.</p>}
        {nothing && <p style={st('font-size:14px')}>Non c’è niente di nuovo da importare.</p>}
        <p style={st('font-size:14px;margin:14px 0 0')}>Le lezioni di Procedo non hanno un orario: arrivano come lezioni “di giornata” con la loro presenza. Puoi aggiungere l’orario settimanale dalla pagina del corso.</p>
        {plan.warnings.length > 0 && (
          <details style={st('margin-top:12px;font-size:13px')} open={plan.warnings.length <= 4}><summary>{plan.warnings.length} avvisi</summary>
            <ul style={st('padding-left:18px;max-height:140px;overflow:auto;margin:6px 0 0')}>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}
        {plan.notImported.length > 0 && (
          <details style={st('margin-top:8px;font-size:13px')}><summary>Cosa non viene importato</summary>
            <ul style={st('padding-left:18px;margin:6px 0 0')}>{plan.notImported.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}
        <p className="mu" style={st('font-size:12px;margin:14px 0 0')}>Prima di importare, PRCD salva una copia dei dati attuali. L’operazione è tutto o niente.</p>
      </div>
    </Modal>
  );
}
