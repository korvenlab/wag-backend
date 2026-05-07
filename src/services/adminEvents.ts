import { randomUUID } from 'crypto';

export type AdminApp = 'wagoo' | '2avendas' | 'core';
export type AdminEventStatus = 'online' | 'degraded' | 'offline';

export interface AdminEventRow {
  id: string;
  timestamp: string;
  app: AdminApp;
  message: string;
  status: AdminEventStatus;
}

const MAX_EVENTS = 300;
const events: AdminEventRow[] = [];

export function pushAdminEvent(
  app: AdminApp,
  message: string,
  status: AdminEventStatus = 'online'
): void {
  const timestamp = new Date().toISOString();
  events.unshift({
    id: randomUUID(),
    timestamp,
    app,
    message,
    status,
  });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

export function getAdminEvents(limit = 100): AdminEventRow[] {
  return events.slice(0, Math.min(limit, MAX_EVENTS));
}
