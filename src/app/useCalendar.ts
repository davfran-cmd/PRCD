import { useSyncExternalStore } from 'react';
import { useServices } from './AppContext';
import type { CalendarState } from '../calendar/service';

export function useCalendarState(): CalendarState {
  const { calendar } = useServices();
  return useSyncExternalStore(calendar.subscribe, calendar.getState);
}
