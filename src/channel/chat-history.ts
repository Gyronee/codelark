/**
 * Per-chat sliding window history buffer.
 * Records recent messages (including ones not addressed to the bot)
 * so Claude has group conversation context.
 */

export interface HistoryEntry {
  senderName: string;
  text: string;
  timestamp: number;
}

const MAX_ENTRIES = 20;
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CHATS = 200;

const histories = new Map<string, HistoryEntry[]>();

export function recordMessage(chatId: string, senderName: string, text: string): void {
  if (!text.trim()) return;
  let entries = histories.get(chatId);
  if (!entries) {
    entries = [];
    histories.set(chatId, entries);
    // LRU eviction: drop oldest chat when map exceeds limit
    if (histories.size > MAX_CHATS) {
      const oldest = histories.keys().next().value!;
      histories.delete(oldest);
    }
  }
  entries.push({ senderName, text: text.slice(0, 500), timestamp: Date.now() });
  // Evict old entries
  while (entries.length > MAX_ENTRIES) entries.shift();
}

export function getRecentHistory(chatId: string): HistoryEntry[] {
  const entries = histories.get(chatId);
  if (!entries) return [];
  const cutoff = Date.now() - MAX_AGE_MS;
  return entries.filter(e => e.timestamp > cutoff);
}

export function formatHistoryContext(entries: HistoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map(e => `${e.senderName}: ${e.text}`);
  return `[Recent group chat context]\n${lines.join('\n')}`;
}
