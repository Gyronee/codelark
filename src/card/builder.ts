export interface ToolStatus {
  tool: string;
  status: 'running' | 'done';
  detail: string;
}

interface FeishuCard {
  header: { title: { tag: string; content: string }; template: string };
  elements: unknown[];
}

// ---------------------------------------------------------------------------
// Reasoning / thinking tag utilities
// ---------------------------------------------------------------------------

const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

/** Extract content inside <think>/<thinking>/<thought>/<antthinking> tags */
export function extractThinkingContent(text: string): string {
  const parts: string[] = [];
  let inThinking = false;
  let lastIndex = 0;
  THINKING_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = THINKING_TAG_RE.exec(text)) !== null) {
    if (match[1] === '') {
      // Opening tag
      inThinking = true;
      lastIndex = THINKING_TAG_RE.lastIndex;
    } else {
      // Closing tag
      if (inThinking) {
        parts.push(text.slice(lastIndex, match.index));
        inThinking = false;
      }
    }
  }
  // Unclosed tag (streaming) — capture remaining text
  if (inThinking) parts.push(text.slice(lastIndex));
  return parts.join('\n').trim();
}

/** Remove all thinking tags and their content from text */
export function stripThinkingTags(text: string): string {
  let r = text;
  // Complete blocks
  r = r.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
  // Unclosed at end
  r = r.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi, '');
  // Orphaned closing tags
  r = r.replace(/<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
  return r.trim();
}

/** Split text into reasoning and answer parts */
export function splitReasoningText(text: string): { reasoningText: string; answerText: string } {
  const reasoningText = extractThinkingContent(text);
  const answerText = stripThinkingTags(text);
  return { reasoningText, answerText };
}

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function buildReasoningPanel(reasoningText: string, elapsedMs?: number): object {
  const duration = elapsedMs ? formatElapsed(elapsedMs) : '';
  const headerZh = duration ? `💭 思考了 ${duration}` : '💭 思考';
  const headerEn = duration ? `💭 Thought for ${duration}` : '💭 Thought';
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: headerEn,
        i18n_content: { zh_cn: headerZh, en_us: headerEn },
      },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: reasoningText, text_size: 'notation' }],
  };
}

// ---------------------------------------------------------------------------
// Card utilities
// ---------------------------------------------------------------------------

export function sanitizeMarkdown(text: string, maxLength = 3000): string {
  if (text.length > maxLength) return text.slice(0, maxLength) + '\n\n... (content truncated)';
  return text;
}

function toolStatusText(tools: ToolStatus[]): string {
  return tools.map(t => t.status === 'done' ? `✓ ${t.tool}: ${t.detail}` : `⟳ ${t.tool}: ${t.detail}`).join('\n');
}

export const CardBuilder = {
  thinking(project: string): FeishuCard {
    return {
      header: { title: { tag: 'plain_text', content: `⏳ Thinking · ${project}` }, template: 'blue' },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Processing...' } }],
    };
  },
  working(project: string, text: string, tools: ToolStatus[]): FeishuCard {
    const elements: unknown[] = [];
    if (text) elements.push({ tag: 'div', text: { tag: 'lark_md', content: sanitizeMarkdown(text) } });
    if (tools.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: toolStatusText(tools) } });
    }
    elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Cancel' }, type: 'danger', value: { action: 'cancel_task' } }] });
    return { header: { title: { tag: 'plain_text', content: `🔧 Working · ${project}` }, template: 'orange' }, elements };
  },
  done(project: string, text: string, toolCount: number, opts?: { reasoningText?: string; reasoningElapsedMs?: number }): FeishuCard {
    const elements: unknown[] = [];
    if (opts?.reasoningText) {
      elements.push(buildReasoningPanel(opts.reasoningText, opts.reasoningElapsedMs));
    }
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: sanitizeMarkdown(text) } });
    if (toolCount > 0) { elements.push({ tag: 'hr' }); elements.push({ tag: 'div', text: { tag: 'plain_text', content: `Tool calls: ${toolCount}` } }); }
    return { header: { title: { tag: 'plain_text', content: `✓ Done · ${project}` }, template: 'green' }, elements };
  },
  error(project: string, msg: string): FeishuCard {
    return { header: { title: { tag: 'plain_text', content: `✗ Error · ${project}` }, template: 'red' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: sanitizeMarkdown(msg) } }] };
  },
  confirm(project: string, command: string, taskId: string): FeishuCard {
    return {
      header: { title: { tag: 'plain_text', content: `⚠️ Confirm · ${project}` }, template: 'yellow' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `Claude wants to execute:\n\`\`\`\n${command}\n\`\`\`` } },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'Allow' }, type: 'primary', value: { action: 'confirm_danger', taskId } },
          { tag: 'button', text: { tag: 'plain_text', content: 'Deny' }, type: 'danger', value: { action: 'reject_danger', taskId } },
        ]},
      ],
    };
  },
  cancelled(project: string): FeishuCard {
    return { header: { title: { tag: 'plain_text', content: `⊘ Cancelled · ${project}` }, template: 'grey' }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Task was cancelled.' } }] };
  },
  buildFallbackText(markdown: string): string {
    return markdown.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/#+\s/g, '').trim();
  },

  /** Convert an IM-format card to CardKit 2.0 format for updateCardKitCard */
  toCardKit2(card: FeishuCard): object {
    return {
      schema: '2.0',
      config: {
        summary: {
          content: card.header.title.content.slice(0, 120),
        },
      },
      header: card.header,
      body: { elements: card.elements },
    };
  },
};
