import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readConfig, writeConfig } from './config.js';
import { logger } from '../logger.js';

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export interface ProjectInfo {
  name: string;
  path: string;
  description: string;
}

export class ProjectManager {
  constructor(private workspaceDir: string) {
    mkdirSync(join(workspaceDir, 'projects'), { recursive: true });
    mkdirSync(join(workspaceDir, 'tmp'), { recursive: true });
  }

  list(): ProjectInfo[] {
    const config = readConfig(this.workspaceDir);
    return Object.entries(config.projects).map(([name, entry]) => ({
      name,
      path: join(this.workspaceDir, entry.path),
      description: entry.description,
    }));
  }

  resolve(name: string): string {
    const config = readConfig(this.workspaceDir);
    const entry = config.projects[name];
    if (!entry) throw new Error(`Project "${name}" not found. Use /project list to see available projects.`);
    const fullPath = join(this.workspaceDir, entry.path);
    if (!existsSync(fullPath)) throw new Error(`Project path does not exist: ${fullPath}`);
    return fullPath;
  }

  create(name: string, userId?: string): string {
    if (!VALID_NAME.test(name)) {
      throw new Error(`Invalid project name "${name}". Only [a-zA-Z0-9_-] allowed.`);
    }
    const projectPath = join(this.workspaceDir, 'projects', name);
    if (existsSync(projectPath)) throw new Error(`Project "${name}" already exists.`);

    mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' });

    const config = readConfig(this.workspaceDir);
    config.projects[name] = {
      path: `projects/${name}`,
      description: '',
      defaultBranch: 'main',
      ...(userId !== undefined ? { creator: userId } : {}),
    };
    writeConfig(this.workspaceDir, config);
    logger.info({ name, path: projectPath }, 'Project created');
    return projectPath;
  }

  ensureUserDefault(userId: string): string {
    const safeName = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const userDir = join(this.workspaceDir, 'users', safeName);
    if (!existsSync(userDir)) {
      mkdirSync(userDir, { recursive: true });
      execFileSync('git', ['init'], { cwd: userDir, stdio: 'ignore' });
      logger.info({ userId, path: userDir }, 'Created default user workspace');
    }
    return userDir;
  }

  validateCloneUrl(url: string): void {
    if (!url.startsWith('https://')) {
      throw new Error('Only https:// URLs are allowed for cloning.');
    }
  }

  async clone(url: string, userId?: string): Promise<{ name: string; path: string }> {
    this.validateCloneUrl(url);
    const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
    const shortId = randomBytes(3).toString('hex');
    const dirName = `${shortId}-${repoName}`;
    const clonePath = join(this.workspaceDir, 'tmp', dirName);

    execFileSync('git', ['clone', '--depth', '1', url, clonePath], { stdio: 'ignore', timeout: 120_000 });

    const config = readConfig(this.workspaceDir);
    config.projects[dirName] = {
      path: `tmp/${dirName}`,
      description: `Cloned from ${url}`,
      ...(userId !== undefined ? { creator: userId } : {}),
    };
    writeConfig(this.workspaceDir, config);
    logger.info({ name: dirName, url }, 'Repository cloned');
    return { name: dirName, path: clonePath };
  }

  cleanupTmp(): void {
    const config = readConfig(this.workspaceDir);
    const maxAge = (config.defaults?.tmpCleanupDays ?? 7) * 24 * 60 * 60 * 1000;
    const tmpDir = join(this.workspaceDir, 'tmp');
    if (!existsSync(tmpDir)) return;

    const entries = readdirSync(tmpDir);
    const now = Date.now();

    for (const entry of entries) {
      const entryPath = join(tmpDir, entry);
      try {
        const stat = statSync(entryPath);
        if (now - stat.mtimeMs > maxAge) {
          rmSync(entryPath, { recursive: true, force: true });
          if (config.projects[entry]) {
            delete config.projects[entry];
          }
          logger.info({ path: entryPath }, 'Cleaned up old tmp project');
        }
      } catch {
        // skip
      }
    }
    writeConfig(this.workspaceDir, config);
  }
}
