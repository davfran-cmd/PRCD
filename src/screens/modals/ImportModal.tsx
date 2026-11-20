import { useEffect, useRef, useState } from 'react';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { Btn, Modal } from '../../ui/components';
import { st } from '../../ui/style';
import { entriesFromDrop, entriesFromFileList, pickFolderNative, canPickFolderNatively } from '../../documents/importSources';
import type { ImportEntry, ImportReport } from '../../documents/docsRepo';
import { navigate } from '../../app/router';

export const canPickFolderNative = canPickFolderNatively;

/** Import files or a whole folder/vault. Originals are copied, never modified; the hierarchy is preserved. */
export function ImportModal({ folderId, courseId, dropped, onClose }: { folderId: string | null; courseId: string | null; dropped?: DataTransfer; onClose: () => void }) {
  const { docs } = useServices();
  const ui = useUi();
  const courses = useQuery((r) => r.courses(), []);
  const [course, setCourse] = useState<string | null>(courseId);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const busy = progress !== null && !report;

  const run = async (entries: ImportEntry[], cleanup?: () => Promise<void>) => {
    setError(null);
    if (!entries.length) return void setError('Non ho trovato file da importare.');
    setProgress({ done: 0, total: entries.length });
    try {
      const r = await docs.importTree(entries, { parentFolderId: folderId, courseId: course, onProgress: (done, total) => setProgress({ done, total }) });
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      await cleanup?.();
    }
  };

  useEffect(() => {
    if (dropped) void entriesFromDrop(dropped).then((e) => run(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFolder = async () => {
    if (canPickFolderNatively()) {
      await ui.run(async () => {
        const res = await pickFolderNative();
        if (res) await run(res.entries.map((e) => ({ ...e, path: `${res.name}/${e.path}` })), res.cleanup);
      });
    } else dirInput.current?.click();
  };

  return (
    <Modal title="Importa" onClose={onClose} width={560}>
      <div style={st('padding:18px 28px 26px')}>
        {!progress && !report && (
          <>
            <p style={st('margin:0 0 14px;font-size:14px;color:#3A3A36')}>I file vengono <b>copiati</b> nella memoria dell’app: gli originali in File non vengono mai modificati. Le cartelle mantengono la loro gerarchia; immagini e note collegate restano insieme, così i riferimenti relativi continuano a funzionare.</p>
            <div style={st('display:flex;flex-direction:column;gap:8px')}>
              <Btn size="lg" variant="p" onClick={() => filesInput.current?.click()}>Scegli file (PDF, note, immagini)</Btn>
              <Btn size="lg" onClick={() => void pickFolder()}>Scegli una cartella o un vault Obsidian</Btn>
            </div>
            <label style={st('display:block;font-size:13px;margin-top:16px')}>Collega i documenti a un corso (facoltativo)
              <select className="in" style={st('width:100%;margin-top:4px')} value={course ?? ''} onChange={(e) => setCourse(e.target.value || null)}>
                <option value="">Nessun corso</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <p className="mu" style={st('font-size:12px;margin:14px 0 0')}>Si possono anche trascinare file e cartelle sulla finestra Documenti. Vengono saltati file nascosti (.obsidian, .git, .DS_Store) e tipi non supportati.</p>
            {error && <p style={st('color:#B23A0A;font-size:13px')}>{error}</p>}
          </>
        )}
        {progress && !report && (
          <div>
            <div style={st('font-weight:650;margin-bottom:8px')}>Importo… {progress.done} di {progress.total}</div>
            <div style={st('height:6px;background:#EBEBE6;border-radius:3px')}><div style={{ height: 6, width: `${(progress.done / Math.max(1, progress.total)) * 100}%`, background: '#000', borderRadius: 3 }} /></div>
            <p className="mu" style={st('font-size:13px')}>{busy ? 'Puoi continuare a usare l’app: l’importazione non blocca nulla.' : ''}</p>
          </div>
        )}
        {report && (
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
        <input ref={filesInput} type="file" multiple hidden accept=".md,.markdown,.pdf,image/*" onChange={(e) => e.target.files && void run(entriesFromFileList(e.target.files))} />
        <input ref={dirInput} type="file" hidden {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => e.target.files && void run(entriesFromFileList(e.target.files))} />
      </div>
    </Modal>
  );
}
