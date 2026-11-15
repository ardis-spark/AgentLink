import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, ProjectSummary } from '../../shared/types.js';
import { ensurePrivateDir, readJsonFile, removeFile, writeJsonFile } from '../jsonFile.js';
import type { Logger } from '../logger.js';
import { toProjectSummary } from './projectModel.js';

interface StateFile {
  version: 1;
  activeProjectId: string | null;
}

const PROJECT_ID = /^p_[a-z0-9]{6,40}$/;

/**
 * Durable project memory: one JSON file per project under
 * `<data dir>/projects`, written atomically after every change. Nothing here
 * depends on the browser, so a project survives closing the browser,
 * restarting the companion, or rebooting the machine.
 */
export class ProjectStore {
  private readonly dir: string;
  private readonly statePath: string;
  private readonly cache = new Map<string, Project>();
  private activeProjectId: string | null = null;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.dir = join(dataDir, 'projects');
    this.statePath = join(dataDir, 'state.json');
    ensurePrivateDir(dataDir);
    ensurePrivateDir(this.dir);
    this.loadAll();
  }

  private pathFor(id: string): string {
    if (!PROJECT_ID.test(id)) throw new Error(`Invalid project id "${id}".`);
    return join(this.dir, `${id}.json`);
  }

  private loadAll(): void {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.dir, file);
      try {
        const project = readJsonFile<Project>(path);
        if (!project || project.schemaVersion !== 1 || !PROJECT_ID.test(project.id)) {
          throw new Error('unrecognised project file');
        }
        this.cache.set(project.id, project);
      } catch (error) {
        // Never delete a file we cannot read: set it aside so the user can inspect or restore it.
        const quarantine = `${path}.corrupt-${Date.now()}`;
        this.logger.error(`Project file ${file} could not be read and was set aside as ${quarantine}:`, error);
        try {
          renameSync(path, quarantine);
        } catch {
          // Leave it in place if it cannot be moved.
        }
      }
    }
    try {
      const state = readJsonFile<StateFile>(this.statePath);
      if (state?.activeProjectId && this.cache.has(state.activeProjectId)) this.activeProjectId = state.activeProjectId;
    } catch {
      this.activeProjectId = null;
    }
    if (!this.activeProjectId) this.activeProjectId = this.mostRecent()?.id ?? null;
  }

  private mostRecent(): Project | null {
    let latest: Project | null = null;
    for (const p of this.cache.values()) if (!latest || p.updatedAt > latest.updatedAt) latest = p;
    return latest;
  }

  list(): ProjectSummary[] {
    return [...this.cache.values()].map(toProjectSummary).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  all(): Project[] {
    return [...this.cache.values()];
  }

  get(id: string): Project | null {
    return this.cache.get(id) ?? null;
  }

  /** Persists the project. Callers mutate the cached object and then save it. */
  save(project: Project): void {
    this.cache.set(project.id, project);
    writeJsonFile(this.pathFor(project.id), project);
  }

  delete(id: string): boolean {
    if (!this.cache.has(id)) return false;
    this.cache.delete(id);
    if (existsSync(this.pathFor(id))) removeFile(this.pathFor(id));
    if (this.activeProjectId === id) this.setActive(this.mostRecent()?.id ?? null);
    return true;
  }

  getActiveId(): string | null {
    return this.activeProjectId;
  }

  setActive(id: string | null): void {
    if (id !== null && !this.cache.has(id)) throw new Error(`Unknown project "${id}".`);
    this.activeProjectId = id;
    const state: StateFile = { version: 1, activeProjectId: id };
    writeJsonFile(this.statePath, state);
  }
}
