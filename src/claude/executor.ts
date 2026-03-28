import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';
import { type ToolStatus, extractThinkingContent, stripThinkingTags } from '../card/builder.js';
import { createFeishuDocServer } from '../tools/feishu-doc-server.js';
import { feishuToolsGuide } from './feishu-tools-guide.js';
import type { Database } from '../session/db.js';

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
  onThinkingUpdate: (isThinking: boolean, content: string, elapsedMs: number) => void;
  onToolStart: (toolUseId: string, tool: string, detail: string, parentToolUseId: string | null) => void;
  onToolEnd: (toolUseId: string, resultSummary: string) => void;
  onToolProgress: (toolUseId: string, toolName: string, elapsed: number) => void;
  onAgentStart: (toolUseId: string, name: string) => void;
  onAgentEnd: (toolUseId: string, summary: string, toolCount: number, durationMs: number) => void;
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
  userId?: string,
  db?: Database,
): Promise<void> {
  const startTime = Date.now();
  let fullText = '';
  let toolCount = 0;
  let sessionId = '';
  let reasoningStartTime: number | null = null;
  let reasoningElapsedMs = 0;
  let wasInReasoning = false;

  // Build MCP servers and tools guide for this user
  const mcpServers: Record<string, any> = {};
  let feishuPromptAppend = '';
  if (userId && db) {
    const appId = process.env.FEISHU_APP_ID ?? '';
    const appSecret = process.env.FEISHU_APP_SECRET ?? '';
    if (appId && appSecret) {
      mcpServers['feishu-docs'] = createFeishuDocServer(userId, db, appId, appSecret);
      feishuPromptAppend = feishuToolsGuide;
    }
  }

  try {
    const conversation = query({
      prompt,
      options: {
        cwd,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        abortController,
        model: model || process.env.CLAUDE_MODEL || 'claude-opus-4-6',
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
          'mcp__feishu-docs__feishu_doc_create',
          'mcp__feishu-docs__feishu_doc_fetch',
          'mcp__feishu-docs__feishu_doc_update',
          'mcp__feishu-docs__feishu_search_doc_wiki',
          'mcp__feishu-docs__feishu_wiki_space',
          'mcp__feishu-docs__feishu_wiki_space_node',
          'mcp__feishu-docs__feishu_drive_file',
          'mcp__feishu-docs__feishu_doc_media',
          'mcp__feishu-docs__feishu_doc_comments',
          'mcp__feishu-docs__feishu_bitable',
          'mcp__feishu-docs__feishu_bitable_field',
          'mcp__feishu-docs__feishu_bitable_record',
        ],
        permissionMode: 'default',
        canUseTool: async (toolName, input, _options) => {
          const safeTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];
          if (safeTools.includes(toolName) || toolName.startsWith('mcp__feishu-docs__')) {
            return { behavior: 'allow' as const, updatedInput: input as Record<string, unknown> };
          }
          const allowed = await callbacks.onPermissionRequest(
            toolName,
            input as Record<string, unknown>,
          );
          if (allowed) {
            return { behavior: 'allow' as const, updatedInput: input as Record<string, unknown> };
          }
          return { behavior: 'deny' as const, message: 'User denied the operation' };
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(feishuPromptAppend ? { append: feishuPromptAppend } : {}),
        },
        settingSources: ['user', 'project', 'local'],
        plugins: getLocalPlugins(),
        includePartialMessages: true,
        stderr: (data: string) => { logger.debug({ stderr: data.slice(0, 200) }, 'Claude stderr'); },
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
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
              callbacks.onThinkingUpdate(true, thinkContent, reasoningStartTime ? Date.now() - reasoningStartTime : 0);
              callbacks.onText(`💭 **Thinking...**\n\n${thinkContent}`);
            } else {
              if (wasInReasoning) {
                callbacks.onThinkingUpdate(false, '', reasoningElapsedMs);
              }
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
          const parentId = (message as any).parent_tool_use_id ?? null;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                toolCount++;
                const input = block.input as Record<string, unknown> | undefined;
                if (block.name === 'Agent') {
                  const agentDesc = (input?.description ?? input?.prompt ?? 'sub-agent') as string;
                  callbacks.onAgentStart(block.id, agentDesc.slice(0, 60));
                }
                const detail =
                  (input?.command ?? input?.file_path ?? input?.pattern ?? block.name) as string;
                callbacks.onToolStart(block.id, block.name, String(detail), parentId);
              }
            }
          }
          break;
        }
        case 'user': {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block !== null && (block as any).type === 'tool_result') {
                const toolUseId = (block as any).tool_use_id || '';
                const resultContent = (block as any).content;
                let summary = 'done';
                if (typeof resultContent === 'string') {
                  summary = resultContent.slice(0, 80);
                } else if (Array.isArray(resultContent)) {
                  const textBlock = resultContent.find((b: any) => b.type === 'text');
                  if (textBlock?.text) summary = textBlock.text.slice(0, 80);
                }
                callbacks.onToolEnd(toolUseId, summary);
              }
            }
          }
          break;
        }
        case 'tool_progress' as any: {
          const msg = message as any;
          if (msg.tool_use_id && msg.tool_name) {
            callbacks.onToolProgress(msg.tool_use_id, msg.tool_name, msg.elapsed_time_seconds ?? 0);
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
        case 'system' as any: {
          const msg = message as any;
          if (msg.subtype === 'task_notification' && msg.tool_use_id) {
            const status = msg.status as string;
            const summary = msg.summary || '';
            const toolUses = msg.usage?.tool_uses ?? 0;
            const durationMs = msg.usage?.duration_ms ?? 0;
            if (status === 'completed' || status === 'failed' || status === 'stopped') {
              callbacks.onAgentEnd(msg.tool_use_id, summary, toolUses, durationMs);
            }
          }
          break;
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
