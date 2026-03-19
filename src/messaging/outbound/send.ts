import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../../config.js';
import { logger } from '../../logger.js';

let client: Lark.Client;
let wsClient: Lark.WSClient;

export function getClient(): Lark.Client {
  if (!client) throw new Error('Feishu client not initialized — call initFeishuClient first');
  return client;
}

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

/** Reply to a specific message with a card (uses im.message.reply instead of create) */
export async function replyCardToMessage(replyToMessageId: string, card: object): Promise<string | null> {
  try {
    const resp = await (client.im.v1.message as any).reply({
      path: { message_id: replyToMessageId },
      data: {
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
    return resp?.data?.message_id ?? null;
  } catch (err) {
    logger.error({ err, replyToMessageId }, 'Failed to reply with card');
    return null;
  }
}

/** Reply to a specific message by card_id (CardKit mode) */
export async function replyCardByCardId(replyToMessageId: string, cardId: string): Promise<string | null> {
  try {
    const resp = await (client.im.v1.message as any).reply({
      path: { message_id: replyToMessageId },
      data: {
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        msg_type: 'interactive',
      },
    });
    return resp?.data?.message_id ?? null;
  } catch (err) {
    logger.error({ err, replyToMessageId, cardId }, 'Failed to reply with card_id');
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
    // Use mget endpoint with raw_card_content to get actual card JSON (not preview)
    const resp = await (client as any).request({
      method: 'GET',
      url: '/open-apis/im/v1/messages/mget',
      params: {
        message_ids: messageId,
        user_id_type: 'open_id',
        card_msg_content_type: 'raw_card_content',
      },
    });
    const items = resp?.data?.items;
    if (!items || items.length === 0) return null;

    const msg = items[0];
    const msgType = msg.msg_type ?? 'text';
    const rawContent = msg.body?.content ?? '{}';
    const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;

    // Text message
    if (msgType === 'text') {
      return parsed?.text ?? null;
    }
    // Interactive card — extract markdown from elements
    if (msgType === 'interactive') {
      const elements = parsed?.elements ?? parsed?.body?.elements ?? [];
      const texts: string[] = [];
      for (const el of elements) {
        if (el?.tag === 'div' && el?.text?.content) texts.push(el.text.content);
        if (el?.tag === 'markdown' && el?.content) texts.push(el.content);
      }
      return texts.join('\n').trim() || null;
    }
    // Post (rich text)
    if (msgType === 'post') {
      const locale = parsed?.zh_cn ?? parsed?.en_us ?? Object.values(parsed)[0];
      if (locale?.content) {
        const texts: string[] = [];
        for (const para of locale.content) {
          if (Array.isArray(para)) {
            texts.push(para.map((el: any) => el.text ?? '').join(''));
          }
        }
        return texts.join('\n').trim() || null;
      }
    }
    // Fallback
    return typeof rawContent === 'string' ? rawContent.slice(0, 500) : JSON.stringify(parsed).slice(0, 500);
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
