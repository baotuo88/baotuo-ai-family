import fs from "node:fs";
import path from "node:path";

const MANAGED_ROOTS = ["inbox", "office", "outbox"] as const;

interface ManagedFile {
  absolutePath: string;
  relativePath: string;
  sessionId?: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface CleanupCandidate {
  relativePath: string;
  sizeBytes: number;
  mtime: string;
  reason: "retention" | "quota";
}

export interface CleanupPlan {
  generatedAt: string;
  cutoff: string;
  retentionDays: number;
  maxWorkspaceBytes: number;
  totalFiles: number;
  totalBytes: number;
  protectedBytes: number;
  candidateBytes: number;
  remainingBytes: number;
  quotaSatisfied: boolean;
  candidates: CleanupCandidate[];
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function walkManagedFiles(dataDir: string): ManagedFile[] {
  const files: ManagedFile[] = [];
  for (const rootName of MANAGED_ROOTS) {
    const root = path.join(dataDir, rootName);
    if (!fs.existsSync(root)) continue;
    if (fs.lstatSync(root).isSymbolicLink()) {
      throw new Error(`Managed directory must not be a symlink: ${rootName}`);
    }

    const visit = (directory: string, relativeDirectory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = path.join(relativeDirectory, entry.name);
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Cleanup refuses symbolic links: ${relativePath}`);
        }
        if (stat.isDirectory()) {
          visit(absolutePath, relativePath);
        } else if (stat.isFile()) {
          const parts = relativePath.split(path.sep);
          files.push({
            absolutePath,
            relativePath,
            ...(parts.length > 1 ? { sessionId: parts[1] } : {}),
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } else {
          throw new Error(`Unsupported managed entry: ${relativePath}`);
        }
      }
    };
    visit(root, rootName);
  }
  return files;
}

export function collectCleanupPlan(params: {
  dataDir: string;
  activeSessionIds?: ReadonlySet<string>;
  retentionDays: number;
  maxWorkspaceBytes: number;
  now?: Date;
}): CleanupPlan {
  assertPositiveInteger(params.retentionDays, "retentionDays");
  assertPositiveInteger(params.maxWorkspaceBytes, "maxWorkspaceBytes");
  const now = params.now ?? new Date();
  const cutoffMs = now.getTime() - params.retentionDays * 24 * 60 * 60 * 1000;
  const files = walkManagedFiles(params.dataDir);
  const activeSessionIds = params.activeSessionIds ?? new Set<string>();
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const protectedBytes = files
    .filter((file) => file.sessionId && activeSessionIds.has(file.sessionId))
    .reduce((sum, file) => sum + file.sizeBytes, 0);
  const selected = new Map<string, CleanupCandidate>();
  const addCandidate = (file: ManagedFile, reason: "retention" | "quota"): void => {
    if (file.sessionId && activeSessionIds.has(file.sessionId)) return;
    if (!selected.has(file.absolutePath)) {
      selected.set(file.absolutePath, {
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        mtime: new Date(file.mtimeMs).toISOString(),
        reason,
      });
    }
  };

  const oldestFirst = [...files].sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const file of oldestFirst) {
    if (file.mtimeMs < cutoffMs) addCandidate(file, "retention");
  }
  let candidateBytes = [...selected.values()].reduce((sum, file) => sum + file.sizeBytes, 0);
  for (const file of oldestFirst) {
    if (totalBytes - candidateBytes <= params.maxWorkspaceBytes) break;
    if (!selected.has(file.absolutePath)) {
      addCandidate(file, "quota");
      if (selected.has(file.absolutePath)) candidateBytes += file.sizeBytes;
    }
  }

  return {
    generatedAt: now.toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    retentionDays: params.retentionDays,
    maxWorkspaceBytes: params.maxWorkspaceBytes,
    totalFiles: files.length,
    totalBytes,
    protectedBytes,
    candidateBytes,
    remainingBytes: Math.max(0, totalBytes - candidateBytes),
    quotaSatisfied: totalBytes - candidateBytes <= params.maxWorkspaceBytes,
    candidates: [...selected.values()].sort((left, right) => left.mtime.localeCompare(right.mtime)),
  };
}

export function applyCleanupPlan(params: {
  dataDir: string;
  plan: CleanupPlan;
}): { removedFiles: number; removedBytes: number; skippedFiles: number } {
  let removedFiles = 0;
  let removedBytes = 0;
  let skippedFiles = 0;
  for (const candidate of params.plan.candidates) {
    const absolutePath = path.resolve(params.dataDir, candidate.relativePath);
    if (!isInsideManagedRoot(absolutePath, params.dataDir)) {
      throw new Error(`Cleanup candidate escaped managed roots: ${candidate.relativePath}`);
    }
    if (!hasSafeManagedParents(absolutePath, params.dataDir)) {
      skippedFiles += 1;
      continue;
    }
    if (!fs.existsSync(absolutePath)) {
      skippedFiles += 1;
      continue;
    }
    const stat = fs.lstatSync(absolutePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== candidate.sizeBytes ||
      Math.trunc(stat.mtimeMs) !== Date.parse(candidate.mtime)
    ) {
      skippedFiles += 1;
      continue;
    }
    fs.rmSync(absolutePath);
    removedFiles += 1;
    removedBytes += candidate.sizeBytes;
    removeEmptyParents(absolutePath, params.dataDir);
  }
  return { removedFiles, removedBytes, skippedFiles };
}

function isInsideManagedRoot(target: string, dataDir: string): boolean {
  return MANAGED_ROOTS.some((rootName) => {
    const root = path.join(path.resolve(dataDir), rootName);
    const relative = path.relative(root, target);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

function hasSafeManagedParents(target: string, dataDir: string): boolean {
  const resolvedDataDir = path.resolve(dataDir);
  const relative = path.relative(resolvedDataDir, target);
  const parts = relative.split(path.sep);
  let current = resolvedDataDir;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function removeEmptyParents(filePath: string, dataDir: string): void {
  let current = path.dirname(filePath);
  const resolvedDataDir = path.resolve(dataDir);
  while (current !== resolvedDataDir && isInsideManagedRoot(current, resolvedDataDir)) {
    if (fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}
