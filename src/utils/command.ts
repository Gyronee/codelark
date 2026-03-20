export interface ParsedCommand {
  type: 'project' | 'reset' | 'cancel' | 'status' | 'whoami' | 'help' | 'model' | 'file' | 'auth';
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
    case '/whoami':
      return { type: 'whoami', action: null, args: [] };
    case '/help':
      return { type: 'help', action: null, args: [] };
    case '/model': {
      const args = parts.slice(1);
      return { type: 'model', action: args[0] || null, args };
    }
    case '/file': {
      const args = parts.slice(1);
      return { type: 'file', action: null, args };
    }
    case '/auth':
      return { type: 'auth', action: null, args: [] };
    default:
      return null;
  }
}
