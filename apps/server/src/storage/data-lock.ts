import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// A separate SQLite file keeps the lock across database replacement and releases
// it automatically after SIGKILL. Restore never replaces .maintenance itself.
export function acquireDataLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error("DATA_DIR must not be a symlink");
  const maintenance = path.join(fs.realpathSync(dataDir), ".maintenance");
  fs.mkdirSync(maintenance, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(maintenance).isSymbolicLink()) throw new Error("Invalid maintenance directory");
  const db = new DatabaseSync(path.join(maintenance, "service-lock.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch {
    db.close();
    throw new Error("Data directory is in use. Stop the gateway before restore or another startup.");
  }
  if (fs.existsSync(path.join(maintenance, "restore-in-progress"))) {
    db.close();
    throw new Error("Interrupted restore detected; inspect .maintenance/restore-in-progress before restarting.");
  }
  return () => db.close();
}
