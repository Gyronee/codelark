import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readConfig } from '../project/config.js';
import type { Config } from '../config.js';

interface AccessEntry {
  allowedUsers: string[];
}

interface AccessFile {
  projects: Record<string, AccessEntry>;
}

function readAccessFile(workspaceDir: string): AccessFile {
  const filePath = join(workspaceDir, 'access.json');
  if (!existsSync(filePath)) return { projects: {} };
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function writeAccessFile(workspaceDir: string, data: AccessFile): void {
  const filePath = join(workspaceDir, 'access.json');
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Check if user is admin */
export function isAdmin(userId: string, config: Config): boolean {
  return config.adminUserIds.includes(userId);
}

/** Check if user can access a project */
export function hasAccess(userId: string, projectName: string, workspaceDir: string, config: Config): boolean {
  // Admin has access to everything
  if (isAdmin(userId, config)) return true;

  // Personal directory — always accessible
  if (projectName === 'My Workspace') return true;

  // Group home project — accessible to all gate-passed users
  if (projectName.startsWith('group-')) return true;

  // Project creator
  const wsConfig = readConfig(workspaceDir);
  const project = wsConfig.projects[projectName];
  if (project?.creator === userId) return true;

  // access.json rules
  const access = readAccessFile(workspaceDir);

  // Check project-specific allowlist
  const projectAccess = access.projects[projectName];
  if (projectAccess?.allowedUsers.includes(userId)) return true;

  // Check wildcard allowlist
  const wildcardAccess = access.projects['*'];
  if (wildcardAccess?.allowedUsers.includes(userId)) return true;

  return false;
}

/** Check if user can grant/revoke on a project (admin or creator) */
export function canGrant(userId: string, projectName: string, workspaceDir: string, config: Config): boolean {
  if (isAdmin(userId, config)) return true;

  const wsConfig = readConfig(workspaceDir);
  const project = wsConfig.projects[projectName];
  return project?.creator === userId;
}

/** Add user to access.json for a project */
export function grantAccess(workspaceDir: string, userId: string, projectName: string): void {
  const data = readAccessFile(workspaceDir);
  if (!data.projects[projectName]) {
    data.projects[projectName] = { allowedUsers: [] };
  }
  const users = data.projects[projectName].allowedUsers;
  if (!users.includes(userId)) {
    users.push(userId);
  }
  writeAccessFile(workspaceDir, data);
}

/** Remove user from access.json for a project */
export function revokeAccess(workspaceDir: string, userId: string, projectName: string): void {
  const data = readAccessFile(workspaceDir);
  const entry = data.projects[projectName];
  if (!entry) return;
  entry.allowedUsers = entry.allowedUsers.filter(u => u !== userId);
  if (entry.allowedUsers.length === 0) {
    delete data.projects[projectName];
  }
  writeAccessFile(workspaceDir, data);
}

/** Get list of allowed users for a project */
export function getProjectAccess(workspaceDir: string, projectName: string): string[] {
  const data = readAccessFile(workspaceDir);
  return data.projects[projectName]?.allowedUsers ?? [];
}
