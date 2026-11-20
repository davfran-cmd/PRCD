import { useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { useNow, useQuery, useServices } from '../app/AppContext';
import { attendanceGradeInsight, attendanceGradePoints, courseSummary, librettoEntries } from '../app/queries';
import { buildTimeline } from '../app/timeline';
import { absencesByWeekday, attendanceTrend, weeklyAttendance } from '../domain/analytics';
import { computeAttendance } from '../domain/attendance';
import { durationMinutes, formatNumberIT, splitLocalDateTime, WEEKDAYS_SHORT_IT, addDays } from '../domain/dates';
import { averagesFromEntries, gradeValue } from '../domain/grades';
import { Seg, Swatch } from '../ui/components';
import { st } from '../ui/style';

type Period = 'semestre' | 'tutto';

export function Statistiche() {
  const { repo } = useServices();
  const now = useNow();
  const [period, setPeriod] = useState<Period>('tutto');
  const settings = useQuery((r) => r.getSettings());
  const sem = useQuery((r) => r.currentSemester());
  const semesters = useQuery((r) => r.semesters(), []);
  const data = useQuery(
    (r) => {
      const allCourses = r.courses({ includeArchived: true, includeHidden: true });
      const courses = period === 'semestre' && sem ? allCourses.filter((c) => c.semesterId === sem.id) : allCourses;
      const ids = new Set(courses.map((c) => c.id));
      const lessons = r.allLessons().filter((l) => ids.has(l.courseId));
      const points = attendanceGradePoints(r, now.local).filter((p) => ids.has(p.courseId));
      return { courses, lessons, points };
    },
    [period, sem?.id, now.local.slice(0, 13)],
  );

  const insight = attendanceGradeInsight(data.points, settings.attendanceThreshold);
  const weeks = weeklyAttendance(data.lessons.filter((l) => !l.cancelled), settings, now.local).filter((w) => w.held > 0 || true);
  const trend = attendanceTrend(weeks.filter((w) => w.held > 0), settings.attendanceThreshold);
  const byDay = absencesByWeekday(data.lessons);
  const maxAbs = Math.max(...byDay);

  const semRows = useQuery(
    (r) =>
      semesters
        .map((s) => {
          const ls = r.lessonsForSemester(s.id);
          const st2 = computeAttendance(ls, now.local, settings);
          const entries = librettoEntries(r).filter((e) => e.course.semesterId === s.id);
          const a = averagesFromEntries(entries, { lodeValue: settings.lodeValue, graduationScale: settings.graduationScale });
          return { s, p: st2.percentage, w: a.weighted, exams: a.gradedExams };
        })
        .filter((x) => x.p !== null || x.w !== null)
        .reverse(),
    [semesters.length, now.local.slice(0, 13), settings.recoveredCountsAsAttended],
  );

  const study = useQuery(
    (r) => {
      const from = period === 'semestre' && sem ? sem.startDate : '2000-01-01';
      const to = period === 'semestre' && sem ? sem.endDate : addDays(now.today, 365);
      const evs = buildTimeline(r, from, to).filter((i) => i.kind === 'event' && i.category === 'study' && i.courseId);
      const per = new Map<string, { minutes: number; planned: number; done: number }>();
      for (const e of evs) {
        const cur = per.get(e.courseId as string) ?? { minutes: 0, planned: 0, done: 0 };
        cur.planned += 1;
        if (e.completed) {
          cur.done += 1;
          cur.minutes += Math.max(0, durationMinutes(splitLocalDateTime(e.start).time, splitLocalDateTime(e.end).time));
        }
        per.set(e.courseId as string, cur);
      }
      return per;
    },
    [period, sem?.id],
  );

  const W = 370;
  const H = 196;
  const studyRows = data.courses
    .map((c) => ({ c, ...(study.get(c.id) ?? { minutes: 0, planned: 0, done: 0 }), pct: courseSummary(repo, c, now.local).stats.percentage }))
    .filter((x) => x.planned > 0)
    .sort((a, b) => b.minutes - a.minutes);
  const maxMin = Math.max(1, ...studyRows.map((x) => x.minutes));
  const totalDone = studyRows.reduce((a, x) => a + x.done, 0);
  const totalPlanned = studyRows.reduce((a, x) => a + x.planned, 0);

  return (
    <div className="app">
      <Sidebar active="sta" />
      <main className="main scroll" style={st('padding:24px 32px 24px')}>
        <header style={st('display:flex;align-items:flex-end;gap:12px;flex:none')}>
          <h1 className="pt m" style={st('flex:1')}>Statistiche</h1>
          <Seg label="Periodo" value={period} onChange={setPeriod} options={[{ value: 'semestre', label: 'Semestre' }, { value: 'tutto', label: 'Tutto il percorso' }]} />
        </header>
        <div className="grid-md-1" style={st('display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin-top:18px;border-top:2px solid #000')}>
          <Q style={st('border-right:1px solid #DCDCD6;border-bottom:1px solid #DCDCD6;padding:18px 24px 22px 0')} title="Chi frequenta di più prende voti più alti?" text={insight.text}>
            {data.points.length >= 1 && (
              <div style={{ position: 'relative', margin: '18px 0 0 34px', width: W, maxWidth: 'calc(100% - 40px)', height: H, borderLeft: '1px solid #000', borderBottom: '1px solid #000' }}>
                {data.points.map((p) => (
                  <div key={p.courseId} style={{ position: 'absolute', left: `${Math.max(0, Math.min(100, ((p.attendance - 50) / 50) * 100))}%`, top: Math.round(((30 - p.grade) / 12) * H), transform: 'translate(-6px,-6px)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={st('width:12px;height:12px;border-radius:6px;background:#000;flex:none')} />
                    <span style={st('font-size:12px;white-space:nowrap;background:#fff')}>{p.name} {p.lode ? '30L' : p.grade}</span>
                  </div>
                ))}
                {[['30', -6], ['26', 59], ['22', 125], ['18', 186]].map(([l, y]) => <span key={l} className="ax" style={{ position: 'absolute', left: -28, top: Number(y), fontSize: 11, color: '#5F5F59' }}>{l}</span>)}
                {[['50%', '0%'], ['75%', '50%'], ['100%', '100%']].map(([l, x]) => <span key={l} style={{ position: 'absolute', left: x, top: H + 4, fontSize: 11, color: '#5F5F59', transform: 'translateX(-50%)' }}>{l}</span>)}
              </div>
            )}
            <div className="mu" style={st('font-size:12px;margin:26px 0 0 34px')}>Asse orizzontale: presenza al corso. Verticale: voto finale.</div>
          </Q>
          <Q style={st('border-bottom:1px solid #DCDCD6;padding:18px 0 22px 24px')} title="La presenza sta calando?" text={trend.text}>
            {weeks.length > 0 && (
              <>
                <div style={st('display:flex;align-items:flex-end;gap:6px;height:170px;margin-top:22px;border-bottom:1px solid #000;position:relative')}>
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: (settings.attendanceThreshold / 100) * 170, borderTop: '1px dashed #9A9A93' }} />
                  <span style={{ position: 'absolute', right: 0, bottom: (settings.attendanceThreshold / 100) * 170 + 4, fontSize: 11, color: '#5F5F59' }}>{settings.attendanceThreshold}%, la tua soglia</span>
                  {weeks.map((w) => (
                    <div key={w.week} title={w.week} style={st('flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0')}>
                      <span style={st('font-size:11px;font-weight:600')}>{w.pct === null ? '' : Math.round(w.pct)}</span>
                      <span style={{ width: '100%', height: w.pct === null ? 4 : Math.max(2, w.pct * 1.7), background: w.pct === null ? '#EBEBE6' : w.pct < settings.attendanceThreshold ? '#C2410C' : '#000' }} />
                    </div>
                  ))}
                </div>
                <div className="mu" style={st('display:flex;justify-content:space-between;font-size:11px;margin-top:4px')}><span>prima settimana</span><span>ultima</span></div>
                <div style={st('display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;margin-top:14px;font-size:12px;text-align:center')}>
                  {byDay.slice(0, 5).map((n, i) => (
                    <span key={i}><b style={{ fontSize: 16, color: n === maxAbs && n > 0 ? '#B23A0A' : '#000' }}>{n}</b><br /><span className="mu">{i === 0 ? 'assenze ' : ''}{WEEKDAYS_SHORT_IT[i]}</span></span>
                  ))}
                </div>
              </>
            )}
          </Q>
          <Q style={st('border-right:1px solid #DCDCD6;padding:18px 24px 22px 0')} title="Come si confrontano i semestri?" text={semRows.length < 2 ? 'Servono almeno due semestri con presenze o esami per un confronto.' : semesterText(semRows)}>
            <div style={st('margin-top:16px;display:flex;flex-direction:column;gap:12px')}>
              {semRows.map((r) => (
                <div key={r.s.id} style={st('display:grid;grid-template-columns:110px 1fr 70px;gap:10px;align-items:center;font-size:13px')}>
                  <span style={st('font-weight:600')}>{r.s.name}</span>
                  <span style={st('display:flex;flex-direction:column;gap:3px')}>
                    <span style={{ height: 12, width: `${r.p ?? 0}%`, background: '#000' }} />
                    <span style={{ height: 12, width: `${r.w === null ? 0 : ((r.w - 18) / 12) * 100}%`, background: '#1F35C7' }} />
                  </span>
                  <span style={st('text-align:right;line-height:1.35')}>{r.p === null ? '–' : `${formatNumberIT(r.p, 0)}%`}<br /><b>{r.w === null ? 'esami da fare' : formatNumberIT(r.w, 2)}</b></span>
                </div>
              ))}
              {semRows.length > 0 && <div className="mu" style={st('display:flex;gap:16px;font-size:12px;flex-wrap:wrap')}><span style={st('display:flex;gap:6px;align-items:center')}><span style={st('width:12px;height:12px;background:#000')} />presenza</span><span style={st('display:flex;gap:6px;align-items:center')}><span style={st('width:12px;height:12px;background:#1F35C7')} />media ponderata, scala 18–30</span></div>}
            </div>
          </Q>
          <Q style={st('padding:18px 0 22px 24px')} title="Dove va il tuo tempo di studio?" text={studyRows.length ? `${formatNumberIT(studyRows.reduce((a, x) => a + x.minutes, 0) / 60, 0)} ore registrate, ${totalDone} sessioni completate su ${totalPlanned} pianificate. Le sessioni contano quando le segni come fatte.` : 'Pianifica sessioni di studio dal calendario, collegandole a un corso, e segnale come fatte: qui vedrai dove va il tempo.'}>
            <div style={st('margin-top:16px;display:flex;flex-direction:column;gap:9px')}>
              {studyRows.map((x) => (
                <div key={x.c.id} style={st('display:grid;grid-template-columns:150px 1fr 44px 48px;gap:10px;align-items:center;font-size:13px')}>
                  <span style={st('display:flex;align-items:center;gap:8px;min-width:0')}><Swatch color={x.c.color} /><span style={st('white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{x.c.name}</span></span>
                  <span style={st('height:14px;background:#F2F2EF')}><span style={{ display: 'block', height: 14, width: `${(x.minutes / maxMin) * 100}%`, background: x.c.color }} /></span>
                  <span style={st('text-align:right;font-weight:650')}>{formatNumberIT(x.minutes / 60, 1)} h</span>
                  <span className="mu" style={st('text-align:right')}>{x.pct === null ? '–' : `${formatNumberIT(x.pct, 0)}%`}</span>
                </div>
              ))}
              {studyRows.length > 0 && <div className="mu" style={st('font-size:12px;text-align:right')}>ultima colonna: presenza</div>}
            </div>
          </Q>
        </div>
      </main>
    </div>
  );
}

function semesterText(rows: Array<{ s: { name: string }; p: number | null; w: number | null }>): string {
  const withP = rows.filter((r) => r.p !== null);
  if (withP.length < 2) return 'Confronto tra semestri su presenza e media ponderata.';
  const best = [...withP].sort((a, b) => (b.p as number) - (a.p as number))[0];
  const worst = [...withP].sort((a, b) => (a.p as number) - (b.p as number))[0];
  return `Presenza più alta: ${best.s.name} (${formatNumberIT(best.p as number, 0)}%); più bassa: ${worst.s.name} (${formatNumberIT(worst.p as number, 0)}%). Le medie si riferiscono solo agli esami superati in ciascun semestre.`;
}

function Q({ title, text, children, style }: { title: string; text: string; children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ minWidth: 0, ...style }}>
      <h2 style={st('margin:0;font-size:22px;font-weight:750;letter-spacing:-0.02em;line-height:1.15')}>{title}</h2>
      <p style={st('margin:8px 0 0;font-size:14px;max-width:62ch;color:#3A3A36')}>{text}</p>
      {children}
    </section>
  );
}

export { gradeValue };
