// src/claude/feishu-tools-guide.test.ts
import { describe, it, expect } from 'vitest';
import { feishuToolsGuide } from './feishu-tools-guide.js';

describe('feishuToolsGuide', () => {
  it('should be a non-empty string', () => {
    expect(typeof feishuToolsGuide).toBe('string');
    expect(feishuToolsGuide.length).toBeGreaterThan(100);
  });

  it('should contain all 5 guide sections', () => {
    expect(feishuToolsGuide).toContain('Lark Markdown');
    expect(feishuToolsGuide).toContain('文档更新模式');
    expect(feishuToolsGuide).toContain('Wiki URL');
    expect(feishuToolsGuide).toContain('错误排查');
    expect(feishuToolsGuide).toContain('消息输出');
  });

  it('should contain key Lark Markdown syntax elements', () => {
    expect(feishuToolsGuide).toContain('<callout');
    expect(feishuToolsGuide).toContain('<grid');
    expect(feishuToolsGuide).toContain('<lark-table');
    expect(feishuToolsGuide).toContain('mermaid');
    expect(feishuToolsGuide).toContain('plantuml');
    expect(feishuToolsGuide).toContain('<task-list');
  });

  it('should contain all 7 update modes in guide 2', () => {
    const modes = ['append', 'overwrite', 'replace_range', 'replace_all', 'insert_before', 'insert_after', 'delete_range'];
    for (const mode of modes) {
      expect(feishuToolsGuide).toContain(mode);
    }
  });

  it('should contain wiki URL resolution workflow', () => {
    expect(feishuToolsGuide).toContain('feishu_wiki_space_node');
    expect(feishuToolsGuide).toContain('obj_type');
    expect(feishuToolsGuide).toContain('feishu_doc_fetch');
  });

  it('should contain error codes', () => {
    expect(feishuToolsGuide).toContain('need_authorization');
    expect(feishuToolsGuide).toContain('99991668');
    expect(feishuToolsGuide).toContain('99991672');
  });

  it('should contain bitable guide section', () => {
    expect(feishuToolsGuide).toContain('多维表格');
    expect(feishuToolsGuide).toContain('字段类型');
    expect(feishuToolsGuide).toContain('记录值格式');
    expect(feishuToolsGuide).toContain('Filter');
    // Key field types
    expect(feishuToolsGuide).toContain('单选');
    expect(feishuToolsGuide).toContain('多选');
    expect(feishuToolsGuide).toContain('日期');
    expect(feishuToolsGuide).toContain('人员');
    // Key record value gotchas
    expect(feishuToolsGuide).toContain('毫秒时间戳');
    expect(feishuToolsGuide).toContain('ou_xxx');
  });
});
