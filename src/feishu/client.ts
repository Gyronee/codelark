import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

export class FeishuClient {
  public client: Lark.Client;
  public wsClient: Lark.WSClient;

  constructor(private config: Config) {
    const baseConfig = {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    };
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  async sendCard(chatId: string, card: object): Promise<string | null> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive' as any,
        },
      });
      return resp?.data?.message_id || null;
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send card');
      return null;
    }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err) {
      logger.warn({ err, messageId }, 'Failed to update card');
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text' as any,
        },
      });
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send text');
    }
  }

  start(eventDispatcher: Lark.EventDispatcher): void {
    this.wsClient.start({ eventDispatcher });
    logger.info('Feishu WebSocket client started');
  }
}
