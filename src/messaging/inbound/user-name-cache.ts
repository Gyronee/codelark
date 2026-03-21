import { getClient } from '../outbound/send.js';
import { logger } from '../../logger.js';

interface CacheEntry { name: string; fetchedAt: number; }
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function resolveUserName(userId: string): Promise<string> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.name;
  }
  try {
    const client = getClient();
    const resp = await (client as any).contact.v3.user.get({
      path: { user_id: userId },
      params: { user_id_type: 'open_id' },
    });
    const name = (resp as any)?.data?.user?.name || '';
    setCache(userId, name);
    return name;
  } catch (err) {
    logger.debug({ err, userId }, 'Failed to resolve user name');
    setCache(userId, ''); // cache failure to prevent retry
    return '';
  }
}

function setCache(userId: string, name: string): void {
  // FIFO eviction
  if (cache.size >= MAX_CACHE_SIZE) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(userId, { name, fetchedAt: Date.now() });
}

export function clearUserNameCache(): void { cache.clear(); }
