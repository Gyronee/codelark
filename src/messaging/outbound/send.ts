import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../../config.js';
import { logger } from '../../logger.js';

let client: Lark.Client;
let wsClient: Lark.WSClient;

export function initFeishuClient(config: Config): { client: Lark.Client; wsClient: Lark.WSClient } {
  const baseConfig = { appId: config.feishu.appId, appSecret: config.feishu.appSecret };
  client = new Lark.Client(baseConfig);
  wsClient = new Lark.WSClient({ ...baseConfig, loggerLevel: Lark.LoggerLevel.info });
  return { client, wsClient };
}

export function startWebSocket(dispatcher: Lark.EventDispatcher): void {
  wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Feishu WebSocket client started');
}

export async function sendText(chatId: string, text: string, threadId?: string): Promise<void> {
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text' as any,
        ...(threadId ? { root_id: threadId } : {}),
      } as any,
    });
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to send text');
  }
}

export async function sendCard(chatId: string, card: object, threadId?: string): Promise<string | null> {
  try {
    const resp = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify(card),
        msg_type: 'interactive' as any,
        ...(threadId ? { root_id: threadId } : {}),
      } as any,
    });
    return resp?.data?.message_id || null;
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to send card');
    return null;
  }
}

export async function updateCard(messageId: string, card: object): Promise<boolean> {
  try {
    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    return true;
  } catch (err) {
    logger.warn({ err, messageId }, 'Failed to update card');
    return false;
  }
}
