import { randomUUID } from 'node:crypto';
import type { ForgeEventName } from '../../shared/contracts.js';
import type { Logger } from './logger.js';

type Listener = (event: DomainEvent) => void | Promise<void>;
export interface DomainEvent {
  id: string;
  name: ForgeEventName;
  occurredAt: string;
  correlationId: string;
  payload: unknown;
}

export class EventBus {
  private readonly listeners = new Map<ForgeEventName, Set<Listener>>();
  constructor(private readonly logger: Logger) {}

  subscribe(name: ForgeEventName, listener: Listener): () => void {
    const set = this.listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(name, set);
    return () => set.delete(listener);
  }

  async publish(name: ForgeEventName, payload: unknown, correlationId: string): Promise<void> {
    const event: DomainEvent = {
      id: randomUUID(),
      name,
      occurredAt: new Date().toISOString(),
      correlationId,
      payload,
    };
    const results = await Promise.allSettled(
      [...(this.listeners.get(name) ?? [])].map(async (listener) => listener(event)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        await this.logger.write('error', 'application', 'event.listenerFailed', {
          name,
          correlationId,
        });
      }
    }
  }
}
