import { logger } from '../../logger.js';

const pendingPermissions = new Map<string, (allowed: boolean) => void>();

export function requestPermission(taskId: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    pendingPermissions.set(taskId, resolve);
    const timer = setTimeout(() => {
      if (pendingPermissions.has(taskId)) {
        pendingPermissions.delete(taskId);
        resolve(false);
        logger.info({ taskId }, 'Permission request timed out, auto-denied');
      }
    }, timeoutMs);
    if (timer.unref) timer.unref();
    // Abort signal support — resolve immediately on cancel
    if (signal) {
      const onAbort = () => {
        if (pendingPermissions.has(taskId)) {
          pendingPermissions.delete(taskId);
          clearTimeout(timer);
          resolve(false);
          logger.info({ taskId }, 'Permission request aborted');
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function resolvePermission(taskId: string, allowed: boolean): void {
  const resolve = pendingPermissions.get(taskId);
  if (resolve) {
    pendingPermissions.delete(taskId);
    resolve(allowed);
  }
}
