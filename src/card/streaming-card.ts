import { FlushController } from './flush-controller.js';
import {
  sendCard, updateCard, sendText,
  createCardEntity, sendCardByCardId, streamCardContent,
  updateCardKitCard, setCardStreamingMode,
  addTypingReaction, removeTypingReaction,
} from '../messaging/outbound/send.js';
import { CardBuilder } from './builder.js';
import { optimizeMarkdownStyle } from './markdown-style.js';
import { logger } from '../logger.js';

type Phase = 'idle' | 'waiting' | 'creating' | 'streaming' | 'completed' | 'aborted' | 'error' | 'creation_failed';
const TERMINAL: Phase[] = ['completed', 'aborted', 'error', 'creation_failed'];

export const STREAMING_ELEMENT_ID = 'streaming_content';
const CARDKIT_THROTTLE_MS = 100;
const IM_THROTTLE_MS = 1500;

/** CardKit 2.0 initial card with streaming_mode and loading icon */
function buildStreamingThinkingCard(): object {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: 'Thinking...' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          text_align: 'left',
          element_id: STREAMING_ELEMENT_ID,
        },
      ],
    },
  };
}

export class StreamingCard {
  private phase: Phase = 'idle';
  private cardMessageId: string | null = null;
  private cardKitCardId: string | null = null;
  private cardKitSequence = 0;
  private createEpoch = 0;
  private flush: FlushController;
  private chatId: string;
  private threadId: string | null;
  private userMessageId: string | null;
  private typingReactionId: string | null = null;

  constructor(chatId: string, threadId: string | null, userMessageId: string | null) {
    this.chatId = chatId;
    this.threadId = threadId;
    this.userMessageId = userMessageId;
    this.flush = new FlushController(
      async (content) => {
        if (this.phase !== 'streaming') return;
        if (this.cardKitCardId) {
          this.cardKitSequence++;
          await streamCardContent(
            this.cardKitCardId, STREAMING_ELEMENT_ID, optimizeMarkdownStyle(content), this.cardKitSequence,
          );
        } else if (this.cardMessageId) {
          const fallbackCard = {
            header: { title: { tag: 'plain_text', content: '🔧 Working...' }, template: 'orange' },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
          };
          await updateCard(this.cardMessageId, fallbackCard);
        }
      },
      CARDKIT_THROTTLE_MS, // will degrade to IM_THROTTLE_MS if CardKit fails
    );
  }

  get isTerminal(): boolean { return TERMINAL.includes(this.phase); }

  /** Step 1: Add typing reaction on user's message — call immediately */
  async startTyping(): Promise<void> {
    this.phase = 'waiting';
    if (this.userMessageId) {
      this.typingReactionId = await addTypingReaction(this.userMessageId);
    }
  }

  /** Step 2: Create card — call when first content arrives */
  private async ensureCardCreated(): Promise<void> {
    if (this.cardMessageId || this.phase === 'streaming' || this.phase === 'creating' || this.isTerminal) return;
    this.phase = 'creating';
    this.createEpoch++;
    const epoch = this.createEpoch;

    // Try CardKit 2.0 first
    const cardId = await createCardEntity(buildStreamingThinkingCard());
    if (this.createEpoch !== epoch || this.isTerminal) return;

    if (cardId) {
      this.cardKitCardId = cardId;
      this.cardKitSequence = 1;
      const messageId = await sendCardByCardId(this.chatId, cardId, this.threadId ?? undefined);
      if (this.createEpoch !== epoch || this.isTerminal) return;

      if (messageId) {
        this.cardMessageId = messageId;
        this.phase = 'streaming';
        logger.info({ cardId, messageId }, 'CardKit streaming card created');
        return;
      }
    }

    // CardKit failed — fallback to IM card
    logger.warn('CardKit failed, falling back to IM card');
    this.cardKitCardId = null;
    this.flush = new FlushController(this.flush['updateFn'], IM_THROTTLE_MS);
    const thinkingCard = CardBuilder.thinking('Working');
    const messageId = await sendCard(this.chatId, thinkingCard, this.threadId ?? undefined);
    if (this.createEpoch !== epoch || this.isTerminal) return;
    if (messageId) {
      this.cardMessageId = messageId;
      this.phase = 'streaming';
    } else {
      this.phase = 'creation_failed';
      logger.warn('Card creation failed entirely');
    }
  }

  /** Schedule streaming text — creates card on first call */
  async scheduleStreamText(text: string): Promise<void> {
    if (this.isTerminal) return;
    if (!this.cardMessageId && this.phase !== 'creating') {
      await this.ensureCardCreated();
    }
    if (this.phase !== 'streaming') return;
    this.flush.schedule(text);
  }

  async complete(card: object): Promise<void> {
    if (this.isTerminal) return;
    await this.flush.waitForFlush();
    this.flush.destroy();

    if (this.cardKitCardId) {
      this.cardKitSequence++;
      await setCardStreamingMode(this.cardKitCardId, false, this.cardKitSequence);
      this.cardKitSequence++;
      await updateCardKitCard(this.cardKitCardId, CardBuilder.toCardKit2(card as any), this.cardKitSequence);
    } else if (this.cardMessageId) {
      await updateCard(this.cardMessageId, card);
    }
    this.phase = 'completed';
    await this.removeTyping();
  }

  async abort(card: object): Promise<void> {
    if (this.isTerminal) return;
    this.flush.destroy();

    if (this.cardKitCardId) {
      this.cardKitSequence++;
      await setCardStreamingMode(this.cardKitCardId, false, this.cardKitSequence);
      this.cardKitSequence++;
      await updateCardKitCard(this.cardKitCardId, CardBuilder.toCardKit2(card as any), this.cardKitSequence);
    } else if (this.cardMessageId) {
      await updateCard(this.cardMessageId, card);
    }
    this.phase = 'aborted';
    await this.removeTyping();
  }

  async error(card: object): Promise<void> {
    if (this.isTerminal) return;
    this.flush.destroy();

    if (this.cardKitCardId) {
      this.cardKitSequence++;
      await setCardStreamingMode(this.cardKitCardId, false, this.cardKitSequence);
      this.cardKitSequence++;
      await updateCardKitCard(this.cardKitCardId, CardBuilder.toCardKit2(card as any), this.cardKitSequence);
    } else if (this.cardMessageId) {
      await updateCard(this.cardMessageId, card);
    }
    this.phase = 'error';
    await this.removeTyping();
  }

  async fallbackText(text: string): Promise<void> {
    await sendText(this.chatId, text, this.threadId ?? undefined);
    await this.removeTyping();
  }

  abortCard(): void {
    this.flush.destroy();
    this.phase = 'aborted';
    void this.removeTyping();
  }

  private async removeTyping(): Promise<void> {
    if (this.userMessageId && this.typingReactionId) {
      await removeTypingReaction(this.userMessageId, this.typingReactionId);
      this.typingReactionId = null;
    }
  }
}
