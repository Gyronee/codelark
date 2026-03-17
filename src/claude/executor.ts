import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';
import { type ToolStatus, extractThinkingContent, stripThinkingTags } from '../card/builder.js';

function getLocalPlugins(): Array<{ type: 'local'; path: string }> {
  // Plugins are cached at ~/.claude/plugins/cache/<marketplace>/<plugin-name>/<version>/
  // Each version dir contains .claude-plugin/plugin.json
  const cacheDir = join(process.env.HOME || '', '.claude', 'plugins', 'cache');
  if (!existsSync(cacheDir)) return [];
  const plugins: Array<{ type: 'local'; path: string }> = [];
  try {
    for (const marketplace of readdirSync(cacheDir)) {
      const mpDir = join(cacheDir, marketplace);
      for (const pluginName of readdirSync(mpDir)) {
        const pluginDir = join(mpDir, pluginName);
        // Find the latest version directory that has .claude-plugin/plugin.json
        const versions = readdirSync(pluginDir).filter(v =>
          existsSync(join(pluginDir, v, '.claude-plugin', 'plugin.json'))
        );
        if (versions.length > 0) {
          // Sort to get the latest version (lexicographic works for semver and hashes)
          versions.sort();
          const latestDir = join(pluginDir, versions[versions.length - 1]);
          plugins.push({ type: 'local', path: latestDir });
        }
      }
    }
  } catch { /* ignore */ }
  logger.info({ count: plugins.length, paths: plugins.map(p => p.path) }, 'Loading plugins');
  return plugins;
}

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
  reasoningText: string;
  reasoningElapsedMs: number;
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
  model?: string,
): Promise<void> {
  const startTime = Date.now();
  let fullText = '';
  let toolCount = 0;
  let sessionId = '';
  let reasoningStartTime: number | null = null;
  let reasoningElapsedMs = 0;
  let wasInReasoning = false;

  try {
    const conversation = query({
      prompt,
      options: {
        cwd,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        abortController,
        model: model || process.env.CLAUDE_MODEL || 'claude-opus-4-6',
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
        settingSources: ['user', 'project', 'local'],
        plugins: getLocalPlugins(),
        includePartialMessages: true,
        stderr: (data: string) => { logger.debug({ stderr: data.slice(0, 200) }, 'Claude stderr'); },
      },
    });

    for await (const message of conversation as AsyncIterable<SDKMessage>) {
      if (abortController.signal.aborted) break;

      switch (message.type) {
        // Stream events — incremental token deltas
        case 'stream_event' as any: {
          const evt = (message as any).event;
          if (evt?.type === 'content_block_delta' && evt?.delta?.type === 'text_delta') {
            fullText += evt.delta.text;
            // Detect reasoning phase (text contains unclosed <think> tags)
            const hasThinkingTag = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/i.test(fullText);
            const hasClosingTag = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/i.test(fullText);
            const isInReasoning = hasThinkingTag && !hasClosingTag;

            if (isInReasoning && !reasoningStartTime) {
              reasoningStartTime = Date.now();
            }
            if (wasInReasoning && !isInReasoning && reasoningStartTime) {
              reasoningElapsedMs = Date.now() - reasoningStartTime;
            }
            wasInReasoning = isInReasoning;

            // For display: during reasoning show inline indicator, otherwise strip tags
            if (isInReasoning) {
              const thinkContent = extractThinkingContent(fullText);
              callbacks.onText(`💭 **Thinking...**\n\n${thinkContent}`);
            } else {
              callbacks.onText(stripThinkingTags(fullText));
            }
          }
          if ((message as any).session_id) {
            sessionId = (message as any).session_id;
          }
          break;
        }
        case 'assistant': {
          // Complete assistant message — extract tool_use blocks
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
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
            const rawResult = fullText || (typeof message.result === 'string' ? message.result : '');
            const resultText = stripThinkingTags(rawResult);
            const finalReasoningText = extractThinkingContent(rawResult);
            callbacks.onComplete({
              text: resultText,
              reasoningText: finalReasoningText,
              reasoningElapsedMs,
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
      text: stripThinkingTags(fullText) || 'Task completed.',
      reasoningText: extractThinkingContent(fullText),
      reasoningElapsedMs,
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
