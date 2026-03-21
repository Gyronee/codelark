import { getClient } from '../messaging/outbound/send.js';
import { logger } from '../logger.js';

const cache = new Map<string, { admins: Set<string>; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function isGroupAdmin(chatId: string, userId: string): Promise<boolean> {
  const cached = cache.get(chatId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.admins.has(userId);
  }

  try {
    const client = getClient();
    const admins = new Set<string>();

    // Fetch chat members — look for owner and administrator roles
    let pageToken: string | undefined;
    do {
      const resp = await (client.im.v1.chatMembers as any).get({
        path: { chat_id: chatId },
        params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      const items = (resp as any)?.data?.items ?? [];
      for (const item of items) {
        if (item.member_type === 'owner' || item.member_type === 'administrator') {
          admins.add(item.member_id);
        }
      }
      pageToken = (resp as any)?.data?.page_token;
      if (!pageToken) break;
    } while (true);

    cache.set(chatId, { admins, fetchedAt: Date.now() });
    return admins.has(userId);
  } catch (err) {
    logger.warn({ err, chatId, userId }, 'Failed to check group admin status');
    return false;
  }
}

export function clearGroupAdminCache(chatId?: string): void {
  if (chatId) cache.delete(chatId);
  else cache.clear();
}
