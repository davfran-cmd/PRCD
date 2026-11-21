import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { Btn, Modal, Toggle } from '../../ui/components';
import { st } from '../../ui/style';
import { entriesFromDrop, entriesFromFileList, pickFolderNative, canPickFolderNatively } from '../../documents/importSources';
import { isIgnoredPath, isImportable, type ImportEntry, type ImportReport } from '../../documents/docsRepo';
import { navigate } from '../../app/router';

export const canPickFolderNative = canPickFolderNatively;

type Pending = { entries: ImportEntry[]; label: string; cleanup?: () => Promise<void> };

/**
 * Import wizard (design: Importa): 1 Scegli → 2 Controlla → fatto.
 * Files are COPIED into the app's private storage; originals are never modified. The folder hierarchy is
 * preserved unless the user turns that off; name collisions never overwrite (the newcomer gets " (2)").
 */
export function ImportModal({ folderId, courseId, dropped, onClose }: { folderId: string | null; courseId: string | null; dropped?: DataTransfer; onClose: () => void }) {
  const { docs } = useServices();
  const ui = useUi();
  const courses = useQuery((r) => r.courses(), []);
  const [pending, setPending] = useState<Pending | null>(null);
  const [keepStructure, setKeepStructure] = useState(true);
  const [course, setCourse] = useState<string | null>(courseId);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const stage = report ? 3 : pending ? 2 : 1;
  const busy = progress !== null && !report;

  const choose = (entries: ImportEntry[], label: string, cleanup?: () => Promise<void>) => {
    setError(null);
    if (!entries.length) return void setError('Non ho trovato file da importare.');
    setPending({ entries, label, cleanup });
  };

  useEffect(() => {
    if (!dropped || started.current) return; // guard: StrictMode runs effects twice in development
    started.current = true;
    void entriesFromDrop(dropped).then((e) => choose(e, 'File trascinati'));
  }, [dropped]);

  const stats = useMemo(() => {
    if (!pending) return null;
    const s = { pdfs: 0, ignored: 0, collisions: 0 };
    const prefix = [...docs.folderPath(folderId).map((f) => f.name)].join('/');
    const existing = new Set(docs.pathIndex().map((e) => e.path.toLowerCase()));
    for (const e of pending.entries) {
      if (isIgnoredPath(e.path)) {
        s.ignored += 1;
        continue;
      }
      const ok = isImportable(e.path);
      if (ok) s.pdfs += 1;
      else s.ignored += 1;
      const rel = keepStructure ? e.path : e.path.split('/').pop()!;
      if (ok && existing.has((prefix ? `${prefix}/${rel}` : rel).toLowerCase())) s.collisions += 1;
    }
    return s;
  }, [pending, docs, folderId, keepStructure]);

  const importable = stats ? stats.pdfs : 0;

  const run = async () => {
    if (!pending) return;
    setProgress({ done: 0, total: importable });
    try {
      const entries = keepStructure ? pending.entries : pending.entries.map((e) => ({ ...e, path: e.path.split('/').pop() as string }));
      const r = await docs.importTree(entries, { parentFolderId: folderId, courseId: course, onProgress: (done, total) => setProgress({ done, total }) });
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      await pending.cleanup?.();
    }
  };

  const pickFolder = async () => {
    if (canPickFolderNatively()) {
      await ui.run(async () => {
        const res = await pickFolderNative();
        if (res) choose(res.entries.map((e) => ({ ...e, path: `${res.name}/${e.path}` })), res.name, res.cleanup);
      });
    } else dirInput.current?.click();
  };

  const cancel = () => {
    void pending?.cleanup?.();
    onClose();
  };

  return (
    <Modal title="Importa" onClose={cancel} width={600} actions={stage === 2 && !busy ? <Btn variant="p" disabled={!importable} onClick={() => void run()}>Importa {importable} file</Btn> : undefined}>
      <ol style={st('list-style:none;margin:0;padding:12px 24px;display:flex;gap:22px;font-size:14px;border-bottom:1px solid #EBEBE6')} aria-label="Passaggi">
        {['Scegli', 'Controlla', 'Fatto'].map((l, i) => (
          <li key={l} className={stage === i + 1 ? '' : 'mu'} style={{ fontWeight: stage === i + 1 ? 700 : 400, borderBottom: stage === i + 1 ? '2px solid #000' : '2px solid transparent' }}>{i + 1} {l}</li>
        ))}
      </ol>
      <div style={st('padding:18px 28px 26px')}>
        {stage === 1 && (
          <>
            <p style={st('margin:0 0 14px;font-size:14px;color:#3A3A36')}>PRCD importa i <b>PDF</b>. I file vengono <b>copiati</b> nella memoria dell’app: gli originali in File non vengono mai modificati.</p>
            <div style={st('display:flex;flex-direction:column;gap:8px')}>
              <Btn size="lg" variant="p" onClick={() => filesInput.current?.click()}>Scegli PDF</Btn>
              <Btn size="lg" onClick={() => void pickFolder()}>Scegli una cartella (solo i PDF)</Btn>
            </div>
            <p className="mu" style={st('font-size:12px;margin:14px 0 0')}>Si possono anche trascinare PDF e cartelle sulla finestra Documenti. Tutto ciò che non è un PDF viene saltato.</p>
            {error && <p style={st('color:#B23A0A;font-size:13px')}>{error}</p>}
          </>
        )}

        {stage === 2 && pending && stats && !busy && (
          <>
            <div style={st('font-weight:650')}>{pending.label}</div>
            <div style={st('display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin-top:12px;border-top:2px solid #000')}>
              <Count n={stats.pdfs} l="PDF" /><Count n={stats.ignored} l="saltati (non PDF o nascosti)" dim />
            </div>
            {stats.collisions > 0 && (
              <div className="sr"><span style={st('width:8px;height:8px;border-radius:4px;background:#C2410C;flex:none')} /><span className="t">{stats.collisions} {stats.collisions === 1 ? 'file esiste già' : 'file esistono già'} con lo stesso nome<small>Niente viene sovrascritto: i nuovi arrivano come copia, “nome (2)”.</small></span></div>
            )}
            <div style={st('margin-top:14px;font-size:14px;font-weight:650')}>Come importare</div>
            <div className="sr"><span className="t">Mantieni la struttura delle cartelle<small>Se disattivato, tutti i file vanno nella cartella di destinazione.</small></span><Toggle on={keepStructure} onChange={setKeepStructure} label="Mantieni la struttura delle cartelle" /></div>
            <div className="sr"><span className="t">Collega i documenti a un corso<small>Facoltativo.</small></span>
              <select className="in" aria-label="Corso" value={course ?? ''} onChange={(e) => setCourse(e.target.value || null)} style={st('min-width:200px')}>
                <option value="">Nessun corso</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <p className="mu" style={st('font-size:13px;margin:10px 0 0')}>Copia indipendente, salvata solo su questo dispositivo. Il collegamento “live” a una cartella di File non è previsto: per aggiornare un PDF, reimportalo.</p>
            {error && <p style={st('color:#B23A0A;font-size:13px')}>{error}</p>}
          </>
        )}

        {busy && progress && (
          <div>
            <div style={st('font-weight:650;margin-bottom:8px')}>Importo… {progress.done} di {progress.total}</div>
            <div style={st('height:6px;background:#EBEBE6;border-radius:3px')}><div style={{ height: 6, width: `${(progress.done / Math.max(1, progress.total)) * 100}%`, background: '#000', borderRadius: 3 }} /></div>
            <p className="mu" style={st('font-size:13px')}>L’importazione non blocca l’app.</p>
          </div>
        )}

        {stage === 3 && report && (
          <div>
            <div style={st('font-size:22px;font-weight:750;letter-spacing:-0.02em')}>{report.added} {report.added === 1 ? 'documento importato' : 'documenti importati'}</div>
            <p className="mu" style={st('font-size:14px;margin:4px 0 0')}>{report.folders} {report.folders === 1 ? 'cartella creata' : 'cartelle create'}{report.renamed.length ? `, ${report.renamed.length} rinominati per evitare sovrascritture` : ''}.</p>
            {report.skipped.length > 0 && (
              <details style={st('margin-top:12px;font-size:13px')}><summary>{report.skipped.length} file saltati</summary>
                <ul style={st('padding-left:18px;max-height:140px;overflow:auto')}>{report.skipped.slice(0, 100).map((s) => <li key={s.path}>{s.path} <span className="mu">({s.reason})</span></li>)}</ul>
              </details>
            )}
            {report.errors.length > 0 && <div className="banner" role="alert" style={st('margin-top:12px;font-size:13px')}><b>{report.errors.length} file non importati</b><ul style={st('padding-left:18px;margin:4px 0 0')}>{report.errors.slice(0, 20).map((e) => <li key={e.path}>{e.path}: {e.error}</li>)}</ul></div>}
            <div style={st('display:flex;gap:8px;margin-top:16px')}>
              <Btn variant="p" onClick={() => { onClose(); if (report.rootFolderId) navigate(`/documenti?f=${report.rootFolderId}`); }}>Fine</Btn>
            </div>
          </div>
        )}

        <input ref={filesInput} type="file" multiple hidden accept=".pdf,application/pdf" onChange={(e) => e.target.files && choose(entriesFromFileList(e.target.files), `${e.target.files.length} file`)} />
        <input ref={dirInput} type="file" hidden {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { const f = e.target.files; if (f && f.length) choose(entriesFromFileList(f), (f[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0] || 'Cartella'); }} />
      </div>
    </Modal>
  );
}

function Count({ n, l, dim }: { n: number; l: string; dim?: boolean }) {
  return (
    <div style={st('padding:10px 0')}>
      <div style={{ fontSize: 28, fontWeight: 750, letterSpacing: '-0.03em', color: dim ? '#9A9A93' : '#000' }}>{n}</div>
      <div className="mu" style={st('font-size:13px')}>{l}</div>
    </div>
  );
}
