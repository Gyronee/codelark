/**
 * Per-user model preference store.
 * In-memory — resets on process restart.
 */

const ALLOWED_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
};

const userModels = new Map<string, string>();

export function setUserModel(userId: string, model: string): string | null {
  const resolved = MODEL_ALIASES[model.toLowerCase()] ?? model;
  if (!ALLOWED_MODELS.includes(resolved)) return null;
  userModels.set(userId, resolved);
  return resolved;
}

export function getUserModel(userId: string): string {
  return userModels.get(userId) ?? process.env.CLAUDE_MODEL ?? 'claude-opus-4-6';
}

export function listModels(): string[] {
  return ALLOWED_MODELS;
}

export function getModelAliases(): Record<string, string> {
  return MODEL_ALIASES;
}
