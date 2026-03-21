import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectManager } from './manager.js';
import { readConfig } from './config.js';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_WORKSPACE = '/tmp/remote-control-test-workspace';

describe('ProjectManager', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    mkdirSync(TEST_WORKSPACE, { recursive: true });
    pm = new ProjectManager(TEST_WORKSPACE);
  });

  afterEach(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  describe('list', () => {
    it('returns empty list when no projects configured', () => {
      expect(pm.list()).toEqual([]);
    });
  });

  describe('create', () => {
    it('creates a new project with git init', () => {
      pm.create('my-app');
      const projectPath = join(TEST_WORKSPACE, 'projects', 'my-app');
      expect(existsSync(projectPath)).toBe(true);
      expect(existsSync(join(projectPath, '.git'))).toBe(true);
    });

    it('adds created project to config', () => {
      pm.create('my-app');
      const projects = pm.list();
      expect(projects.find(p => p.name === 'my-app')).toBeTruthy();
    });

    it('rejects invalid project names', () => {
      expect(() => pm.create('../evil')).toThrow();
      expect(() => pm.create('foo bar')).toThrow();
    });

    it('stores creator in config when userId is provided', () => {
      pm.create('my-app', 'ou_abc123');
      const config = readConfig(TEST_WORKSPACE);
      expect(config.projects['my-app'].creator).toBe('ou_abc123');
    });

    it('does not store creator in config when userId is omitted', () => {
      pm.create('my-app');
      const config = readConfig(TEST_WORKSPACE);
      expect(config.projects['my-app'].creator).toBeUndefined();
    });
  });

  describe('resolve', () => {
    it('resolves path for an existing project', () => {
      pm.create('my-app');
      const path = pm.resolve('my-app');
      expect(path).toBe(join(TEST_WORKSPACE, 'projects', 'my-app'));
    });

    it('throws for non-existent project', () => {
      expect(() => pm.resolve('nope')).toThrow();
    });
  });

  describe('validateCloneUrl', () => {
    it('accepts https URLs', () => {
      expect(() => pm.validateCloneUrl('https://github.com/user/repo.git')).not.toThrow();
    });

    it('rejects non-https URLs', () => {
      expect(() => pm.validateCloneUrl('git://github.com/user/repo.git')).toThrow();
      expect(() => pm.validateCloneUrl('file:///etc/passwd')).toThrow();
      expect(() => pm.validateCloneUrl('ssh://git@github.com/repo')).toThrow();
    });
  });
});
