import { useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { navigate, useRoute } from '../app/router';
import { useQuery, useServices, useUi } from '../app/AppContext';
import { Btn, ConfirmDialog, Empty, Icon, Modal, Swatch } from '../ui/components';
import { st } from '../ui/style';
import { formatDateMedium } from '../domain/dates';
import type { DocumentRecord, Folder } from '../domain/types';
import { canPickFolderNative, ImportModal } from './modals/ImportModal';

type Filter = 'tutto' | 'recenti' | 'preferiti' | string; // string = #tag

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
}

export function Documenti() {
  const { docs } = useServices();
  const ui = useUi();
  const route = useRoute();
  const folderId = route.query.get('f') || null;
  const courseFilter = route.query.get('corso');
  const [filter, setFilter] = useState<Filter>('tutto');
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const path = useQuery(() => docs.folderPath(folderId), [folderId]);
  const tags = useQuery(() => docs.allTags(), []);
  const course = useQuery((r) => (courseFilter ? r.course(courseFilter) : undefined), [courseFilter]);
  const courses = useQuery((r) => new Map(r.courses({ includeArchived: true, includeHidden: true }).map((c) => [c.id, c])), []);

  // Miller columns: root, then the children of every folder on the current path.
  const columns = useQuery(() => {
    const ids: Array<string | null> = [null, ...path.map((f) => f.id)];
    return ids.map((pid) => ({ parent: pid, folders: docs.folders(pid) }));
  }, [folderId]);
  const listing = useQuery(() => {
    if (q.trim()) return docs.documents({ query: q });
    if (course) return docs.documents({ courseId: course.id });
    if (filter === 'recenti') return docs.documents({ recent: true }).slice(0, 40);
    if (filter === 'preferiti') return docs.documents({ favorite: true });
    if (filter.startsWith('#')) return docs.documents({ tag: filter });
    return docs.documents({ folderId });
  }, [folderId, filter, q, courseFilter]);
  const selected = listing.find((d) => d.id === selId) ?? listing[0] ?? null;
  const flat = q.trim() || course || filter !== 'tutto';

  const openImport = (preset?: DataTransfer) => ui.modal((close) => <ImportModal folderId={folderId} courseId={course?.id ?? null} dropped={preset} onClose={close} />);
  const newFolder = () => ui.modal((close) => <NameModal title="Nuova cartella" label="Nome della cartella" action="Crea" onClose={close} onSubmit={(n) => void ui.run(() => docs.createFolder(n, folderId))} />);
  const newNote = () => ui.run(async () => { const n = await docs.createNote('Nuova nota', folderId, course?.id ?? null); navigate(`/documento/${n.id}`); });

  const total = useQuery(() => docs.documents().length, []);

  return (
    <div className="app" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.items.length) openImport(e.dataTransfer); }}>
      <Sidebar active="doc" />
      <main className="main" style={{ outline: dragging ? '3px dashed #1F35C7' : 'none', outlineOffset: -6 }}>
        <header style={st('padding:20px 24px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none')}>
          <h1 className="pt s" style={st('margin:0')}>Documenti</h1>
          <span style={st('flex:1')} />
          <label style={st('height:40px;width:250px;border:1px solid #CFCFC9;border-radius:6px;display:flex;align-items:center;gap:8px;padding:0 10px;color:#5F5F59;font-size:14px')}>
            {Icon.search}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={path.length ? `Filtra in ${path.at(-1)!.name}` : 'Cerca nei nomi e nel testo'} aria-label="Cerca documenti" style={st('border:0;outline:none;flex:1;font:inherit;font-size:14px;min-width:0;background:transparent')} />
          </label>
          <Btn onClick={newFolder}>Nuova cartella</Btn>
          <Btn onClick={() => openImport()}>Importa</Btn>
          <Btn variant="p" onClick={() => void newNote()}>Nuova nota</Btn>
        </header>
        <div style={st('display:flex;align-items:center;gap:6px;padding:0 24px 12px;font-size:13px;flex-wrap:wrap;flex:none')}>
          {(['tutto', 'recenti', 'preferiti', ...tags.slice(0, 6)] as Filter[]).map((f) => (
            <button key={f} className={`tag ${filter === f && !course ? 'on' : ''}`} onClick={() => { setFilter(f); if (course) navigate('/documenti'); }}>{f === 'tutto' ? 'Tutto' : f === 'recenti' ? 'Recenti' : f === 'preferiti' ? 'Preferiti' : f}</button>
          ))}
          <span style={st('flex:1')} />
          <span className="mu">
            <button className="lnk" onClick={() => navigate('/documenti')}>Libreria</button>
            {course && <> / <b style={{ color: '#000' }}>{course.name}</b></>}
            {path.map((f) => <span key={f.id}> / <button className="lnk" style={st('color:inherit')} onClick={() => navigate(`/documenti?f=${f.id}`)}>{f.name}</button></span>)}
          </span>
        </div>

        {total === 0 && columns[0].folders.length === 0 ? (
          <div style={st('padding:24px')}>
            <Empty glyphs={3} title="La libreria è vuota" body="Importa PDF, note Markdown o un’intera cartella (anche un vault Obsidian) da File: la gerarchia delle cartelle viene mantenuta e gli originali non vengono toccati. Puoi anche trascinare qui i file." actions={<><Btn size="lg" variant="p" onClick={() => openImport()}>Importa file o cartella</Btn><Btn size="lg" onClick={() => void newNote()}>Scrivi la prima nota</Btn></>} />
          </div>
        ) : (
          <div className="stack-md" style={st('display:flex;flex:1;min-height:0;border-top:1px solid #DCDCD6')}>
            {!flat && columns.map((col, i) => (
              <FolderColumn key={col.parent ?? 'root'} folders={col.folders} active={path[i]?.id ?? null} last={i === columns.length - 1} onOpen={(f) => navigate(`/documenti?f=${f.id}`)} />
            ))}
            <div className="colm scroll" style={st('width:260px;flex:none;border-right:1px solid #DCDCD6;padding:6px')}>
              {listing.length === 0 && <p className="mu" style={st('padding:10px;font-size:14px')}>{q ? 'Nessun risultato.' : flat ? 'Nessun documento qui.' : 'Nessun documento in questa cartella.'}</p>}
              {listing.map((d) => (
                <button key={d.id} className={`fi ${selected?.id === d.id ? 'sel' : ''}`} onClick={() => setSelId(d.id)} onDoubleClick={() => navigate(`/documento/${d.id}`)} style={fiStyle(selected?.id === d.id)}>
                  {d.kind === 'pdf' ? Icon.pdf : d.kind === 'image' ? Icon.image : Icon.doc}
                  <span style={st('flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left')}>{d.name}</span>
                  <span style={st('font-size:12px')}>{d.favorite ? '★' : ''}</span>
                </button>
              ))}
            </div>
            <Preview doc={selected} course={selected?.courseId ? courses.get(selected.courseId) : undefined} />
          </div>
        )}
      </main>
    </div>
  );
}

