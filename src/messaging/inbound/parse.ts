import type { MessageContext, MentionInfo } from '../types.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMessageEvent(data: any, botOpenId: string): MessageContext {
  const { message, sender, event_id, app_id } = data;
  const rawMentions: any[] = message?.mentions ?? [];
  const mentions: MentionInfo[] = rawMentions.map((m: any) => ({
    key: m.key, openId: m.id?.open_id ?? '', name: m.name ?? '',
    isBot: m.id?.open_id === botOpenId,
  }));
  const botMentioned = mentions.some(m => m.isBot);
  const content = message?.content ? JSON.parse(message.content) : {};
  const rawText: string = content?.text ?? '';
  let text = rawText;
  for (const m of mentions) {
    if (m.key) text = text.replace(new RegExp(escapeRegExp(m.key), 'g'), '');
  }
  text = text.trim();
  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '';
  return {
    eventId: event_id ?? '', messageId: message?.message_id ?? '',
    chatId: message?.chat_id ?? '', chatType: message?.chat_type === 'group' ? 'group' : 'p2p',
    threadId: message?.root_id || null, senderId,
    senderName: sender?.sender_id?.name ?? null, text, rawText,
    messageType: message?.message_type ?? 'text', mentions, botMentioned,
    createTime: Number(message?.create_time ?? 0), appId: app_id ?? '',
    parentMessageId: message?.parent_id || null, quotedContent: null,
  };
}
