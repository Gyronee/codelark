import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../../config.js';
import type { Database } from '../../session/db.js';
import type { SessionManager } from '../../session/manager.js';
import type { ProjectManager } from '../../project/manager.js';
import { Dedup } from './dedup.js';
import { parseMessageEvent } from './parse.js';
import { checkGate } from './gate.js';
import { dispatch } from './dispatch.js';
import { ChatQueue, buildQueueKey } from '../../channel/chat-queue.js';
import * as registry from '../../channel/active-registry.js';
import { logger } from '../../logger.js';

export interface PipelineDeps {
  config: Config;
  db: Database;
  sessionManager: SessionManager;
  projectManager: ProjectManager;
  botOpenId: string;
}

export function createPipeline(deps: PipelineDeps): {
  dispatcher: Lark.EventDispatcher;
  dedup: Dedup;
  queue: ChatQueue;
} {
  const dedup = new Dedup();
  const queue = new ChatQueue();

  const dispatcher = new Lark.EventDispatcher({});
  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        // Stage 1: App ID validation
        if (data.app_id && data.app_id !== deps.config.feishu.appId) {
          logger.debug({ appId: data.app_id }, 'Ignoring event from different app');
          return;
        }

        const eventId = data.event_id;
        const createTime = Number(data.message?.create_time ?? 0);

        // Stage 1b: Fast cancel detection — strip mention keys before matching
        const rawContent = data.message?.content ? JSON.parse(data.message.content) : {};
        let rawText = (rawContent?.text ?? '').trim();
        const rawMentions: any[] = data.message?.mentions ?? [];
        for (const m of rawMentions) {
          if (m.key) rawText = rawText.replace(m.key, '');
        }
        rawText = rawText.trim();
        if (rawText === '/cancel') {
          const chatId = data.message?.chat_id;
          const threadId = data.message?.root_id || null;
          if (chatId) {
            const key = buildQueueKey(chatId, threadId);
            const active = registry.getActive(key);
            if (active) {
              active.abortController.abort();
              active.abortCard();
              registry.removeActive(key);
              logger.info({ key }, 'Fast cancel: task aborted');
              return;
            }
          }
          // No active task — fall through to dispatch as fallback
        }

        // Stage 2: Dedup
        if (!dedup.check(eventId, createTime)) {
          logger.debug({ eventId }, 'Ignoring duplicate/stale event');
          return;
        }

        // Stage 3: Parse
        const ctx = parseMessageEvent(data, deps.botOpenId);
        logger.info({ eventId, chatId: ctx.chatId, text: ctx.text.slice(0, 50) }, 'Processing message');

        // Stage 4: Gate
        if (checkGate(ctx, deps.config) === 'reject') {
          return;
        }

        // Stage 5: Enqueue
        const queueKey = buildQueueKey(ctx.chatId, ctx.threadId);
        queue.enqueue(queueKey, async () => {
          // Stage 6+7: Dispatch
          await dispatch(ctx, deps.config, deps.db, deps.sessionManager, deps.projectManager);
        });
      } catch (err) {
        logger.error({ err }, 'Unhandled error in message pipeline');
      }
    },
  });

  return { dispatcher, dedup, queue };
}
