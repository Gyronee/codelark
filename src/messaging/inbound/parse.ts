import type { MessageContext, MentionInfo, ResourceDescriptor } from '../types.js';

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
  const messageType: string = message?.message_type ?? 'text';
  const content = message?.content ? JSON.parse(message.content) : {};
  const rawText: string = content?.text ?? '';
  let text = rawText;
  for (const m of mentions) {
    if (m.key) text = text.replace(new RegExp(escapeRegExp(m.key), 'g'), '');
  }
  text = text.trim();

  // Extract resources from image, file, and post messages
  const resources: ResourceDescriptor[] = [];
  if (messageType === 'image' && content.image_key) {
    resources.push({ type: 'image', fileKey: content.image_key });
    if (!text) text = '[用户发送了一张图片]';
  } else if (messageType === 'file' && content.file_key) {
    resources.push({ type: 'file', fileKey: content.file_key, fileName: content.file_name });
    if (!text) text = `[用户发送了文件: ${content.file_name ?? content.file_key}]`;
  } else if (messageType === 'post') {
    const postContent: any[][] = content?.content ?? [];
    for (const paragraph of postContent) {
      if (!Array.isArray(paragraph)) continue;
      for (const el of paragraph) {
        if (el?.tag === 'img' && el.image_key) {
          resources.push({ type: 'image', fileKey: el.image_key });
        }
      }
    }
  }

  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '';
  return {
    eventId: event_id ?? '', messageId: message?.message_id ?? '',
    chatId: message?.chat_id ?? '', chatType: message?.chat_type === 'group' ? 'group' : 'p2p',
    threadId: message?.root_id || null, senderId,
    senderName: sender?.sender_id?.name ?? null, text, rawText,
    messageType, resources, mentions, botMentioned,
    createTime: Number(message?.create_time ?? 0), appId: app_id ?? '',
    parentMessageId: message?.parent_id || null, quotedContent: null, quotedMessageId: null,
  };
}
