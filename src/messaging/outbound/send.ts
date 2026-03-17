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

// ---------------------------------------------------------------------------
// Fetch message content (for reply-to context)
// ---------------------------------------------------------------------------

export async function fetchMessageContent(messageId: string): Promise<string | null> {
  try {
    const resp = await client.im.v1.message.get({
      path: { message_id: messageId },
    });
    const msg = resp?.data?.items?.[0] ?? resp?.data;
    const body = (msg as any)?.body;
    const content = body?.content ?? (msg as any)?.content;
    if (!content) return null;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return parsed?.text ?? JSON.stringify(parsed);
  } catch (err) {
    logger.debug({ err, messageId }, 'Failed to fetch message content');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Typing indicator (emoji reaction on user's message)
// ---------------------------------------------------------------------------

export async function addTypingReaction(messageId: string): Promise<string | null> {
  try {
    const resp = await (client.im.v1.messageReaction as any).create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: 'Typing' } },
    });
    return resp?.data?.reaction_id ?? null;
  } catch {
    // Best-effort, don't block
    return null;
  }
}

export async function removeTypingReaction(messageId: string, reactionId: string): Promise<void> {
  try {
    await (client.im.v1.messageReaction as any).delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// CardKit 2.0 streaming APIs
// ---------------------------------------------------------------------------

export async function createCardEntity(card: object): Promise<string | null> {
  try {
    const resp = await client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(card) },
    });
    if (resp?.code && resp.code !== 0) {
      logger.error({ code: resp.code, msg: resp.msg }, 'CardKit create returned error');
      return null;
    }
    return resp?.data?.card_id ?? null;
  } catch (err: any) {
    const respData = err?.response?.data;
    logger.error({ respData, status: err?.response?.status }, 'Failed to create CardKit entity');
    return null;
  }
}

export async function sendCardByCardId(
  chatId: string, cardId: string, threadId?: string,
): Promise<string | null> {
  try {
    const resp = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        msg_type: 'interactive' as any,
        ...(threadId ? { root_id: threadId } : {}),
      } as any,
    });
    return resp?.data?.message_id ?? null;
  } catch (err) {
    logger.error({ err, chatId, cardId }, 'Failed to send card by card_id');
    return null;
  }
}

export async function streamCardContent(
  cardId: string, elementId: string, content: string, sequence: number,
): Promise<boolean> {
  try {
    const resp = await client.cardkit.v1.cardElement.content({
      data: { content, sequence },
      path: { card_id: cardId, element_id: elementId },
    });
    if (resp?.code && resp.code !== 0) {
      logger.warn({ code: resp.code, msg: resp.msg }, 'streamCardContent non-zero code');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, cardId, elementId }, 'Failed to stream card content');
    return false;
  }
}

export async function updateCardKitCard(
  cardId: string, card: object, sequence: number,
): Promise<boolean> {
  try {
    const resp = await client.cardkit.v1.card.update({
      data: { card: { type: 'card_json' as const, data: JSON.stringify(card) }, sequence },
      path: { card_id: cardId },
    });
    if (resp?.code && resp.code !== 0) return false;
    return true;
  } catch (err) {
    logger.warn({ err, cardId }, 'Failed to update CardKit card');
    return false;
  }
}

export async function setCardStreamingMode(
  cardId: string, streamingMode: boolean, sequence: number,
): Promise<boolean> {
  try {
    const resp = await client.cardkit.v1.card.settings({
      data: { settings: JSON.stringify({ streaming_mode: streamingMode }), sequence },
      path: { card_id: cardId },
    });
    if (resp?.code && resp.code !== 0) return false;
    return true;
  } catch (err) {
    logger.warn({ err, cardId }, 'Failed to set streaming mode');
    return false;
  }
}
