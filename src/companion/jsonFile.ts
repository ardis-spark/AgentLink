import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Creates a directory that only the current user can enter. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort: Windows ignores POSIX modes.
  }
}

/**
 * Writes JSON atomically (temp file + rename) with owner-only permissions, so
 * a crash mid-write can never leave a half-written file behind.
 */
export function writeJsonFile(path: string, value: unknown): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return null;
  return JSON.parse(raw) as T;
}

export function removeFile(path: string): void {
  rmSync(path, { force: true });
}
