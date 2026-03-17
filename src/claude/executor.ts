import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../logger.js';
import { type ToolStatus } from '../feishu/cards.js';

export interface ExecutionCallbacks {
  onText: (fullText: string) => void;
  onToolStart: (tool: string, detail: string) => void;
  onToolEnd: (tool: string, detail: string) => void;
  onComplete: (result: ExecutionResult) => void;
  onError: (error: string) => void;
  onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
}

export interface ExecutionResult {
  text: string;
  sessionId: string;
  toolCount: number;
  durationMs: number;
}

// Re-export ToolStatus so callers can import from this module if needed
export type { ToolStatus };

export async function executeClaudeTask(
  prompt: string,
  cwd: string,
  resumeSessionId: string | null,
  abortController: AbortController,
  callbacks: ExecutionCallbacks,
): Promise<void> {
  const startTime = Date.now();
  let fullText = '';
  let toolCount = 0;
  let sessionId = '';

  try {
    const conversation = query({
      prompt,
      options: {
        cwd,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        abortController,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'default',
        canUseTool: async (toolName, input, _options) => {
          const safeTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];
          if (safeTools.includes(toolName)) {
            return { behavior: 'allow' as const, updatedInput: {} };
          }
          const allowed = await callbacks.onPermissionRequest(
            toolName,
            input as Record<string, unknown>,
          );
          if (allowed) {
            return { behavior: 'allow' as const, updatedInput: {} };
          }
          return { behavior: 'deny' as const, message: 'User denied the operation' };
        },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
      },
    });

    for await (const message of conversation as AsyncIterable<SDKMessage>) {
      if (abortController.signal.aborted) break;

      switch (message.type) {
        case 'assistant': {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                fullText += block.text;
                callbacks.onText(fullText);
              } else if (block.type === 'tool_use') {
                toolCount++;
                const input = block.input as Record<string, unknown> | undefined;
                const detail =
                  (input?.command ?? input?.file_path ?? input?.pattern ?? block.name) as string;
                callbacks.onToolStart(block.name, String(detail));
              }
            }
          }
          break;
        }
        case 'user': {
          // Tool results arrive as user messages; signal tool completion
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                typeof block === 'object' &&
                block !== null &&
                (block as Record<string, unknown>).type === 'tool_result'
              ) {
                callbacks.onToolEnd('tool', 'completed');
              }
            }
          }
          break;
        }
        case 'result': {
          sessionId = message.session_id;
          if (message.subtype === 'success') {
            const resultText = fullText || (typeof message.result === 'string' ? message.result : '');
            callbacks.onComplete({
              text: resultText,
              sessionId,
              toolCount,
              durationMs: Date.now() - startTime,
            });
          } else {
            const errorMsg =
              Array.isArray((message as any).errors)
                ? (message as any).errors.join('; ')
                : 'Unknown error';
            callbacks.onError(errorMsg);
          }
          return;
        }
        default:
          logger.debug({ type: (message as SDKMessage).type }, 'Unhandled SDK message type');
      }
    }

    callbacks.onComplete({
      text: fullText || 'Task completed.',
      sessionId,
      toolCount,
      durationMs: Date.now() - startTime,
    });
  } catch (err: any) {
    if (abortController.signal.aborted) {
      return;
    }
    logger.error({ err }, 'Claude execution failed');
    callbacks.onError(err.message || 'Claude Code execution failed');
  }
}
