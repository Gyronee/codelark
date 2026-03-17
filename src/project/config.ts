import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ProjectEntry {
  path: string;
  description: string;
  defaultBranch?: string;
}

export interface WorkspaceConfig {
  projects: Record<string, ProjectEntry>;
  defaults: {
    tmpCleanupDays: number;
  };
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  projects: {},
  defaults: { tmpCleanupDays: 7 },
};

export function readConfig(workspaceDir: string): WorkspaceConfig {
  const configPath = join(workspaceDir, '.config.json');
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG, projects: {} };
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

export function writeConfig(workspaceDir: string, config: WorkspaceConfig): void {
  const configPath = join(workspaceDir, '.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