const fiStyle = (sel: boolean): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44, padding: '0 12px', border: 0, borderRadius: 6, background: sel ? '#000' : 'transparent', color: sel ? '#fff' : '#000', fontSize: 14 });

function FolderColumn({ folders, active, last, onOpen }: { folders: Folder[]; active: string | null; last: boolean; onOpen: (f: Folder) => void }) {
  const { docs } = useServices();
  const ui = useUi();
  return (
    <div className="colm scroll" style={st('width:210px;flex:none;border-right:1px solid #DCDCD6;padding:6px')}>
      {folders.length === 0 && last && <p className="mu" style={st('padding:10px;font-size:13px')}>Nessuna sottocartella.</p>}
      {folders.map((f) => (
        <div key={f.id} style={st('display:flex;align-items:center')}>
          <button onClick={() => onOpen(f)} style={{ ...fiStyle(false), background: active === f.id ? '#E6E6E1' : 'transparent', fontWeight: active === f.id ? 650 : 400 }}>
            {Icon.dir}<span style={st('flex:1;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{f.name}</span><span className="mu">›</span>
          </button>
          <button aria-label={`Azioni per ${f.name}`} className="btn ghost" style={st('width:32px;padding:0;height:32px;flex:none;color:#5F5F59')} onClick={() => ui.modal((close) => <FolderActions folder={f} onClose={close} />)}>•••</button>
        </div>
      ))}
      <span style={{ display: 'none' }}>{String(docs)}</span>
    </div>
  );
}

function FolderActions({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const { docs } = useServices();
  const ui = useUi();
  const courses = useQuery((r) => r.courses(), []);
  return (
    <Modal title={folder.name} onClose={onClose} width={420}>
      <div style={st('padding:12px 24px 22px;display:flex;flex-direction:column;gap:8px')}>
        <Btn onClick={() => { onClose(); ui.modal((close) => <NameModal title="Rinomina cartella" label="Nome" initial={folder.name} action="Salva" onClose={close} onSubmit={(n) => void ui.run(() => docs.renameFolder(folder.id, n))} />); }}>Rinomina</Btn>
        <Btn onClick={() => { onClose(); ui.modal((close) => <MoveModal folderId={folder.id} onClose={close} />); }}>Sposta…</Btn>
        <label style={st('font-size:13px;margin-top:6px')}>Collega a un corso<select className="in" style={st('width:100%;margin-top:4px')} value={folder.courseId ?? ''} onChange={(e) => void ui.run(() => { docs.setFolderCourse(folder.id, e.target.value || null); onClose(); }, 'Cartella collegata')}>
          <option value="">Nessun corso</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <Btn style={st('color:#B23A0A;margin-top:6px')} onClick={() => { const impact = docs.folderDeletionImpact(folder.id); onClose(); ui.modal((close) => <ConfirmDialog title={`Eliminare «${folder.name}»?`} body={`Verranno eliminate ${impact.folders} ${impact.folders === 1 ? 'cartella' : 'cartelle'} e ${impact.documents} ${impact.documents === 1 ? 'documento' : 'documenti'} importati nell’app. I file originali in File non vengono toccati. L’operazione non si può annullare.`} confirmLabel="Elimina cartella e contenuto" danger onConfirm={() => void ui.run(() => docs.deleteFolder(folder.id), 'Cartella eliminata')} onClose={close} />); }}>Elimina…</Btn>
      </div>
    </Modal>
  );
}

function Preview({ doc, course }: { doc: DocumentRecord | null; course?: { name: string; color: string } }) {
  const { docs } = useServices();
  const ui = useUi();
  const [snippet, setSnippet] = useState('');
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    setSnippet('');
    setThumb(null);
    if (!doc) return;
    let alive = true;
    let url: string | null = null;
    if (doc.kind === 'markdown') void docs.getText(doc.id).then((t) => alive && setSnippet(t.replace(/^---[\s\S]*?---\s*/, '').slice(0, 600)), () => undefined);
    if (doc.kind === 'image') void docs.getBlob(doc.id).then((b) => { if (alive) { url = URL.createObjectURL(b); setThumb(url); } }, () => undefined);
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [docs, doc?.id]);

  if (!doc) return <aside style={st('flex:1;min-width:0;padding:24px;background:#FAFAF8')}><p className="mu">Seleziona un documento per vedere l’anteprima.</p></aside>;
  const pdfState = doc.kind === 'pdf' ? docs.pdfState(doc.id) : undefined;
  return (
    <aside className="scroll" style={st('flex:1;min-width:0;padding:18px 22px;display:flex;flex-direction:column;gap:12px;background:#FAFAF8')}>
      <div style={st("background:#fff;border:1px solid #DCDCD6;height:250px;padding:18px 20px;overflow:hidden;font-family:var(--serif);font-size:13px;line-height:1.5")}>
        <div style={st('font-size:20px;font-weight:600;line-height:1.2;margin-bottom:8px')}>{doc.name}</div>
        {doc.kind === 'markdown' && <div style={st('white-space:pre-line')}>{snippet}</div>}
        {doc.kind === 'pdf' && <div>{doc.pageCount ? `${doc.pageCount} pagine.` : 'PDF'}{pdfState ? ` Ultima posizione: p. ${pdfState.lastPage}` : ''}</div>}
        {doc.kind === 'image' && thumb && <img src={thumb} alt="" style={st('max-width:100%;max-height:190px')} />}
      </div>
      <div style={st('font-size:17px;font-weight:650;line-height:1.25')}>{doc.fileName}</div>
      <TagEditor doc={doc} />
      <div style={st('font-size:13px;border-top:1px solid #DCDCD6')}>
        <Meta l="Corso" v={course ? <span style={st('display:flex;align-items:center;gap:6px')}><Swatch color={course.color} />{course.name}</span> : '—'} />
        <Meta l="Modificato" v={formatDateMedium(doc.updatedAt.slice(0, 10))} />
        <Meta l="Dimensione" v={fmtSize(doc.size)} last />
      </div>
      <div style={st('display:flex;gap:8px;margin-top:auto;flex-wrap:wrap')}>
        <Btn variant="p" style={st('flex:1')} onClick={() => navigate(`/documento/${doc.id}`)}>Apri</Btn>
        <Btn onClick={() => ui.modal((close) => <MoveModal docId={doc.id} onClose={close} />)}>Sposta</Btn>
        <Btn aria-label="Altre azioni" onClick={() => ui.modal((close) => <DocActions doc={doc} onClose={close} />)}>•••</Btn>
      </div>
    </aside>
  );
}

function Meta({ l, v, last }: { l: string; v: React.ReactNode; last?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: last ? 0 : '1px solid #EBEBE6' }}><span className="mu">{l}</span><span>{v}</span></div>;
}

function TagEditor({ doc }: { doc: DocumentRecord }) {
  const { docs } = useServices();
  const [v, setV] = useState('');
  return (
    <div style={st('display:flex;gap:6px;flex-wrap:wrap;align-items:center')}>
      {doc.tags.map((t) => <button key={t} className="tag" title="Rimuovi" onClick={() => docs.setTags(doc.id, doc.tags.filter((x) => x !== t))}>{t} ×</button>)}
      <form onSubmit={(e) => { e.preventDefault(); const t = v.trim(); if (t) docs.setTags(doc.id, [...doc.tags, t.startsWith('#') ? t : `#${t}`]); setV(''); }}>
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder="+ tag" aria-label="Aggiungi tag" style={st('border:1px dashed #CFCFC9;border-radius:14px;height:28px;padding:0 10px;font:inherit;font-size:13px;width:90px;background:transparent')} />
      </form>
    </div>
  );
}

function DocActions({ doc, onClose }: { doc: DocumentRecord; onClose: () => void }) {
  const { docs } = useServices();
  const ui = useUi();
  const courses = useQuery((r) => r.courses(), []);
  return (
    <Modal title={doc.name} onClose={onClose} width={420}>
      <div style={st('padding:12px 24px 22px;display:flex;flex-direction:column;gap:8px')}>
        <Btn onClick={() => { docs.setFavorite(doc.id, !doc.favorite); onClose(); }}>{doc.favorite ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}</Btn>
        <Btn onClick={() => { onClose(); ui.modal((close) => <NameModal title="Rinomina" label="Nome" initial={doc.name} action="Salva" onClose={close} onSubmit={(n) => void ui.run(() => docs.rename(doc.id, n))} />); }}>Rinomina</Btn>
        <label style={st('font-size:13px')}>Corso<select className="in" style={st('width:100%;margin-top:4px')} value={doc.courseId ?? ''} onChange={(e) => { docs.setCourse(doc.id, e.target.value || null); onClose(); }}>
          <option value="">Nessun corso</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <Btn style={st('color:#B23A0A;margin-top:6px')} onClick={() => { onClose(); ui.modal((close) => <ConfirmDialog title={`Eliminare «${doc.name}»?`} body="Verrà eliminata la copia importata nell’app. L’originale in File non viene toccato. L’operazione non si può annullare." confirmLabel="Elimina documento" danger onConfirm={() => void ui.run(() => docs.delete(doc.id), 'Documento eliminato')} onClose={close} />); }}>Elimina…</Btn>
      </div>
    </Modal>
  );
}

function MoveModal({ docId, folderId, onClose }: { docId?: string; folderId?: string; onClose: () => void }) {
  const { docs } = useServices();
  const ui = useUi();
  const all = useMemo(() => docs.folders().map((f) => ({ f, label: docs.folderPath(f.id).map((p) => p.name).join(' / ') })).sort((a, b) => a.label.localeCompare(b.label)), [docs]);
  const blocked = folderId ? new Set(docs.descendantFolderIds(folderId)) : new Set<string>();
  const go = (dest: string | null) => void ui.run(() => { if (docId) docs.move(docId, dest); else if (folderId) docs.moveFolder(folderId, dest); onClose(); }, 'Spostato');
  return (
    <Modal title="Sposta in…" onClose={onClose} width={460}>
      <div style={st('padding:8px 24px 20px;max-height:55vh;overflow:auto')}>
        <button onClick={() => go(null)} style={st('display:block;width:100%;text-align:left;min-height:44px;border:0;border-top:1px solid #EBEBE6;background:transparent;font-weight:600')}>Libreria (livello principale)</button>
        {all.filter((x) => !blocked.has(x.f.id)).map((x) => <button key={x.f.id} onClick={() => go(x.f.id)} style={st('display:block;width:100%;text-align:left;min-height:44px;border:0;border-top:1px solid #EBEBE6;background:transparent')}>{x.label}</button>)}
      </div>
    </Modal>
  );
}

export function NameModal({ title, label, initial = '', action, onSubmit, onClose }: { title: string; label: string; initial?: string; action: string; onSubmit: (n: string) => void; onClose: () => void }) {
  const [v, setV] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  return (
    <Modal title={title} onClose={onClose} width={440} actions={<Btn variant="p" disabled={!v.trim()} onClick={() => { onSubmit(v); onClose(); }}>{action}</Btn>}>
      <form style={st('padding:16px 24px 24px')} onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onSubmit(v); onClose(); } }}>
        <label className="mu" style={st('font-size:13px')}>{label}</label>
        <input ref={input} className="in" style={st('width:100%;margin-top:4px')} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      </form>
    </Modal>
  );
}

export { canPickFolderNative };
