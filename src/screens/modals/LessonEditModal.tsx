import { useMemo, useState } from 'react';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { ConfirmDialog, Modal, Swatch } from '../../ui/components';
import { st } from '../../ui/style';
import { addDays, formatDayLongLower, formatDayShort, hmToMin, isHM, isISODate, weekdayISO, WEEKDAYS_IT } from '../../domain/dates';
import type { ChangeScope, PreviewState } from '../../domain/timetable';

const SCOPES: Array<{ id: ChangeScope; title: string }> = [
  { id: 'one', title: 'Solo questa lezione' },
  { id: 'following', title: 'Questa e le successive' },
  { id: 'all', title: 'Tutto l’orario del corso' },
];

/** "Modifica lezione: una o tutte" — the scope of every change is explicit and previewed. */
export function LessonEditModal({ lessonId, onClose }: { lessonId: string; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const lesson = useQuery((r) => r.lesson(lessonId), [lessonId]);
  const course = useQuery((r) => (lesson ? r.course(lesson.courseId) : undefined), [lesson?.courseId]);
  const [scope, setScope] = useState<ChangeScope>('one');
  const [date, setDate] = useState(lesson?.date ?? '');
  const [start, setStart] = useState(lesson?.startTime ?? '');
  const [end, setEnd] = useState(lesson?.endTime ?? '');

  const valid = isISODate(date) && isHM(start) && isHM(end) && hmToMin(end) > hmToMin(start);
  const previews = useMemo(() => {
    if (!lesson || !valid) return null;
    const out = {} as Record<ChangeScope, ReturnType<typeof repo.previewLessonEdit> | null>;
    for (const s of SCOPES) {
      try {
        out[s.id] = repo.previewLessonEdit(lesson.id, s.id, { date, startTime: start, endTime: end });
      } catch {
        out[s.id] = null;
      }
    }
    return out;
  }, [lesson, valid, date, start, end, repo]);

  if (!lesson || !course) return null;
  const unchanged = date === lesson.date && start === lesson.startTime && end === lesson.endTime;
  const preview = previews?.[scope] ?? null;
  const isExtra = lesson.kind === 'extra';
  const scopes = isExtra ? SCOPES.slice(0, 1) : SCOPES;

  const desc = (s: ChangeScope): string => {
    const p = previews?.[s];
    const from = s === 'following' ? lesson.originalDate ?? lesson.date : null;
    const n = p?.counts.changed ?? 0;
    if (s === 'one') return `Sposta ${formatDayLongLower(lesson.date)}. Gli altri ${WEEKDAYS_IT[weekdayISO(lesson.date) - 1]} restano come sono.`;
    if (s === 'following') return `Dal ${from ? formatDayShort(from) : ''} in poi, ${n} ${n === 1 ? 'lezione' : 'lezioni'}. Le precedenti restano come sono.`;
    const rep = p?.counts.exceptionsReplaced ?? 0;
    return `Cambia lo slot per l’intero semestre${rep ? `. Sostituisce anche ${rep} ${rep === 1 ? 'spostamento singolo già previsto' : 'spostamenti singoli già previsti'} (×)` : ''}.`;
  };

  const summary = (() => {
    if (!preview) return 'Controlla data e orari.';
    const when = `${start}–${end}`;
    if (scope === 'one') return `Sposta solo ${formatDayLongLower(date)} alle ${when}.`;
    const wd = WEEKDAYS_IT[weekdayISO(date) - 1];
    const prot = preview.counts.protectedCount;
    const rep = preview.counts.exceptionsReplaced;
    return `Lo slot del ${wd} diventa ${when}. ${prot ? `${prot} ${prot === 1 ? 'lezione con presenza o già svolta resta' : 'lezioni con presenza o già svolte restano'} invariat${prot === 1 ? 'a' : 'e'}. ` : ''}${rep ? `${rep} spostament${rep === 1 ? 'o futuro viene sostituito' : 'i futuri vengono sostituiti'}.` : ''}`.trim();
  })();

  const cta = scope === 'one' ? 'Sposta questa lezione' : scope === 'following' ? `Sposta ${preview?.counts.changed ?? ''} lezioni`.replace('  ', ' ') : 'Cambia l’orario';

  const apply = (confirmed = false) => {
    void ui.run(() => {
      repo.editLesson(lesson.id, scope, { date, startTime: start, endTime: end }, { confirmedReplace: confirmed });
      onClose();
      ui.toast('Orario aggiornato. Le presenze registrate non sono cambiate.');
    });
  };

  const submit = () => {
    if (!preview || unchanged) return;
    if (preview.needsConfirmation) {
      ui.modal((close) => (
        <ConfirmDialog
          title="Sostituire gli spostamenti singoli?"
          body={`Questa modifica sostituisce ${preview.counts.exceptionsReplaced} lezion${preview.counts.exceptionsReplaced === 1 ? 'e già spostata o annullata' : 'i già spostate o annullate'} a mano. Le presenze già registrate non cambiano.`}
          confirmLabel="Sostituisci e cambia l’orario"
          onConfirm={() => apply(true)}
          onClose={close}
        />
      ));
    } else apply();
  };

  const cancelLesson = () => {
    repo.cancelLesson(lesson.id, true);
    onClose();
    ui.toast(`Lezione di ${course.name} annullata`, { actionLabel: 'Ripristina', onAction: () => repo.cancelLesson(lesson.id, false) });
  };

  const holiday = () => {
    const impact = repo.lessonsInRange(lesson.date, lesson.date).filter((l) => !l.cancelled && l.attendance === 'to_confirm').length;
    ui.modal((close) => (
      <ConfirmDialog
        title={`Segnare ${formatDayShort(lesson.date)} come festività?`}
        body={`${impact} ${impact === 1 ? 'lezione verrà annullata' : 'lezioni verranno annullate'} (non eliminate: si possono ripristinare). Le presenze già registrate restano.`}
        confirmLabel="Segna festività"
        onConfirm={() => void ui.run(() => { repo.addClosure({ startDate: lesson.date, endDate: lesson.date, label: 'Festività', semesterId: course.semesterId }); onClose(); }, 'Festività segnata')}
        onClose={close}
      />
    ));
  };

  const addExtra = () => {
    ui.modal((close) => <ExtraLessonModal courseId={course.id} defaultDate={addDays(lesson.date, 1)} start={lesson.startTime} end={lesson.endTime} onClose={() => { close(); onClose(); }} />);
  };

  return (
    <Modal title={`${course.name}, ${formatDayLongLower(lesson.date)}`} onClose={onClose} width={1000} leading={<Swatch color={course.color} size={14} />}>
      <div className="grid-md-1" style={st('display:grid;grid-template-columns:360px 1fr;min-height:480px')}>
        <div style={st('padding:24px 28px;border-right:1px solid #DCDCD6;display:flex;flex-direction:column;gap:18px')}>
          <div>
            <div style={st('font-size:14px;font-weight:600;margin-bottom:8px')}>Orario attuale</div>
            <div className="mu" style={st('font-size:22px;font-weight:600;text-decoration:line-through')}>{lesson.startTime}–{lesson.endTime}</div>
          </div>
          <div>
            <div style={st('font-size:14px;font-weight:600;margin-bottom:8px')}>Nuovo orario</div>
            <input className="in" type="date" aria-label="Data" value={date} onChange={(e) => setDate(e.target.value)} style={st('width:100%;margin-bottom:8px;height:44px')} />
            <div style={st('display:flex;gap:8px;align-items:center')}>
              <input className="in emph" type="time" aria-label="Inizio" value={start} onChange={(e) => setStart(e.target.value)} style={st('flex:1;height:44px')} />
              <span className="mu">–</span>
              <input className={`in emph ${valid ? '' : 'err'}`} type="time" aria-label="Fine" value={end} onChange={(e) => setEnd(e.target.value)} style={st('flex:1;height:44px')} />
            </div>
            {!valid && <p style={st('color:#B23A0A;font-size:13px;margin:8px 0 0')}>L’ora di fine deve seguire quella di inizio.</p>}
          </div>
          <div style={st('border-top:1px solid #EBEBE6;padding-top:16px;display:flex;flex-direction:column;gap:2px')}>
            <div style={st('font-size:14px;font-weight:600;margin-bottom:6px')}>Altre azioni su questa lezione</div>
            {lesson.cancelled ? (
              <button className="btn ghost" style={st('justify-content:flex-start;padding:0;height:40px')} onClick={() => { repo.cancelLesson(lesson.id, false); onClose(); }}>Ripristina la lezione</button>
            ) : (
              <button className="btn ghost" style={st('justify-content:flex-start;padding:0;height:40px;color:#B23A0A')} onClick={cancelLesson}>Annulla la lezione</button>
            )}
            <button className="btn ghost" style={st('justify-content:flex-start;padding:0;height:40px')} onClick={addExtra}>Aggiungi una lezione extra</button>
            <button className="btn ghost" style={st('justify-content:flex-start;padding:0;height:40px')} onClick={holiday}>Segna festività o sospensione</button>
          </div>
          <div style={st('margin-top:auto;background:#F2F2EF;border-radius:8px;padding:14px 16px;display:flex;gap:12px;font-size:14px')}>
            <span style={st('flex:none;margin-top:1px')}>🔒</span>
            <div>Le presenze già registrate non cambiano mai. {preview?.counts.protectedCount ? `${preview.counts.protectedCount} lezioni con presenza registrata o già svolte conservano data, orario e stato originali.` : 'Spostare una lezione non azzera la sua presenza.'}</div>
          </div>
        </div>
        <div style={st('padding:24px 28px;display:flex;flex-direction:column;gap:10px')}>
          <div style={st('font-size:14px;font-weight:600')}>A quali lezioni si applica?</div>
          {scopes.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={scope === s.id} onClick={() => setScope(s.id)} className={`scope ${scope === s.id ? 'on' : ''}`} style={{ width: '100%', textAlign: 'left', border: scope === s.id ? '2px solid #000' : '1px solid #CFCFC9', padding: scope === s.id ? '13px 15px' : '14px 16px', borderRadius: 8, background: '#fff', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={st('display:flex;align-items:center;gap:10px')}>
                <span style={st('width:20px;height:20px;border-radius:10px;border:2px solid #000;display:flex;align-items:center;justify-content:center')}><span style={{ width: 10, height: 10, borderRadius: 5, background: scope === s.id ? '#000' : 'transparent' }} /></span>
                <span style={st('font-size:17px;font-weight:650')}>{s.title}</span>
              </span>
              <span className="mu" style={st('font-size:14px;padding-left:30px')}>{desc(s.id)}</span>
              <Weeks preview={previews?.[s.id] ?? null} />
            </button>
          ))}
          {isExtra && <p className="mu" style={st('font-size:13px;margin:0')}>Le lezioni extra non fanno parte dell’orario ricorrente: la modifica riguarda solo questa.</p>}
          <div className="mu" style={st('display:flex;gap:16px;font-size:12px;padding-left:2px;flex-wrap:wrap')}>
            <Key bg="#1F35C7" l="cambia" /><Key bg="#E6E6E1" l="resta com’è" /><Key bg="#E6E6E1" l="presenza registrata o già svolta, protetta" dot /><Key bg="#E6E6E1" l="spostamento singolo (×)" cross />
          </div>
          <div style={st('margin-top:auto;border-top:2px solid #000;padding-top:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap')}>
            <p style={st('margin:0;flex:1;font-size:15px;min-width:220px')}>{unchanged ? 'Cambia data o orario per continuare.' : summary}</p>
            <button className="btn lg p" disabled={!preview || unchanged} onClick={submit}>{cta}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Key({ bg, l, dot, cross }: { bg: string; l: string; dot?: boolean; cross?: boolean }) {
  return (
    <span style={st('display:flex;gap:5px;align-items:center')}>
      <span style={{ width: 12, height: 12, borderRadius: 3, background: bg, fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{dot ? '●' : cross ? '×' : ''}</span>
      {l}
    </span>
  );
}

const COLORS: Record<PreviewState, { bg: string; fg: string; mark: string }> = {
  target: { bg: '#1F35C7', fg: '#fff', mark: '' },
  changed: { bg: '#1F35C7', fg: '#fff', mark: '' },
  unchanged: { bg: '#E6E6E1', fg: '#5F5F59', mark: '' },
  protected: { bg: '#E6E6E1', fg: '#5F5F59', mark: '●' },
  exception_kept: { bg: '#E6E6E1', fg: '#5F5F59', mark: '×' },
  exception_replaced: { bg: '#1F35C7', fg: '#fff', mark: '×' },
};

function Weeks({ preview }: { preview: ReturnType<ReturnType<typeof useServices>['repo']['previewLessonEdit']> | null }) {
  if (!preview) return <span style={st('height:20px')} />;
  return (
    <span style={st('display:flex;gap:4px;padding-left:30px;margin-top:2px;flex-wrap:wrap')} aria-hidden="true">
      {preview.preview.map((p) => {
        const c = COLORS[p.state];
        return (
          <span key={p.lessonId} title={formatDayShort(p.date)} style={{ width: 20, height: 20, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, background: c.bg, color: c.fg }}>
            {c.mark}
          </span>
        );
      })}
    </span>
  );
}

function ExtraLessonModal({ courseId, defaultDate, start, end, onClose }: { courseId: string; defaultDate: string; start: string; end: string; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const [date, setDate] = useState(defaultDate);
  const [s, setS] = useState(start);
  const [e, setE] = useState(end);
  const [topic, setTopic] = useState('');
  return (
    <Modal title="Lezione extra" onClose={onClose} width={440} actions={<button className="btn p" onClick={() => void ui.run(() => { repo.addExtraLesson(courseId, { date, startTime: s, endTime: e, topic }); onClose(); }, 'Lezione extra aggiunta')}>Aggiungi</button>}>
      <div style={st('padding:18px 24px 24px;display:grid;gap:10px')}>
        <input className="in" type="date" aria-label="Data" value={date} onChange={(ev) => setDate(ev.target.value)} />
        <div style={st('display:flex;gap:8px;align-items:center')}>
          <input className="in emph" type="time" aria-label="Inizio" value={s} onChange={(ev) => setS(ev.target.value)} style={st('flex:1')} />
          <span className="mu">–</span>
          <input className="in emph" type="time" aria-label="Fine" value={e} onChange={(ev) => setE(ev.target.value)} style={st('flex:1')} />
        </div>
        <input className="in" placeholder="Argomento (facoltativo)" value={topic} onChange={(ev) => setTopic(ev.target.value)} />
        <p className="mu" style={st('font-size:13px;margin:0')}>Una lezione extra ha la sua presenza e non fa parte dell’orario ricorrente.</p>
      </div>
    </Modal>
  );
}
