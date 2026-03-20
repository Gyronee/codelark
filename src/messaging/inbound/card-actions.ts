import { logger } from '../../logger.js';

const pendingPermissions = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();

export function requestPermission(taskId: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingPermissions.has(taskId)) {
        pendingPermissions.delete(taskId);
        resolve(false);
        logger.info({ taskId }, 'Permission request timed out, auto-denied');
      }
    }, timeoutMs);
    if (timer.unref) timer.unref();

    pendingPermissions.set(taskId, { resolve, timer });

    if (signal) {
      const onAbort = () => {
        const entry = pendingPermissions.get(taskId);
        if (entry) {
          pendingPermissions.delete(taskId);
          clearTimeout(entry.timer);
          entry.resolve(false);
          logger.info({ taskId }, 'Permission request aborted');
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function resolvePermission(taskId: string, allowed: boolean): void {
  const entry = pendingPermissions.get(taskId);
  if (entry) {
    pendingPermissions.delete(taskId);
    clearTimeout(entry.timer);
    entry.resolve(allowed);
  }
}
