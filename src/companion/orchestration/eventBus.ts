import type { CompanionEvent } from '../../shared/api.js';

export type EventListener = (event: CompanionEvent) => void;

/** In-process fan-out of state changes to connected UIs. */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: CompanionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never disturb the orchestration.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
