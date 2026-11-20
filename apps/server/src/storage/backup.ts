import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireDataLock } from "./data-lock.js";

const DB_NAME = "weixin-household-gateway.sqlite";
const ENCRYPTED_MAGIC = Buffer.from("BAOTUO-ENC-BACKUP\0", "ascii");
const ENCRYPTED_VERSION = 1;
const ENCRYPTED_SALT_BYTES = 16;
const ENCRYPTED_IV_BYTES = 12;
const ENCRYPTED_TAG_BYTES = 16;
const ENCRYPTED_KEY_BYTES = 32;
const ENCRYPTED_CHUNK_BYTES = 1024 * 1024;
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
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(ENCRYPTED_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      position += read;
    }
    return digest.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}
function deriveBackupKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase) throw new Error("Backup passphrase must not be empty");
  return crypto.scryptSync(passphrase, salt, ENCRYPTED_KEY_BYTES, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset);
}
function readExact(fd: number, length: number, state: { position: number }): Buffer {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, output, offset, length - offset, state.position);
    if (read === 0) throw new Error("Encrypted backup is truncated");
    offset += read;
    state.position += read;
  }
  return output;
}
function safeEncryptedName(name: string): void {
  if (!name || name.includes("\\") || name.includes("\0") || path.isAbsolute(name) || name.split(path.sep).some(part => part === ".." || part === ".")) {
    throw new Error(`Invalid encrypted backup path: ${name}`);
  }
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

function resolveBackupTarget(source: string, destination: string): string {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const target = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
  const backupDir = path.join(source, "backups");
  if (inside(source, target) || (inside(target, source) && !inside(target, backupDir))) {
    throw new Error("Backup must be outside DATA_DIR or inside DATA_DIR/backups");
  }
  return target;
}

function encryptedFiles(root: string): string[] {
  return walk(root).sort();
}

export function createEncryptedBackup(dataDir: string, destination: string, passphrase: string): void {
  if (!passphrase) throw new Error("Backup passphrase must not be empty");
  const source = fs.realpathSync(dataDir);
  const target = resolveBackupTarget(source, path.resolve(destination));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-encrypted-backup-"));
  const plaintext = path.join(temporaryRoot, "backup");
  let output = 0;
  let createdTarget = false;
  try {
    createBackup(source, plaintext);
    const salt = crypto.randomBytes(ENCRYPTED_SALT_BYTES);
    const key = deriveBackupKey(passphrase, salt);
    output = fs.openSync(target, "wx", 0o600);
    createdTarget = true;
    writeAll(output, ENCRYPTED_MAGIC);
    writeAll(output, Buffer.from([ENCRYPTED_VERSION]));
    writeAll(output, salt);
    for (const name of encryptedFiles(plaintext)) {
      const inputPath = path.join(plaintext, name);
      const stat = fs.statSync(inputPath);
      const iv = crypto.randomBytes(ENCRYPTED_IV_BYTES);
      const nameBytes = Buffer.from(name, "utf8");
      const recordHeader = Buffer.from(JSON.stringify({ name, size: stat.size, iv: iv.toString("base64") }), "utf8");
      if (recordHeader.length > 1024 * 1024) throw new Error("Encrypted backup record header is too large");
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(nameBytes);
      const headerLength = Buffer.alloc(4);
      headerLength.writeUInt32BE(recordHeader.length, 0);
      writeAll(output, headerLength);
      writeAll(output, recordHeader);
      const input = fs.openSync(inputPath, "r");
      try {
        const chunk = Buffer.alloc(ENCRYPTED_CHUNK_BYTES);
        let position = 0;
        while (position < stat.size) {
          const read = fs.readSync(input, chunk, 0, Math.min(chunk.length, stat.size - position), position);
          if (read === 0) throw new Error(`Failed to read backup file: ${name}`);
          writeAll(output, cipher.update(chunk.subarray(0, read)));
          position += read;
        }
        writeAll(output, cipher.final());
      } finally {
        fs.closeSync(input);
      }
      writeAll(output, cipher.getAuthTag());
    }
    fs.closeSync(output);
    output = 0;
    fs.chmodSync(target, 0o600);
    verifyEncryptedBackup(target, passphrase);
  } catch (error) {
    if (output) fs.closeSync(output);
    if (createdTarget) fs.rmSync(target, { force: true });
    throw error;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function decryptEncryptedBackup(source: string, destination: string, passphrase: string): Manifest {
  const inputPath = fs.realpathSync(source);
  if (!fs.lstatSync(inputPath).isFile()) throw new Error("Encrypted backup must be a regular file");
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  let input = 0;
  try {
    input = fs.openSync(inputPath, "r");
    const fileSize = fs.fstatSync(input).size;
    const state = { position: 0 };
    if (!readExact(input, ENCRYPTED_MAGIC.length, state).equals(ENCRYPTED_MAGIC)) throw new Error("Unsupported encrypted backup format");
    if (readExact(input, 1, state).readUInt8(0) !== ENCRYPTED_VERSION) throw new Error("Unsupported encrypted backup version");
    const key = deriveBackupKey(passphrase, readExact(input, ENCRYPTED_SALT_BYTES, state));
    const seen = new Set<string>();
    while (state.position < fileSize) {
      const length = readExact(input, 4, state).readUInt32BE(0);
      if (length === 0 || length > 1024 * 1024) throw new Error("Invalid encrypted backup record");
      const record = JSON.parse(readExact(input, length, state).toString("utf8")) as { name?: string; size?: number; iv?: string };
      const name = record.name ?? "";
      safeEncryptedName(name);
      const size = record.size;
      if (seen.has(name) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || !record.iv) throw new Error(`Invalid encrypted backup record: ${name}`);
      const iv = Buffer.from(record.iv, "base64");
      if (iv.length !== ENCRYPTED_IV_BYTES) throw new Error(`Invalid encrypted backup IV: ${name}`);
      const destinationPath = path.join(destination, name);
      if (!inside(path.resolve(destinationPath), path.resolve(destination))) throw new Error(`Encrypted backup path escaped destination: ${name}`);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(name, "utf8"));
      const output = fs.openSync(destinationPath, "wx", 0o600);
      try {
        let remaining = size;
        while (remaining > 0) {
          const chunk = readExact(input, Math.min(ENCRYPTED_CHUNK_BYTES, remaining), state);
          writeAll(output, decipher.update(chunk));
          remaining -= chunk.length;
        }
        decipher.setAuthTag(readExact(input, ENCRYPTED_TAG_BYTES, state));
        writeAll(output, decipher.final());
      } finally {
        fs.closeSync(output);
      }
      if (fs.statSync(destinationPath).size !== size) throw new Error(`Encrypted backup size mismatch: ${name}`);
      seen.add(name);
    }
    fs.closeSync(input);
    input = 0;
    return verifyBackup(destination);
  } catch (error) {
    if (input) fs.closeSync(input);
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function withDecryptedBackup<T>(source: string, passphrase: string, callback: (directory: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-decrypted-backup-"));
  const directory = path.join(root, "backup");
  try {
    decryptEncryptedBackup(source, directory, passphrase);
    return callback(directory);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function verifyEncryptedBackup(source: string, passphrase: string): Manifest {
  return withDecryptedBackup(source, passphrase, verifyBackup);
}

export function restoreEncryptedBackup(source: string, dataDir: string, passphrase: string): string {
  return withDecryptedBackup(source, passphrase, directory => restoreBackup(directory, dataDir));
}

export function drillEncryptedBackup(source: string, passphrase: string): {
  accounts: number;
  sessions: number;
  inboundJobs: number;
} {
  return withDecryptedBackup(source, passphrase, drillBackup);
}

export function drillBackup(directory: string): {
  accounts: number;
  sessions: number;
  inboundJobs: number;
} {
  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-restore-drill-"));
  const restoredData = path.join(drillRoot, "data");
  try {
    restoreBackup(directory, restoredData);
    const db = new DatabaseSync(path.join(restoredData, DB_NAME), { readOnly: true });
    try {
      checkDatabase(path.join(restoredData, DB_NAME));
      const count = (table: string): number => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        return row.count;
      };
      return {
        accounts: count("wechat_accounts"),
        sessions: count("sessions"),
        inboundJobs: count("inbound_jobs"),
      };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(drillRoot, { recursive: true, force: true });
  }
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
