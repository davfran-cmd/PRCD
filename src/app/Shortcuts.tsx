import { useEffect } from 'react';
import { navigate } from './router';
import { useServices, useUi } from './AppContext';
import { GlobalSearch } from './GlobalSearch';
import { EventModal } from '../screens/modals/EventModal';
import { todayISO } from '../domain/dates';

/**
 * Keyboard shortcuts from the design (Navigazione): ⌘1–5 sections, ⌘K search, ⌘N new event,
 * ⇧⌘N new note (in the open course), ⌘R attendance, ⌘T calendar on today, ⌘\ sidebar.
 * Ctrl is accepted too, for external keyboards on other platforms.
 */
export function Shortcuts() {
  const ui = useUi();
  const { docs } = useServices();
  useEffect(() => {
    const SECTIONS = ['/oggi', '/calendario', '/universita', '/documenti', '/statistiche'];
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const handled = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (/^[1-5]$/.test(k)) return handled(() => navigate(SECTIONS[Number(k) - 1]));
      if (k === 'k') return handled(() => ui.modal((close) => <GlobalSearch onClose={close} />));
      if (k === 'n' && !e.shiftKey) return handled(() => ui.modal((close) => <EventModal date={todayISO()} onClose={close} />));
      if (k === 'n' && e.shiftKey) {
        return handled(() => {
          const m = /^#\/corso\/([^/?]+)/.exec(window.location.hash);
          void ui.run(async () => {
            const note = await docs.createNote('Nuova nota', null, m ? decodeURIComponent(m[1]) : null);
            navigate(`/documento/${note.id}`);
          });
        });
      }
      if (k === 'r') return handled(() => navigate('/presenze'));
      if (k === 't') return handled(() => navigate(`/calendario/settimana?d=${todayISO()}`));
      if (k === '\\') return handled(() => window.dispatchEvent(new Event('prcd:toggle-sidebar')));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, docs]);
  return null;
}
