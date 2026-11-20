import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireDataLock } from "./data-lock.js";

const DB_NAME = "weixin-household-gateway.sqlite";
interface Manifest {
  version: 1;
  files: Record<string, string>;
  createdAt: string;
}
function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function hash(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function walk(root: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic links: ${name}`);
    if (entry.isDirectory()) files.push(...walk(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported backup entry: ${name}`);
  }
  return files;
}
function checkDatabase(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") throw new Error("SQLite integrity check failed");
    for (const table of ["wechat_accounts", "sessions", "messages"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`Missing gateway table: ${table}`);
      }
    }
  } finally { db.close(); }
}
export function verifyBackup(directory: string): Manifest {
  const root = fs.realpathSync(directory);
  const manifestPath = path.join(root, "manifest.json");
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("Invalid manifest link");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== "object" || !manifest.files[DB_NAME]) {
    throw new Error("Unsupported or incomplete backup manifest");
  }
  const actual = walk(root).filter(name => name !== "manifest.json").sort();
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Backup file inventory mismatch");
  for (const name of expected) {
    if (!inside(path.resolve(root, name), root) || hash(path.join(root, name)) !== manifest.files[name]) {
      throw new Error(`Backup checksum mismatch: ${name}`);
    }
  }
  checkDatabase(path.join(root, DB_NAME));
  return manifest;
}
export function createBackup(dataDir: string, destination: string): void {
  const source = fs.realpathSync(dataDir);
  // Parent must exist; canonicalize it to prevent symlink aliases and recursive copies.
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const target = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
  const backupDir = path.join(source, "backups");
  if (inside(source, target) || (inside(target, source) && !inside(target, backupDir))) {
    throw new Error("Backup must be outside DATA_DIR or inside DATA_DIR/backups");
  }
  fs.mkdirSync(target, { mode: 0o700 }); // never overwrite an existing backup
  try {
    const db = new DatabaseSync(path.join(source, DB_NAME), { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.prepare("VACUUM INTO ?").run(path.join(target, DB_NAME));
    } finally { db.close(); }
    // The SQLite snapshot is consistent. File copying is best effort while online;
    // stop the service for a point-in-time snapshot of database AND artifacts.
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if ([DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`, `${DB_NAME}-journal`, "backups", "codex-home", ".maintenance"].includes(entry.name)) continue;
      const entryPath = path.join(source, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic links: ${entry.name}`);
      const names = entry.isDirectory() ? walk(entryPath).map(name => path.join(entry.name, name)) : [entry.name];
      for (const name of names) {
        const output = path.join(target, name);
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(source, name), output);
        fs.chmodSync(output, 0o600);
      }
    }
    fs.chmodSync(path.join(target, DB_NAME), 0o600);
    const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), files: {} };
    for (const name of walk(target)) manifest.files[name] = hash(path.join(target, name));
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    verifyBackup(target);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
export function restoreBackup(source: string, dataDir: string): string {
  const backupRoot = fs.realpathSync(source);
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error("DATA_DIR must not be a symlink");
  const target = fs.realpathSync(dataDir);
  if (inside(target, backupRoot)) throw new Error("Restore source must not contain DATA_DIR");
  const release = acquireDataLock(target);
  const maintenance = path.join(target, ".maintenance");
  const marker = path.join(maintenance, "restore-in-progress");
  let staging = "";
  const previous = path.join(maintenance, `before-restore-${crypto.randomUUID()}`);
  const preserved = new Set([".maintenance", "backups", "codex-home"]);
  const moved: string[] = [];
  const installed: string[] = [];
  try {
    verifyBackup(backupRoot);
    staging = fs.mkdtempSync(path.join(maintenance, "restore-"));
    fs.cpSync(backupRoot, staging, { recursive: true });
    verifyBackup(staging);
    fs.unlinkSync(path.join(staging, "manifest.json"));
    for (const name of fs.readdirSync(staging)) {
      if (preserved.has(name)) throw new Error(`Backup contains reserved directory: ${name}`);
    }
    fs.mkdirSync(previous, { mode: 0o700 });
    fs.writeFileSync(marker, JSON.stringify({ previous, staging }), { mode: 0o600 });
    try {
      for (const name of fs.readdirSync(target)) {
        if (preserved.has(name)) continue;
        fs.renameSync(path.join(target, name), path.join(previous, name));
        moved.push(name);
      }
      for (const name of fs.readdirSync(staging)) {
        fs.renameSync(path.join(staging, name), path.join(target, name));
        installed.push(name);
      }
    } catch (error) {
      // On ordinary I/O errors restore the pre-operation state. If rollback fails,
      // leave the marker so startup refuses to serve a partially restored tree.
      for (const name of installed) fs.renameSync(path.join(target, name), path.join(staging, name));
      for (const name of moved) fs.renameSync(path.join(previous, name), path.join(target, name));
      fs.unlinkSync(marker);
      throw error;
    }
    fs.unlinkSync(marker);
    return previous;
  } finally {
    if (staging && !fs.existsSync(marker)) fs.rmSync(staging, { recursive: true, force: true });
    release();
  }
}
