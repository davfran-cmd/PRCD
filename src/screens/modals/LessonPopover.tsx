import { useState } from 'react';
import { navigate } from '../../app/router';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { ATTENDANCE_LABELS, ATTENDANCE_ORDER } from '../../domain/attendance';
import { formatDayLong } from '../../domain/dates';
import { Btn, glyphOf, Modal, Swatch } from '../../ui/components';
import { st } from '../../ui/style';
import { LessonEditModal } from './LessonEditModal';

/** Lesson detail: one-tap attendance + links to the course and the schedule editor. */
export function LessonPopover({ lessonId, onClose }: { lessonId: string; onClose: () => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const lesson = useQuery((r) => r.lesson(lessonId), [lessonId]);
  const course = useQuery((r) => (lesson ? r.course(lesson.courseId) : undefined), [lesson?.courseId]);
  const count = useQuery((r) => (lesson ? r.lessonsForCourse(lesson.courseId).filter((l) => !l.cancelled) : []), [lesson?.courseId]);
  const [topic, setTopic] = useState<string | null>(null);
  if (!lesson || !course) return null;
  const nth = count.findIndex((l) => l.id === lesson.id) + 1;
  const sel = lesson.attendance;
  return (
    <Modal title={course.name} onClose={onClose} width={420} leading={<Swatch color={course.color} size={14} />}>
      <div style={st('padding:18px 24px 22px')}>
        <div className="mu" style={st('font-size:14px')}>
          {nth > 0 ? `Lezione ${nth} di ${count.length}. ` : ''}
          {formatDayLong(lesson.date)}, {lesson.startTime}–{lesson.endTime}
          {lesson.cancelled ? ' · annullata' : lesson.isException ? ' · spostata' : ''}
        </div>
        <div style={st('font-size:13px;font-weight:600;margin:14px 0 6px')}>Presenza</div>
        <div style={st('display:grid;gap:4px')}>
          {ATTENDANCE_ORDER.map((s) => (
            <button
              key={s}
              className={`btn ${sel === s ? 'sel' : ''}`}
              style={st('height:40px;justify-content:flex-start;gap:10px;padding:0 12px')}
              onClick={() => void ui.run(() => repo.setAttendance(lesson.id, s))}
              aria-pressed={sel === s}
            >
              <span className={`g ${glyphOf(s)}`} />
              {ATTENDANCE_LABELS[s]}
            </button>
          ))}
        </div>
        <label style={st('display:block;font-size:13px;font-weight:600;margin:14px 0 6px')} htmlFor="lp-topic">Argomento della lezione (facoltativo)</label>
        <input
          id="lp-topic"
          className="in"
          style={st('width:100%')}
          value={topic ?? lesson.topic}
          placeholder="Es. Circuiti RL, extracorrente"
          onChange={(e) => setTopic(e.target.value)}
          onBlur={() => topic !== null && topic !== lesson.topic && void ui.run(() => repo.updateLessonText(lesson.id, { topic: topic.trim() }))}
        />
        <div style={st('display:flex;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid #EBEBE6')}>
          <Btn style={st('flex:1')} onClick={() => { onClose(); navigate(`/corso/${course.id}`); }}>Apri corso</Btn>
          <Btn style={st('flex:1')} onClick={() => { onClose(); ui.modal((close) => <LessonEditModal lessonId={lesson.id} onClose={close} />); }}>Modifica</Btn>
        </div>
      </div>
    </Modal>
  );
}
