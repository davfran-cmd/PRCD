import { useState } from 'react';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { Btn, Field, Modal } from '../../ui/components';
import { st } from '../../ui/style';
import { COURSE_COLORS } from '../../domain/settings';
import { WEEKDAYS_IT, hmToMin, isHM } from '../../domain/dates';
import { findConflicts } from '../../domain/conflicts';
import { currentSlots } from '../../app/queries';
import { navigate } from '../../app/router';
import type { ExamKind } from '../../domain/types';

interface SlotDraft {
  weekday: number;
  startTime: string;
  endTime: string;
  ruleId?: string;
}

/** Create or edit a course: name, colour, CFU, exam kind and weekly slots (lessons are generated automatically). */
export function CourseModal({ courseId, semesterId, onClose }: { courseId?: string; semesterId: string; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const existing = useQuery((r) => (courseId ? r.course(courseId) : undefined), [courseId]);
  const today = new Date().toISOString().slice(0, 10);
  const existingSlots = useQuery((r) => (courseId ? currentSlots(r.rules(courseId), today) : []), [courseId]);
  const others = useQuery((r) => r.courses({ semesterId }).filter((c) => c.id !== courseId).map((c) => ({ c, slots: currentSlots(r.rules(c.id), today) })), [semesterId, courseId]);
  const usedColors = useQuery((r) => r.courses({ semesterId }).map((c) => c.color), [semesterId]);

  const [name, setName] = useState(existing?.name ?? '');
  const [cfu, setCfu] = useState<number>(existing?.cfu ?? 6);
  const [color, setColor] = useState(existing?.color ?? COURSE_COLORS.find((c) => !usedColors.includes(c.hex))?.hex ?? COURSE_COLORS[0].hex);
  const [kind, setKind] = useState<ExamKind>(existing?.examKind ?? 'graded');
  const [slots, setSlots] = useState<SlotDraft[]>(existing ? [] : [{ weekday: 1, startTime: '10:15', endTime: '12:15' }]);

  const newSlotsValid = slots.every((s) => isHM(s.startTime) && isHM(s.endTime) && hmToMin(s.endTime) > hmToMin(s.startTime));
  const clashes = (() => {
    const mine = slots.map((s, i) => ({ id: `n${i}`, kind: 'lesson' as const, title: name || 'Questo corso', start: `2000-01-0${s.weekday}T${s.startTime}`, end: `2000-01-0${s.weekday}T${s.endTime}` }));
    const theirs = others.flatMap(({ c, slots: ss }) => ss.map((s, i) => ({ id: `${c.id}${i}`, kind: 'lesson' as const, title: c.name, start: `2000-01-0${s.weekday}T${s.startTime}`, end: `2000-01-0${s.weekday}T${s.endTime}` })));
    return findConflicts([...mine, ...theirs]).filter((c) => c.a.id.startsWith('n') !== c.b.id.startsWith('n'));
  })();
  const valid = name.trim().length > 0 && Number.isInteger(cfu) && cfu >= 0 && cfu <= 60 && newSlotsValid;

  const save = () =>
    ui.run(() => {
      if (existing) {
        repo.updateCourse(existing.id, { name, cfu, color, examKind: kind });
        for (const s of slots) repo.addSlot(existing.id, s);
        onClose();
        ui.toast('Corso aggiornato');
      } else {
        const c = repo.createCourse({ semesterId, name, cfu, color, examKind: kind, slots });
        onClose();
        ui.toast(`${c.name} creato: ${repo.lessonsForCourse(c.id).length} lezioni generate`);
        navigate(`/corso/${c.id}`);
      }
    });

  return (
    <Modal title={existing ? 'Modifica corso' : 'Nuovo corso'} onClose={onClose} actions={<Btn variant="p" disabled={!valid} onClick={() => void save()}>{existing ? 'Salva' : 'Crea corso'}</Btn>}>
      <div style={st('padding:18px 28px 24px')}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome del corso" placeholder="Nome del corso" style={st('width:100%;border:0;border-bottom:2px solid #000;font:inherit;font-size:28px;font-weight:700;letter-spacing:-0.02em;padding:6px 0 8px;background:transparent;outline:none')} />
        <Field label="CFU">
          <input className="in" type="number" min={0} max={60} aria-label="CFU" value={cfu} onChange={(e) => setCfu(Number(e.target.value))} style={st('width:90px')} />
          <select className="in" aria-label="Tipo di esame" value={kind} onChange={(e) => setKind(e.target.value as ExamKind)}>
            <option value="graded">Esame con voto</option>
            <option value="eligibility">Idoneità (senza voto)</option>
          </select>
        </Field>
        <Field label="Colore" hint="identifica il corso ovunque">
          {COURSE_COLORS.map((c) => (
            <button key={c.hex} type="button" title={c.name} aria-label={c.name} aria-pressed={color === c.hex} onClick={() => setColor(c.hex)} style={{ width: 30, height: 30, borderRadius: 4, border: 0, background: c.hex, boxShadow: color === c.hex ? '0 0 0 2px #fff,0 0 0 4px #000' : 'none' }} />
          ))}
        </Field>
        <div style={st('border-top:1px solid #EBEBE6;padding-top:14px;margin-top:4px')}>
          <div style={st('font-size:14px;font-weight:600;margin-bottom:4px')}>Orario settimanale</div>
          <p className="mu" style={st('font-size:13px;margin:0 0 10px')}>Ogni giorno indicato genera una lezione a settimana per tutto il semestre. Si possono poi spostare o annullare singolarmente.</p>
          {existingSlots.map((s, i) => (
            <div key={i} className="mu" style={st('display:flex;gap:8px;padding:6px 0;font-size:14px')}>
              <b style={st('color:#000;width:100px')}>{WEEKDAYS_IT[s.weekday - 1]}</b>
              {s.startTime}–{s.endTime}
              <span style={st('margin-left:auto;font-size:13px')}>per modificarlo apri una lezione dal calendario</span>
            </div>
          ))}
          {slots.map((s, i) => (
            <div key={i} style={st('display:grid;grid-template-columns:130px 1fr auto 1fr 44px;gap:8px;align-items:center;margin-bottom:8px')}>
              <select className="in" aria-label="Giorno" value={s.weekday} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>
                {WEEKDAYS_IT.slice(0, 6).map((w, k) => <option key={k} value={k + 1}>{w}</option>)}
              </select>
              <input className="in" type="time" aria-label="Inizio" value={s.startTime} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, startTime: e.target.value } : x)))} />
              <span className="mu">–</span>
              <input className="in" type="time" aria-label="Fine" value={s.endTime} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, endTime: e.target.value } : x)))} />
              <button className="btn icon-btn" aria-label="Rimuovi giorno" onClick={() => setSlots(slots.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <Btn style={st('width:100%;border-style:dashed')} onClick={() => setSlots([...slots, { weekday: Math.min(6, (slots.at(-1)?.weekday ?? 0) + 1), startTime: '10:15', endTime: '12:15' }])}>Aggiungi un giorno</Btn>
          {!newSlotsValid && <p style={st('color:#B23A0A;font-size:13px;margin:8px 0 0')}>L’ora di fine deve seguire quella di inizio.</p>}
          {clashes.length > 0 && (
            <p style={st('font-size:13.5px;color:#B23A0A;margin:10px 0 0')}>
              Si sovrappone a {clashes.map((c) => (c.a.id.startsWith('n') ? c.b : c.a).title).filter((v, i, a) => a.indexOf(v) === i).join(', ')}. Puoi salvare lo stesso: le due lezioni saranno affiancate nel calendario.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
