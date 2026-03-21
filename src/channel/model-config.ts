/**
 * Model constants and helpers — pure exports, no state.
 */

export const ALLOWED_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

export const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
};

/** Resolve an alias or full model name. Returns null if invalid. */
export function resolveModelAlias(input: string): string | null {
  const resolved = MODEL_ALIASES[input.toLowerCase()] ?? input;
  return ALLOWED_MODELS.includes(resolved) ? resolved : null;
}

export function listModels(): string[] {
  return ALLOWED_MODELS;
}
