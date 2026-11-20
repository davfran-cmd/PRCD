import { useState } from 'react';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { Icon, Modal } from '../../ui/components';
import { st } from '../../ui/style';

/** Pick existing library documents to associate with a course (no copies are made). */
export function LinkDocumentModal({ courseId, onClose }: { courseId: string; onClose: () => void }) {
  const { docs } = useServices();
  const ui = useUi();
  const [q, setQ] = useState('');
  const list = useQuery(() => docs.documents(q ? { query: q } : {}).filter((d) => d.courseId !== courseId), [q, courseId]);
  return (
    <Modal title="Collega un documento" onClose={onClose} width={520}>
      <div style={st('padding:12px 24px 20px')}>
        <input className="in" style={st('width:100%')} placeholder="Cerca nella libreria" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cerca nella libreria" autoFocus />
        <div style={st('margin-top:8px;max-height:50vh;overflow:auto')}>
          {list.length === 0 && <p className="mu" style={st('font-size:14px')}>Nessun documento da collegare. Importa file dalla sezione Documenti.</p>}
          {list.slice(0, 50).map((d) => (
            <button key={d.id} onClick={() => void ui.run(() => { docs.setCourse(d.id, courseId); }, `«${d.name}» collegato`)} style={st('display:flex;align-items:center;gap:10px;width:100%;min-height:44px;border:0;border-top:1px solid #EBEBE6;background:transparent;text-align:left')}>
              {d.kind === 'pdf' ? Icon.pdf : d.kind === 'image' ? Icon.image : Icon.doc}
              <span style={st('flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{d.name}</span>
              <span className="mu" style={st('font-size:12px')}>{d.courseId ? 'già in un altro corso' : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
