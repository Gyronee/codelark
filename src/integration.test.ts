import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './session/db.js';
import { SessionManager } from './session/manager.js';
import { ProjectManager } from './project/manager.js';
import { parseCommand } from './utils/command.js';
import { CardBuilder } from './feishu/cards.js';
import { existsSync, unlinkSync, rmSync } from 'fs';

const TEST_DB = '/tmp/remote-control-integration.db';
const TEST_WORKSPACE = '/tmp/remote-control-integration-workspace';

describe('Integration: end-to-end flow (without Feishu/Claude)', () => {
  let db: Database;
  let sm: SessionManager;
  let pm: ProjectManager;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    db = new Database(TEST_DB);
    sm = new SessionManager(db);
    pm = new ProjectManager(TEST_WORKSPACE);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  it('full flow: create project → get session → build cards', () => {
    // 1. Create project
    pm.create('test-app');
    const projects = pm.list();
    expect(projects).toHaveLength(1);

    // 2. Set active project
    db.upsertUser('ou_1', 'Alice');
    db.setActiveProject('ou_1', 'test-app');

    // 3. Get session
    const session = sm.getOrCreate('ou_1', null, 'test-app');
    expect(session.id).toBeTruthy();

    // 4. Build thinking card
    const thinking = CardBuilder.thinking('test-app');
    expect(thinking.header.template).toBe('blue');

    // 5. Build working card
    const working = CardBuilder.working('test-app', 'Analyzing...', [
      { tool: 'Read', status: 'done', detail: 'src/index.ts' },
    ]);
    expect(working.header.template).toBe('orange');

    // 6. Build done card
    const done = CardBuilder.done('test-app', 'All done!', 1);
    expect(done.header.template).toBe('green');

    // 7. Simulate session update
    db.updateClaudeSessionId(session.id, 'claude-session-xyz');
    const updated = sm.getOrCreate('ou_1', null, 'test-app');
    expect(updated.claude_session_id).toBe('claude-session-xyz');

    // 8. Task log
    db.logTask(session.id, 'fix bug', 'fixed', '["Read","Edit"]', 5000, 'success');
    const logs = db.getTaskLogs(session.id, 10);
    expect(logs).toHaveLength(1);
  });

  it('command parsing integrates with project manager', () => {
    const cmd = parseCommand('/project create new-service');
    expect(cmd).toEqual({ type: 'project', action: 'create', args: ['new-service'] });

    pm.create('new-service');
    const path = pm.resolve('new-service');
    expect(existsSync(path)).toBe(true);
  });
});
