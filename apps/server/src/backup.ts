import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/index.js";
import {
  createBackup,
  createEncryptedBackup,
  drillBackup,
  drillEncryptedBackup,
  restoreBackup,
  restoreEncryptedBackup,
  verifyBackup,
  verifyEncryptedBackup,
} from "./storage/backup.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a directory`);
  return path.resolve(value);
}
function backupPassphrase(): string {
  const file = process.env.BACKUP_PASSPHRASE_FILE?.trim();
  if (file) return fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  return process.env.BACKUP_PASSPHRASE ?? "";
}
try {
  const config = loadConfig();
  const verify = argument("--verify");
  const drill = argument("--drill");
  const restore = argument("--restore");
  const encrypted = process.argv.includes("--encrypted");
  const passphrase = backupPassphrase();
  if (verify) {
    if (encrypted) verifyEncryptedBackup(verify, passphrase);
    else verifyBackup(verify);
    console.log("备份清单、SHA-256 和 SQLite 完整性验证通过。");
  } else if (drill) {
    const result = encrypted ? drillEncryptedBackup(drill, passphrase) : drillBackup(drill);
    console.log(`恢复演练通过：SQLite 完整性正常；账号 ${result.accounts} 个，会话 ${result.sessions} 个，入站任务 ${result.inboundJobs} 条。临时恢复数据已清除。`);
  } else if (restore) {
    if (!process.argv.includes("--yes")) throw new Error("Restore requires --yes; stop the gateway first");
    const previous = encrypted
      ? restoreEncryptedBackup(restore, config.server.dataDir, passphrase)
      : restoreBackup(restore, config.server.dataDir);
    console.log(`恢复完成；原数据保留在 ${previous ?? "(目标原为空)"}。确认凭据后再启动服务。`);
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = argument("--out") ?? path.join(config.server.dataDir, "backups", encrypted ? `${timestamp}.enc` : timestamp);
    if (encrypted) createEncryptedBackup(config.server.dataDir, destination, passphrase);
    else createBackup(config.server.dataDir, destination);
    console.log(`备份已创建并验证：${destination}`);
    console.log(`不含 .env 和 codex-home；${encrypted ? "备份内容已加密，密钥必须独立保管。" : "在线备份保证数据库一致性。"}文件与数据库同一时点备份请先停服务。`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
