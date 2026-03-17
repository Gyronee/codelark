import { FlushController } from './flush-controller.js';
import { sendCard, updateCard, sendText } from '../messaging/outbound/send.js';
import { logger } from '../logger.js';

type Phase = 'idle' | 'creating' | 'streaming' | 'completed' | 'aborted' | 'error' | 'creation_failed';
const TERMINAL: Phase[] = ['completed', 'aborted', 'error', 'creation_failed'];

export class StreamingCard {
  private phase: Phase = 'idle';
  private cardMessageId: string | null = null;
  private createEpoch = 0;
  private flush: FlushController;
  private chatId: string;
  private threadId: string | null;

  constructor(chatId: string, threadId: string | null, throttleMs = 500) {
    this.chatId = chatId;
    this.threadId = threadId;
    this.flush = new FlushController(
      async (content) => {
        if (this.cardMessageId && this.phase === 'streaming') {
          await updateCard(this.cardMessageId, JSON.parse(content));
        }
      },
      throttleMs,
    );
  }

  get isTerminal(): boolean { return TERMINAL.includes(this.phase); }

  async create(card: object): Promise<void> {
    if (this.phase !== 'idle') return;
    this.phase = 'creating';
    this.createEpoch++;
    const epoch = this.createEpoch;
    const messageId = await sendCard(this.chatId, card, this.threadId ?? undefined);
    if (this.createEpoch !== epoch || this.isTerminal) return;
    if (messageId) { this.cardMessageId = messageId; this.phase = 'streaming'; }
    else { this.phase = 'creation_failed'; logger.warn({ chatId: this.chatId }, 'Card creation failed'); }
  }

  scheduleUpdate(card: object): void {
    if (this.phase !== 'streaming') return;
    this.flush.schedule(JSON.stringify(card));
  }

  async complete(card: object): Promise<void> {
    if (this.isTerminal) return;
    await this.flush.waitForFlush();
    this.flush.destroy();
    if (this.cardMessageId) await updateCard(this.cardMessageId, card);
    this.phase = 'completed';
  }

  async abort(card: object): Promise<void> {
    if (this.isTerminal) return;
    this.flush.destroy();
    if (this.cardMessageId) await updateCard(this.cardMessageId, card);
    this.phase = 'aborted';
  }

  async error(card: object): Promise<void> {
    if (this.isTerminal) return;
    this.flush.destroy();
    if (this.cardMessageId) await updateCard(this.cardMessageId, card);
    this.phase = 'error';
  }

  async fallbackText(text: string): Promise<void> {
    await sendText(this.chatId, text, this.threadId ?? undefined);
  }

  abortCard(): void {
    this.flush.destroy();
    this.phase = 'aborted';
  }
}
