import { FlushController } from './flush-controller.js';
import {
  sendCard, updateCard, sendText,
  createCardEntity, sendCardByCardId, replyCardByCardId, replyCardToMessage,
  streamCardContent, updateCardKitCard, setCardStreamingMode,
  addTypingReaction, removeTypingReaction,
} from '../messaging/outbound/send.js';
import { CardBuilder, type MentionTarget } from './builder.js';
import { optimizeMarkdownStyle } from './markdown-style.js';
import { logger } from '../logger.js';

type Phase = 'idle' | 'waiting' | 'creating' | 'streaming' | 'completed' | 'aborted' | 'error' | 'creation_failed';
const TERMINAL: Phase[] = ['completed', 'aborted', 'error', 'creation_failed'];

export const STREAMING_ELEMENT_ID = 'streaming_content';
const CARDKIT_THROTTLE_MS = 100;
const IM_THROTTLE_MS = 1500;

/** CardKit 2.0 initial card with streaming_mode and loading icon */
function buildStreamingThinkingCard(_mentionTarget?: MentionTarget | null): object {
  // Note: CardKit 2.0 streaming cards don't support <at> in initial creation.
  // Mention is added in the final card (done/error/cancelled) via CardBuilder.
  const elements: any[] = [];
  elements.push({ tag: 'markdown', content: '', text_align: 'left', element_id: STREAMING_ELEMENT_ID });
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: 'Thinking...' },
    },
    body: { elements },
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
  private lastContent: string = '';
  private mentionTarget: MentionTarget | null;

  constructor(chatId: string, threadId: string | null, userMessageId: string | null, mentionTarget?: MentionTarget) {
    this.chatId = chatId;
    this.threadId = threadId;
    this.userMessageId = userMessageId;
    this.mentionTarget = mentionTarget ?? null;
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
    const cardId = await createCardEntity(buildStreamingThinkingCard(this.mentionTarget));
    if (this.createEpoch !== epoch || this.isTerminal) return;

    if (cardId) {
      this.cardKitCardId = cardId;
      this.cardKitSequence = 1;
      // Reply to user's message if we have the message ID, otherwise send to chat
      const messageId = this.userMessageId
        ? await replyCardByCardId(this.userMessageId, cardId)
        : await sendCardByCardId(this.chatId, cardId, this.threadId ?? undefined);
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
    this.flush = new FlushController(this.flush.update, IM_THROTTLE_MS);
    const thinkingCard = CardBuilder.thinking('Working');
    const messageId = this.userMessageId
      ? await replyCardToMessage(this.userMessageId, thinkingCard)
      : await sendCard(this.chatId, thinkingCard, this.threadId ?? undefined);
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
    this.lastContent = text;
    this.flush.schedule(text);
  }

  private async finalizeCard(card: object, phase: Phase, shouldFlush: boolean): Promise<void> {
    if (this.isTerminal) return;
    if (shouldFlush) {
      await this.flush.waitForFlush();
    }
    this.flush.destroy();
    if (this.cardKitCardId) {
      this.cardKitSequence++;
      await setCardStreamingMode(this.cardKitCardId, false, this.cardKitSequence);
      this.cardKitSequence++;
      await updateCardKitCard(this.cardKitCardId, CardBuilder.toCardKit2(card as any), this.cardKitSequence);
    } else if (this.cardMessageId) {
      await updateCard(this.cardMessageId, card);
    }
    this.phase = phase;
    await this.removeTyping();
  }

  async complete(card: object) { await this.finalizeCard(card, 'completed', true); }
  async abort(card: object) { await this.finalizeCard(card, 'aborted', false); }
  async error(card: object) { await this.finalizeCard(card, 'error', false); }

  async fallbackText(text: string): Promise<void> {
    let content = text;
    if (this.mentionTarget) {
      content = `<at user_id="${this.mentionTarget.userId}">${this.mentionTarget.name}</at>\n${content}`;
    }
    await sendText(this.chatId, content, this.threadId ?? undefined);
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
