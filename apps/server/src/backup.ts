import path from "node:path";
import { loadConfig } from "./config/index.js";
import { createBackup, restoreBackup, verifyBackup } from "./storage/backup.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a directory`);
  return path.resolve(value);
}
try {
  const config = loadConfig();
  const verify = argument("--verify");
  const restore = argument("--restore");
  if (verify) {
    verifyBackup(verify);
    console.log("备份清单、SHA-256 和 SQLite 完整性验证通过。");
  } else if (restore) {
    if (!process.argv.includes("--yes")) throw new Error("Restore requires --yes; stop the gateway first");
    const previous = restoreBackup(restore, config.server.dataDir);
    console.log(`恢复完成；原数据保留在 ${previous ?? "(目标原为空)"}。确认凭据后再启动服务。`);
  } else {
    const destination = argument("--out") ?? path.join(config.server.dataDir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
    createBackup(config.server.dataDir, destination);
    console.log(`备份已创建并验证：${destination}`);
    console.log("不含 .env 和 codex-home；在线备份保证数据库一致性，文件与数据库同一时点备份请先停服务。");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
