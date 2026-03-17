export interface ParsedCommand {
  type: 'project' | 'reset' | 'cancel' | 'status';
  action: string | null;
  args: string[];
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/project': {
      const action = parts[1] || null;
      const args = parts.slice(2);
      if (!action) return null;
      return { type: 'project', action, args };
    }
    case '/reset':
      return { type: 'reset', action: null, args: [] };
    case '/cancel':
      return { type: 'cancel', action: null, args: [] };
    case '/status':
      return { type: 'status', action: null, args: [] };
    default:
      return null;
  }
}
