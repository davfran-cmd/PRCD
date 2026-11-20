import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from './router';
import { useServices } from './AppContext';
import { Icon } from '../ui/components';
import { st } from '../ui/style';
import { formatDayShort, todayISO } from '../domain/dates';

/** Search across courses, documents (name and note text) and personal events. */
export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const { repo, docs } = useServices();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (query.length < 1) return { courses: [], docs: [], events: [] };
    return {
      courses: repo.courses({ includeArchived: true }).filter((c) => c.name.toLowerCase().includes(query)).slice(0, 6),
      docs: docs.search(q, 8),
      events: repo.events().filter((e) => e.title.toLowerCase().includes(query)).slice(0, 6),
    };
  }, [q, repo, docs]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const none = !results.courses.length && !results.docs.length && !results.events.length;

  return (
    <div className="scrim" style={st('align-items:flex-start;padding-top:80px')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label="Cerca" style={{ maxWidth: 620 }}>
        <div style={st('display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #DCDCD6')}>
          {Icon.search}
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca corsi, note, PDF, eventi" aria-label="Cerca" style={st('flex:1;border:0;font:inherit;font-size:17px;background:transparent;outline:none')} />
          <button className="btn ghost" onClick={onClose}>Chiudi</button>
        </div>
        <div className="body" style={st('padding:8px 18px 16px;max-height:60vh')}>
          {!q.trim() && <p className="mu" style={st('margin:12px 0')}>Scrivi per cercare nei nomi e nel testo delle note. Tutto resta su questo dispositivo.</p>}
          {q.trim() && none && <p className="mu" style={st('margin:12px 0')}>Nessun risultato per «{q}».</p>}
          {results.courses.length > 0 && <Group title="Corsi">{results.courses.map((c) => <Row key={c.id} onClick={() => go(`/corso/${c.id}`)} title={c.name} dot={c.color} />)}</Group>}
          {results.docs.length > 0 && (
            <Group title="Documenti">
              {results.docs.map(({ doc, snippet }) => (
                <Row key={doc.id} onClick={() => go(`/documento/${doc.id}`)} title={doc.name} sub={snippet || (doc.kind === 'pdf' ? 'PDF' : doc.kind === 'markdown' ? 'Nota' : 'Immagine')} icon={doc.kind === 'pdf' ? Icon.pdf : doc.kind === 'image' ? Icon.image : Icon.doc} />
              ))}
            </Group>
          )}
          {results.events.length > 0 && (
            <Group title="Eventi">
              {results.events.map((e) => (
                <Row key={e.id} onClick={() => go(`/calendario/giorno?d=${e.start.slice(0, 10)}`)} title={e.title} sub={formatDayShort(e.start.slice(0, 10)) + (e.start.slice(0, 10) === todayISO() ? ' (oggi)' : '')} />
              ))}
            </Group>
          )}
        </div>
      </section>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={st('margin-top:12px')}>
      <div className="mu" style={st('font-size:13px;margin-bottom:2px')}>{title}</div>
      {children}
    </div>
  );
}

function Row({ title, sub, dot, icon, onClick }: { title: string; sub?: string; dot?: string; icon?: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={st('display:flex;align-items:center;gap:10px;width:100%;min-height:44px;border:0;border-top:1px solid #EBEBE6;background:transparent;text-align:left;padding:6px 0')}>
      {dot ? <span className="sw" style={{ width: 12, height: 12, background: dot }} /> : icon}
      <span style={st('flex:1;min-width:0')}>
        <span style={st('display:block;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{title}</span>
        {sub && <span className="mu" style={st('display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{sub}</span>}
      </span>
    </button>
  );
}
