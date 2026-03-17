export interface MentionInfo {
  key: string;
  openId: string;
  name: string;
  isBot: boolean;
}

export interface MessageContext {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId: string | null;
  senderId: string;
  senderName: string | null;
  text: string;
  rawText: string;
  messageType: string;
  mentions: MentionInfo[];
  botMentioned: boolean;
  createTime: number;
  appId: string;
}
