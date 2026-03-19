export interface ResourceDescriptor {
  type: 'image' | 'file';
  fileKey: string;
  fileName?: string;
}

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
  resources: ResourceDescriptor[];
  mentions: MentionInfo[];
  botMentioned: boolean;
  createTime: number;
  appId: string;
  parentMessageId: string | null;  // message being replied to
  quotedContent: string | null;    // text of the replied-to message (resolved async)
}
