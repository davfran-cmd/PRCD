import { useState } from 'react';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { Btn, ConfirmDialog, Field, Modal } from '../../ui/components';
import { st } from '../../ui/style';
import { validateGrade } from '../../domain/grades';
import type { AttemptComponent, AttemptOutcome } from '../../domain/types';

const OUTCOMES: Array<[AttemptOutcome, string]> = [
  ['planned', 'In programma'],
  ['passed', 'Superato'],
  ['failed', 'Non superato'],
  ['rejected', 'Voto rifiutato'],
  ['withdrawn', 'Ritirato'],
];
const COMPONENTS: Array<[AttemptComponent, string]> = [['written', 'Scritto'], ['oral', 'Orale'], ['written_oral', 'Scritto e orale'], ['project', 'Progetto'], ['test', 'Test'], ['other', 'Altro']];

/** Add or edit an exam attempt / mid-term. Final attempts feed the averages; mid-terms and failures never do. */
export function AttemptModal({ courseId, attemptId, onClose }: { courseId: string; attemptId?: string; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const course = useQuery((r) => r.course(courseId), [courseId]);
  const existing = useQuery((r) => (attemptId ? r.attempt(attemptId) : undefined), [attemptId]);
  const [midterm, setMidterm] = useState(existing?.isMidterm ?? false);
  const [outcome, setOutcome] = useState<AttemptOutcome>(existing?.outcome ?? 'planned');
  const [date, setDate] = useState(existing?.date ?? '');
  const [time, setTime] = useState(existing?.time ?? '');
  const [component, setComponent] = useState<AttemptComponent>(existing?.component ?? 'written');
  const [grade, setGrade] = useState<string>(existing?.grade === null || existing?.grade === undefined ? '' : String(existing.grade));
  const [lode, setLode] = useState(existing?.lode ?? false);
  const [booked, setBooked] = useState(existing?.booked ?? false);
  const [label, setLabel] = useState(existing?.label ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  if (!course) return null;
  const eligibility = course.examKind === 'eligibility' && !midterm;
  const needsGrade = (outcome === 'passed' || outcome === 'rejected') && !eligibility;
  const gradeNum = grade === '' ? null : Number(grade);
  const gradeError = needsGrade ? validateGrade(gradeNum, lode) : outcome === 'failed' && gradeNum !== null && (gradeNum < 0 || gradeNum > 17) ? 'Un esame non superato ha un voto sotto il 18' : null;
  const valid = !gradeError && (outcome === 'planned' ? Boolean(date) || true : true);

  const save = () =>
    ui.run(() => {
      repo.saveAttempt({
        id: existing?.id,
        createdAt: existing?.createdAt,
        courseId,
        outcome,
        date: date || null,
        time: time || null,
        component,
        isMidterm: midterm,
        grade: outcome === 'planned' || outcome === 'withdrawn' || eligibility ? null : gradeNum,
        lode: needsGrade ? lode : false,
        eligible: eligibility,
        booked: outcome === 'planned' ? booked : false,
        label,
        note,
      });
      onClose();
    }, 'Salvato');

  return (
    <Modal title={existing ? 'Modifica tentativo' : 'Nuovo tentativo'} onClose={onClose} width={560} actions={<Btn variant="p" disabled={!valid} onClick={() => void save()}>Salva</Btn>}>
      <div style={st('padding:6px 28px 24px')}>
        <p className="mu" style={st('font-size:14px;margin:8px 0 0')}>{course.name}, {course.cfu} CFU{eligibility ? ', idoneità' : ''}</p>
        <Field label="Tipo">
          <span style={st('display:flex;gap:6px')}>
            <button className={`pill ${!midterm ? 'on' : ''}`} onClick={() => setMidterm(false)}>Appello</button>
            <button className={`pill ${midterm ? 'on' : ''}`} onClick={() => setMidterm(true)}>Prova in itinere</button>
          </span>
        </Field>
        {midterm && <Field label="Nome"><input className="in" aria-label="Nome" placeholder="Es. 1ª prova in itinere" value={label} onChange={(e) => setLabel(e.target.value)} style={st('min-width:240px')} /></Field>}
        <Field label="Esito">
          <select className="in" aria-label="Esito" value={outcome} onChange={(e) => setOutcome(e.target.value as AttemptOutcome)}>
            {OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Data">
          <input className="in" type="date" aria-label="Data" value={date} onChange={(e) => setDate(e.target.value)} />
          <input className="in" type="time" aria-label="Ora" value={time} onChange={(e) => setTime(e.target.value)} style={st('width:110px')} />
        </Field>
        <Field label="Modalità">
          <select className="in" aria-label="Modalità" value={component} onChange={(e) => setComponent(e.target.value as AttemptComponent)}>
            {COMPONENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        {(needsGrade || outcome === 'failed') && (
          <Field label="Voto" hint={gradeError ?? undefined}>
            <input className={`in ${gradeError ? 'err' : ''}`} type="number" min={0} max={30} aria-label="Voto" value={grade} onChange={(e) => setGrade(e.target.value)} style={st('width:90px')} />
            {needsGrade && <label style={st('display:flex;gap:6px;align-items:center;font-size:14px')}><input type="checkbox" checked={lode} onChange={(e) => setLode(e.target.checked)} /> con lode</label>}
          </Field>
        )}
        {outcome === 'planned' && <Field label="Prenotazione"><label style={st('display:flex;gap:8px;align-items:center;font-size:14px')}><input type="checkbox" checked={booked} onChange={(e) => setBooked(e.target.checked)} /> Già prenotato sul portale dell’università</label></Field>}
        <Field label="Note"><textarea className="in" rows={2} aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} style={st('width:100%')} /></Field>
        {existing && (
          <div style={st('border-top:1px solid #EBEBE6;padding-top:12px;margin-top:6px')}>
            <Btn style={st('color:#B23A0A')} onClick={() => ui.modal((close) => <ConfirmDialog title="Eliminare questo tentativo?" body="Verrà rimosso dallo storico e dalle medie. L’operazione non si può annullare." confirmLabel="Elimina tentativo" danger onConfirm={() => { repo.deleteAttempt(existing.id); onClose(); ui.toast('Tentativo eliminato'); }} onClose={close} />)}>Elimina tentativo</Btn>
          </div>
        )}
      </div>
    </Modal>
  );
}
