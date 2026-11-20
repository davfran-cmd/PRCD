import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { A, useRoute, navigate } from '../app/router';
import { useNow, useQuery, useServices, useUi } from '../app/AppContext';
import { librettoAverages, semesterSummaries } from '../app/queries';
import { formatNumberIT, formatDateMedium, WEEKDAY_LETTERS_IT, formatDayShort } from '../domain/dates';
import { Btn, Empty, Glyph, Modal, PageHeader, ConfirmDialog, Field } from '../ui/components';
import { st } from '../ui/style';
import { CourseModal } from './modals/CourseModal';
import { computeAttendance } from '../domain/attendance';

export function Universita() {
  const { repo } = useServices();
  const ui = useUi();
  const now = useNow();
  const route = useRoute();
  const semesters = useQuery((r) => r.semesters(), []);
  const current = useQuery((r) => r.currentSemester());
  const [selected, setSelected] = useState<string | null>(null);
  const semId = selected ?? current?.id ?? semesters[0]?.id ?? null;
  const sem = semesters.find((s) => s.id === semId);
  const settings = useQuery((r) => r.getSettings());
  const summaries = useQuery((r) => (semId ? semesterSummaries(r, semId, now.local) : []), [semId, now.local.slice(0, 13)]);
  const avg = useQuery((r) => librettoAverages(r));
  const allLessons = useQuery((r) => (semId ? r.lessonsForSemester(semId) : []), [semId]);
  const semStats = useMemo(() => computeAttendance(allLessons, now.local, settings), [allLessons, now.local, settings]);

  useEffect(() => {
    if (route.query.get('nuovo') && sem) ui.modal((close) => <CourseModal semesterId={sem.id} onClose={close} />);
    else if (route.query.get('nuovo')) ui.modal((close) => <SemesterModal onClose={close} />);
    if (route.query.get('nuovo')) navigate('/universita', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.query.get('nuovo')]);

  const toRecover = summaries.reduce((a, s) => a + s.stats.absent, 0);
  const examLabel = (s: (typeof summaries)[number]) => (s.nextExam ? `${s.nextExam.isMidterm ? 'prova ' : ''}${formatDayShort(s.nextExam.date as string)}` : repo.attempts(s.course.id).some((a) => a.outcome === 'passed' && !a.isMidterm) ? 'superato' : 'da fissare');

  return (
    <div className="app">
      <Sidebar active="uni" />
      <main className="main scroll" style={st('padding:26px 32px 24px')}>
        <PageHeader
          title="Università"
          sub={sem ? `${sem.name}, dal ${formatDateMedium(sem.startDate)} al ${formatDateMedium(sem.endDate)}` : 'Crea il primo semestre per iniziare'}
          actions={
            <>
              <A to="/libretto" className="btn">Libretto</A>
              <Btn onClick={() => ui.modal((close) => <SemestersModal onClose={close} />)}>Semestri</Btn>
              <Btn variant="p" disabled={!sem} onClick={() => sem && ui.modal((close) => <CourseModal semesterId={sem.id} onClose={close} />)}>Nuovo corso</Btn>
            </>
          }
        />

        <div className="grid-md-1" style={st('display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:22px;border-top:2px solid #000;border-bottom:1px solid #DCDCD6')}>
          <Kpi value={<>{avg.totalCfu}<span className="mu" style={st('font-size:20px;font-weight:500;letter-spacing:0')}> / {settings.degreeCfuTarget}</span></>} label="CFU acquisiti" first />
          <Kpi value={avg.weighted === null ? '–' : formatNumberIT(avg.weighted, 2)} label={`media ponderata su ${avg.gradedExams} ${avg.gradedExams === 1 ? 'esame' : 'esami'}`} />
          <Kpi value={semStats.percentage === null ? '–' : `${formatNumberIT(semStats.percentage, 0)}%`} label="presenza media del semestre" />
          <Kpi value={toRecover} label="assenze ancora da recuperare" last />
        </div>

        <div style={st('display:flex;align-items:center;gap:12px;margin:18px 0 6px;flex-wrap:wrap')}>
          <h2 className="sec" style={st('flex:1')}>Corsi</h2>
          {semesters.length > 0 && (
            <div className="seg" role="group" aria-label="Semestre">
              {semesters.slice(0, 4).map((s) => <button key={s.id} className={s.id === semId ? 'on' : ''} aria-pressed={s.id === semId} onClick={() => setSelected(s.id)}>{s.name}</button>)}
            </div>
          )}
        </div>

        {semesters.length === 0 ? (
          <Empty title="Nessun semestre" body="Crea il semestre con le sue date: i corsi e le lezioni vivono al suo interno." actions={<Btn size="lg" variant="p" onClick={() => ui.modal((close) => <SemesterModal onClose={close} />)}>Crea il primo semestre</Btn>} />
        ) : summaries.length === 0 ? (
          <Empty title="Nessun corso in questo semestre" body="Aggiungi un corso con giorni e orari: PRCD crea da solo tutte le lezioni fino alla fine del semestre." actions={<Btn size="lg" variant="p" onClick={() => sem && ui.modal((close) => <CourseModal semesterId={sem.id} onClose={close} />)}>Aggiungi il primo corso</Btn>} />
        ) : (
          <div style={st('overflow-x:auto')}>
            <div style={st('min-width:760px')}>
              <div className="tr th" style={st('grid-template-columns:230px 44px 96px minmax(0,1fr) 52px 96px 110px')}>
                <span>Corso</span><span>CFU</span><span>Giorni</span><span>Lezioni del semestre</span><span style={st('text-align:right')}>Pres.</span><span>Da recuperare</span><span>Esame</span>
              </div>
              {summaries.map((s) => {
                const p = s.stats.percentage;
                const lo = p !== null && p < settings.attendanceThreshold;
                return (
                  <A key={s.course.id} to={`/corso/${s.course.id}`} className="tr" style={st('grid-template-columns:230px 44px 96px minmax(0,1fr) 52px 96px 110px')}>
                    <span style={st('display:grid;grid-template-columns:12px minmax(0,1fr);align-items:center;gap:10px;font-weight:600;min-width:0')} title={s.course.name}>
                      <span style={{ width: 12, height: 12, borderRadius: 2, background: s.course.color }} />
                      <span style={st('white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{s.course.name}</span>
                    </span>
                    <span>{s.course.cfu}</span>
                    <span style={st('display:flex;gap:3px')}>
                      {[1, 2, 3, 4, 5].map((wd) => (
                        <span key={wd} style={{ width: 16, height: 22, borderRadius: 2, background: s.weekdays.includes(wd) ? s.course.color : '#F2F2EF', color: s.weekdays.includes(wd) ? '#fff' : '#9A9A93', fontSize: 10, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>{WEEKDAY_LETTERS_IT[wd - 1]}</span>
                      ))}
                    </span>
                    <span style={st('display:flex;gap:2px;flex-wrap:wrap;max-width:300px')}>
                      {s.strip.map((g, i) => <span key={i} className={`g ${g} sm`} />)}
                    </span>
                    <span style={{ textAlign: 'right', fontWeight: 650, fontSize: 17, color: lo ? '#B23A0A' : '#000' }}>{p === null ? '–' : `${formatNumberIT(p, 0)}%`}</span>
                    <span>{s.stats.absent === 0 ? '–' : `${s.stats.absent} ${s.stats.absent === 1 ? 'lezione' : 'lezioni'}`}</span>
                    <span style={st('font-size:14px')}>{examLabel(s)}</span>
                  </A>
                );
              })}
              <div className="mu" style={st('font-size:13px;margin-top:10px;border-top:1px solid #EBEBE6;padding-top:10px')}>Ogni quadrato è una lezione. Le lezioni ancora da svolgere sono in grigio chiaro.</div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Kpi({ value, label, first, last }: { value: React.ReactNode; label: string; first?: boolean; last?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: `16px ${last ? 0 : 20}px 16px ${first ? 0 : 20}px`, borderRight: last ? 0 : '1px solid #DCDCD6' }}>
      <b style={st('font-size:40px;font-weight:750;letter-spacing:-0.035em;line-height:1')}>{value}</b>
      <span className="mu" style={st('font-size:14px')}>{label}</span>
    </div>
  );
}

/** List + create/edit/archive semesters. */
export function SemestersModal({ onClose }: { onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const semesters = useQuery((r) => r.semesters(), []);
  const currentId = useQuery((r) => r.getSettings().currentSemesterId);
  return (
    <Modal title="Semestri" onClose={onClose} width={560} actions={<Btn variant="p" onClick={() => ui.modal((close) => <SemesterModal onClose={close} />)}>Nuovo</Btn>}>
      <div style={st('padding:8px 28px 24px')}>
        {semesters.length === 0 && <p className="mu">Nessun semestre. Creane uno con il pulsante in alto.</p>}
        {semesters.map((s) => (
          <div key={s.id} className="sr">
            <span className="t">
              <b>{s.name}</b>{s.archived && <span className="mu"> · archiviato</span>}{s.id === currentId && <span style={st('color:#1F35C7')}> · in corso</span>}
              <small>{formatDateMedium(s.startDate)} – {formatDateMedium(s.endDate)}</small>
            </span>
            {s.id !== currentId && !s.archived && <Btn size="s" onClick={() => repo.updateSettings({ currentSemesterId: s.id })}>Imposta in corso</Btn>}
            <Btn size="s" onClick={() => ui.modal((close) => <SemesterModal semesterId={s.id} onClose={close} />)}>Modifica</Btn>
            <Btn size="s" onClick={() => void ui.run(() => repo.updateSemester(s.id, { archived: !s.archived }), s.archived ? 'Semestre ripristinato' : 'Semestre archiviato')}>{s.archived ? 'Ripristina' : 'Archivia'}</Btn>
          </div>
        ))}
        <p className="mu" style={st('font-size:13px;margin-top:14px')}>Archiviare un semestre non elimina nulla: lezioni, presenze ed esami restano consultabili.</p>
      </div>
    </Modal>
  );
}

export function SemesterModal({ semesterId, onClose }: { semesterId?: string; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const existing = useQuery((r) => (semesterId ? r.semester(semesterId) : undefined), [semesterId]);
  const y = new Date().getFullYear();
  const [name, setName] = useState(existing?.name ?? '');
  const [start, setStart] = useState(existing?.startDate ?? `${y}-09-28`);
  const [end, setEnd] = useState(existing?.endDate ?? `${y + 1}-01-15`);
  const valid = name.trim() && start && end && end >= start;
  return (
    <Modal title={existing ? 'Modifica semestre' : 'Nuovo semestre'} onClose={onClose} width={520} actions={<Btn variant="p" disabled={!valid} onClick={() => void ui.run(() => { if (existing) repo.updateSemester(existing.id, { name, startDate: start, endDate: end }); else repo.createSemester({ name, startDate: start, endDate: end }); onClose(); }, existing ? 'Semestre aggiornato' : 'Semestre creato')}>{existing ? 'Salva' : 'Crea'}</Btn>}>
      <div style={st('padding:18px 28px 24px')}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome del semestre" placeholder="Es. 1° semestre 2026/27" style={st('width:100%;border:0;border-bottom:2px solid #000;font:inherit;font-size:24px;font-weight:700;padding:6px 0 8px;background:transparent;outline:none')} />
        <Field label="Inizio"><input className="in" type="date" aria-label="Inizio" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Fine"><input className="in" type="date" aria-label="Fine" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        {end < start && <p style={st('color:#B23A0A;font-size:13px')}>La fine precede l’inizio.</p>}
        <p className="mu" style={st('font-size:13px;margin:10px 0 0')}>L’orario ricorrente dei corsi vale per tutto il semestre. Se cambi le date, le nuove settimane si riempiono da sole; le lezioni esistenti non vengono mai eliminate.</p>
      </div>
    </Modal>
  );
}

/** Confirmation used when deleting a course (design: "Eliminare … ?"). */
export function DeleteCourseDialog({ courseId, onDone, onClose }: { courseId: string; onDone: () => void; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const c = repo.course(courseId);
  if (!c) return null;
  const impact = repo.courseDeletionImpact(courseId);
  return (
    <ConfirmDialog
      title={`Eliminare ${c.name}?`}
      body={`Spariranno ${impact.lessons} lezioni e ${impact.registeredAttendances} presenze già registrate. ${impact.attempts ? 'L’esame e i tentativi restano nel libretto. ' : ''}${impact.documents ? 'I documenti collegati restano. ' : ''}Se vuoi solo toglierlo dal semestre, archivialo.`}
      confirmLabel="Elimina corso e presenze"
      danger
      extra={<Btn size="lg" onClick={() => { repo.updateCourse(courseId, { archived: true }); onClose(); onDone(); ui.toast('Corso archiviato'); }}>Archivia</Btn>}
      onConfirm={() => void ui.run(() => { repo.deleteCourse(courseId); onDone(); }, 'Corso eliminato')}
      onClose={onClose}
    />
  );
}

export { Glyph };
