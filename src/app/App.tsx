import { useEffect } from 'react';
import { useRoute } from './router';
import { ServicesProvider, UiProvider, useServices, useQuery, type Services } from './AppContext';
import { Oggi } from '../screens/Oggi';
import { Universita } from '../screens/Universita';
import { Corso } from '../screens/Corso';
import { Presenze } from '../screens/Presenze';
import { Libretto } from '../screens/Libretto';
import { Calendario } from '../screens/Calendario';
import { Statistiche } from '../screens/Statistiche';
import { Documenti } from '../screens/Documenti';
import { Reader } from '../screens/Reader';
import { Impostazioni } from '../screens/Impostazioni';
import { CalendariApple } from '../screens/CalendariApple';
import { Shortcuts } from './Shortcuts';
import { listenForAttendanceActions, scheduleLessonReminders } from './notifications';

function Routes() {
  const route = useRoute();
  const [head, a, b] = route.path;
  switch (head) {
    case undefined:
    case 'oggi':
      return <Oggi />;
    case 'calendario':
      return <Calendario view={a === 'giorno' || a === 'mese' ? a : 'settimana'} />;
    case 'calendari':
      return <CalendariApple />;
    case 'universita':
      return <Universita />;
    case 'corso':
      return a ? <Corso id={a} /> : <Universita />;
    case 'presenze':
      return <Presenze />;
    case 'libretto':
      return <Libretto />;
    case 'statistiche':
      return <Statistiche />;
    case 'documenti':
      return <Documenti />;
    case 'documento':
      return a ? <Reader id={a} /> : <Documenti />;
    case 'impostazioni':
      return <Impostazioni cat={a ?? 'generale'} />;
    default:
      void b;
      return <Oggi />;
  }
}

/** Keeps the end-of-lesson reminders in step with the timetable (native only). */
function Reminders() {
  const { repo } = useServices();
  const key = useQuery((r) => `${r.getSettings().endOfLessonReminder}:${r.allLessons().filter((l) => l.attendance === 'to_confirm' && !l.cancelled).length}:${r.allLessons().length}`);
  useEffect(() => {
    void scheduleLessonReminders(repo).catch(() => undefined);
  }, [repo, key]);
  useEffect(() => {
    let off = () => {};
    void listenForAttendanceActions(repo).then((o) => (off = o));
    return () => off();
  }, [repo]);
  return null;
}

export function App({ services }: { services: Services }) {
  return (
    <ServicesProvider services={services}>
      <UiProvider>
        <Routes />
        <Reminders />
        <Shortcuts />
      </UiProvider>
    </ServicesProvider>
  );
}
