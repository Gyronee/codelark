import { describe, it, expect } from 'vitest';
import { parseCommand } from './command.js';

describe('parseCommand', () => {
  it('parses bare /project as list', () => {
    expect(parseCommand('/project')).toEqual({
      type: 'project', action: 'list', args: []
    });
  });

  it('parses /project list', () => {
    expect(parseCommand('/project list')).toEqual({
      type: 'project', action: 'list', args: []
    });
  });

  it('parses /project use my-app', () => {
    expect(parseCommand('/project use my-app')).toEqual({
      type: 'project', action: 'use', args: ['my-app']
    });
  });

  it('parses /project clone with URL', () => {
    expect(parseCommand('/project clone https://github.com/user/repo.git')).toEqual({
      type: 'project', action: 'clone', args: ['https://github.com/user/repo.git']
    });
  });

  it('parses /project create', () => {
    expect(parseCommand('/project create new-service')).toEqual({
      type: 'project', action: 'create', args: ['new-service']
    });
  });

  it('/reset returns null (removed command)', () => {
    expect(parseCommand('/reset')).toBeNull();
  });

  it('parses /cancel', () => {
    expect(parseCommand('/cancel')).toEqual({ type: 'cancel', action: null, args: [] });
  });

  it('parses /status', () => {
    expect(parseCommand('/status')).toEqual({ type: 'status', action: null, args: [] });
  });

  it('parses /whoami', () => {
    expect(parseCommand('/whoami')).toEqual({ type: 'whoami', action: null, args: [] });
  });

  it('returns null for non-command text', () => {
    expect(parseCommand('help me fix this bug')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull();
  });

  it('parses /file with a simple path', () => {
    expect(parseCommand('/file src/index.ts')).toEqual({
      type: 'file', action: null, args: ['src/index.ts']
    });
  });

  it('parses /file with spaces in path', () => {
    expect(parseCommand('/file path with spaces/file.txt')).toEqual({
      type: 'file', action: null, args: ['path', 'with', 'spaces/file.txt']
    });
  });

  it('parses /session list', () => {
    expect(parseCommand('/session list')).toEqual({
      type: 'session', action: 'list', args: []
    });
  });

  it('parses /session resume with ID', () => {
    expect(parseCommand('/session resume ff48c101')).toEqual({
      type: 'session', action: 'resume', args: ['ff48c101']
    });
  });

  it('parses bare /session as list', () => {
    expect(parseCommand('/session')).toEqual({
      type: 'session', action: 'list', args: []
    });
  });

  it('parses /project grant ou_xxx', () => {
    expect(parseCommand('/project grant ou_xxx')).toEqual({
      type: 'project', action: 'grant', args: ['ou_xxx']
    });
  });

  it('parses /project grant ou_xxx remote-control', () => {
    expect(parseCommand('/project grant ou_xxx remote-control')).toEqual({
      type: 'project', action: 'grant', args: ['ou_xxx', 'remote-control']
    });
  });

  it('parses /project revoke ou_xxx', () => {
    expect(parseCommand('/project revoke ou_xxx')).toEqual({
      type: 'project', action: 'revoke', args: ['ou_xxx']
    });
  });

  it('parses /project access', () => {
    expect(parseCommand('/project access')).toEqual({
      type: 'project', action: 'access', args: []
    });
  });

  it('parses /session rename', () => {
    expect(parseCommand('/session rename My Title')).toEqual({
      type: 'session', action: 'rename', args: ['My', 'Title']
    });
  });

  it('parses /session new', () => {
    expect(parseCommand('/session new')).toEqual({
      type: 'session', action: 'new', args: []
    });
  });
});
