import { randomUUID } from 'crypto';
import { publishControlPlaneEvent } from './controlPlanePublisher';

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
  const id = randomUUID();
  events.unshift({
    id,
    timestamp,
    app,
    message,
    status,
  });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  void publishControlPlaneEvent({
    eventId: id,
    eventType: 'admin.event',
    occurredAt: timestamp,
    externalUserId: 'system',
    payload: { app, message, status },
  });
}

export function getAdminEvents(limit = 100): AdminEventRow[] {
  return events.slice(0, Math.min(limit, MAX_EVENTS));
}
