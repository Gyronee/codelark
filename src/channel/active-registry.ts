export interface ActiveDispatcher {
  abortController: AbortController;
  abortCard: () => void;
  userId: string;
}

const registry = new Map<string, ActiveDispatcher>();

export function setActive(key: string, dispatcher: ActiveDispatcher): void { registry.set(key, dispatcher); }
export function getActive(key: string): ActiveDispatcher | undefined { return registry.get(key); }
export function getByUserId(userId: string): [string, ActiveDispatcher] | undefined {
  for (const [key, d] of registry) { if (d.userId === userId) return [key, d]; }
  return undefined;
}
export function removeActive(key: string): void { registry.delete(key); }
export function abortAll(): void {
  for (const [, d] of registry) { d.abortController.abort(); d.abortCard(); }
  registry.clear();
}
