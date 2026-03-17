import type { MessageContext } from '../types.js';
import type { Config } from '../../config.js';
import { logger } from '../../logger.js';

export function checkGate(ctx: MessageContext, config: Config): 'pass' | 'reject' {
  if (ctx.text === '/whoami') return 'pass';
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(ctx.senderId)) {
    logger.debug({ senderId: ctx.senderId }, 'Gate: user not in allowlist');
    return 'reject';
  }
  if (ctx.chatType === 'group') {
    if (config.allowedGroupIds.length > 0 && !config.allowedGroupIds.includes(ctx.chatId)) {
      logger.debug({ chatId: ctx.chatId }, 'Gate: group not in allowlist');
      return 'reject';
    }
    if (!ctx.botMentioned) {
      logger.debug({ chatId: ctx.chatId }, 'Gate: bot not mentioned');
      return 'reject';
    }
  }
  return 'pass';
}
