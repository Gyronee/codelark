export interface ToolStatus {
  tool: string;
  status: 'running' | 'done';
  detail: string;
}

interface FeishuCard {
  header: { title: { tag: string; content: string }; template: string };
  elements: unknown[];
}

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
  done(project: string, text: string, toolCount: number): FeishuCard {
    const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: sanitizeMarkdown(text) } }];
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
};
