/**
 * In-process pub/sub for published app bundle revisions.
 * Cloud App Host broadcasts when desktop sync notifies a repo update.
 */

export interface AppRevisionEvent {
  namespaceId: string;
  slug: string;
  revision: string;
}

export type AppRevisionListener = (event: AppRevisionEvent) => void;

export class AppRevisionHub {
  private readonly listeners = new Set<AppRevisionListener>();

  subscribe(listener: AppRevisionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: AppRevisionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[AppRevisionHub] listener error:", err);
      }
    }
  }
}

let hubInstance: AppRevisionHub | null = null;

export function getAppRevisionHub(): AppRevisionHub {
  if (!hubInstance) {
    hubInstance = new AppRevisionHub();
  }
  return hubInstance;
}

/** Test-only reset */
export function resetAppRevisionHubForTests(): void {
  hubInstance = null;
}
