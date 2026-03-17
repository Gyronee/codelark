import type { SessionManager } from '../session/manager.js';
import type { Database } from '../session/db.js';
import { logger } from '../logger.js';

export interface CardAction {
  action: string;
  taskId?: string;
}

export function handleCardAction(
  actionValue: CardAction,
  userId: string,
  sessionManager: SessionManager,
  db?: Database,
): void {
  switch (actionValue.action) {
    case 'cancel_task': {
      sessionManager.cancelTask(userId);
      logger.info({ userId }, 'Task cancelled via card button');
      break;
    }
    case 'reset_session': {
      if (db) {
        const user = db.getUser(userId);
        if (user?.active_project) {
          sessionManager.reset(userId, null, user.active_project);
          logger.info({ userId, project: user.active_project }, 'Session reset via card button');
        }
      }
      break;
    }
    case 'confirm_danger':
    case 'reject_danger': {
      // Handled in handler.ts via pendingPermissions map
      logger.info({ userId, action: actionValue.action }, 'Danger action received');
      break;
    }
    default:
      logger.warn({ action: actionValue.action }, 'Unknown card action');
  }
}
