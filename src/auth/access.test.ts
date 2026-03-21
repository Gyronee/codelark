import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasAccess, canGrant, isAdmin, grantAccess, revokeAccess, getProjectAccess } from './access.js';
import type { Config } from '../config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    feishu: { appId: 'test', appSecret: 'test' },
    anthropicApiKey: undefined,
    workspaceDir: '/tmp',
    allowedUserIds: [],
    allowedGroupIds: [],
    adminUserIds: [],
    taskTimeoutMs: 300000,
    debounceMs: 500,
    botOpenId: '',
    sessionTitledOnly: false,
    ...overrides,
  };
}

describe('access module', () => {
  let wsDir: string;

  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'access-test-'));
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
  });

  function writeAccessJson(data: object): void {
    writeFileSync(join(wsDir, 'access.json'), JSON.stringify(data, null, 2));
  }

  function writeProjectsJson(projects: object): void {
    writeFileSync(join(wsDir, '.config.json'), JSON.stringify({ projects, defaults: { tmpCleanupDays: 7 } }));
  }

  // 1. hasAccess — user in access.json → true
  it('hasAccess returns true when user is in access.json for the project', () => {
    writeAccessJson({ projects: { 'my-proj': { allowedUsers: ['ou_alice'] } } });
    writeProjectsJson({});
    const config = makeConfig();
    expect(hasAccess('ou_alice', 'my-proj', wsDir, config)).toBe(true);
  });

  // 2. hasAccess — user NOT in access.json → false
  it('hasAccess returns false when user is not in access.json', () => {
    writeAccessJson({ projects: { 'my-proj': { allowedUsers: ['ou_alice'] } } });
    writeProjectsJson({});
    const config = makeConfig();
    expect(hasAccess('ou_bob', 'my-proj', wsDir, config)).toBe(false);
  });

  // 3. hasAccess — user has wildcard "*" → true for any project
  it('hasAccess returns true when user has wildcard access', () => {
    writeAccessJson({ projects: { '*': { allowedUsers: ['ou_wildcard'] } } });
    writeProjectsJson({});
    const config = makeConfig();
    expect(hasAccess('ou_wildcard', 'any-project', wsDir, config)).toBe(true);
    expect(hasAccess('ou_wildcard', 'another-project', wsDir, config)).toBe(true);
  });

  // 4. hasAccess — personal directory ('My Workspace') → always true
  it('hasAccess returns true for My Workspace regardless of user', () => {
    writeProjectsJson({});
    const config = makeConfig();
    expect(hasAccess('ou_random', 'My Workspace', wsDir, config)).toBe(true);
  });

  // 5. hasAccess — project creator → true
  it('hasAccess returns true for project creator', () => {
    writeProjectsJson({ 'my-proj': { path: '/tmp/my-proj', description: 'test', creator: 'ou_creator' } });
    const config = makeConfig();
    expect(hasAccess('ou_creator', 'my-proj', wsDir, config)).toBe(true);
  });

  // 6. hasAccess — admin user → true for everything
  it('hasAccess returns true for admin user on any project', () => {
    writeProjectsJson({});
    const config = makeConfig({ adminUserIds: ['ou_admin'] });
    expect(hasAccess('ou_admin', 'some-project', wsDir, config)).toBe(true);
    expect(hasAccess('ou_admin', 'another-project', wsDir, config)).toBe(true);
  });

  // 7. hasAccess — access.json doesn't exist → only personal/creator/admin work
  it('hasAccess works when access.json does not exist', () => {
    writeProjectsJson({ 'my-proj': { path: '/tmp/my-proj', description: 'test', creator: 'ou_creator' } });
    const config = makeConfig({ adminUserIds: ['ou_admin'] });

    // admin → true
    expect(hasAccess('ou_admin', 'my-proj', wsDir, config)).toBe(true);
    // personal → true
    expect(hasAccess('ou_anyone', 'My Workspace', wsDir, config)).toBe(true);
    // creator → true
    expect(hasAccess('ou_creator', 'my-proj', wsDir, config)).toBe(true);
    // random user → false
    expect(hasAccess('ou_random', 'my-proj', wsDir, config)).toBe(false);
  });

  // 8. grantAccess — creates entry in access.json
  it('grantAccess creates entry in access.json', () => {
    grantAccess(wsDir, 'ou_alice', 'my-proj');
    const raw = JSON.parse(readFileSync(join(wsDir, 'access.json'), 'utf-8'));
    expect(raw.projects['my-proj'].allowedUsers).toContain('ou_alice');

    // granting again should not duplicate
    grantAccess(wsDir, 'ou_alice', 'my-proj');
    const raw2 = JSON.parse(readFileSync(join(wsDir, 'access.json'), 'utf-8'));
    expect(raw2.projects['my-proj'].allowedUsers.filter((u: string) => u === 'ou_alice')).toHaveLength(1);
  });

  // 9. revokeAccess — removes entry from access.json
  it('revokeAccess removes entry from access.json', () => {
    writeAccessJson({ projects: { 'my-proj': { allowedUsers: ['ou_alice', 'ou_bob'] } } });
    revokeAccess(wsDir, 'ou_alice', 'my-proj');
    const raw = JSON.parse(readFileSync(join(wsDir, 'access.json'), 'utf-8'));
    expect(raw.projects['my-proj'].allowedUsers).toEqual(['ou_bob']);

    // revoking last user removes the project entry
    revokeAccess(wsDir, 'ou_bob', 'my-proj');
    const raw2 = JSON.parse(readFileSync(join(wsDir, 'access.json'), 'utf-8'));
    expect(raw2.projects['my-proj']).toBeUndefined();
  });

  // 10. getProjectAccess — returns allowed users list
  it('getProjectAccess returns allowed users list', () => {
    writeAccessJson({ projects: { 'my-proj': { allowedUsers: ['ou_alice', 'ou_bob'] } } });
    expect(getProjectAccess(wsDir, 'my-proj')).toEqual(['ou_alice', 'ou_bob']);
    expect(getProjectAccess(wsDir, 'nonexistent')).toEqual([]);
  });

  // 11. canGrant — admin can grant any project
  it('canGrant returns true for admin on any project', () => {
    writeProjectsJson({});
    const config = makeConfig({ adminUserIds: ['ou_admin'] });
    expect(canGrant('ou_admin', 'any-project', wsDir, config)).toBe(true);
  });

  // 12. canGrant — creator can grant own project
  it('canGrant returns true for creator on own project', () => {
    writeProjectsJson({ 'my-proj': { path: '/tmp/my-proj', description: 'test', creator: 'ou_creator' } });
    const config = makeConfig();
    expect(canGrant('ou_creator', 'my-proj', wsDir, config)).toBe(true);
  });

  // 13. canGrant — non-creator non-admin cannot grant
  it('canGrant returns false for non-creator non-admin', () => {
    writeProjectsJson({ 'my-proj': { path: '/tmp/my-proj', description: 'test', creator: 'ou_creator' } });
    const config = makeConfig();
    expect(canGrant('ou_random', 'my-proj', wsDir, config)).toBe(false);
  });

  // isAdmin
  it('isAdmin returns true for admin user', () => {
    const config = makeConfig({ adminUserIds: ['ou_admin'] });
    expect(isAdmin('ou_admin', config)).toBe(true);
    expect(isAdmin('ou_random', config)).toBe(false);
  });
});
