import path from "node:path";
import { loadConfig } from "./config/index.js";
import { AppDatabase } from "./storage/index.js";
import { acquireDataLock } from "./storage/data-lock.js";
import { applyCleanupPlan, collectCleanupPlan } from "./storage/cleanup.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = "B";
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024) break;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

try {
  const config = loadConfig();
  const release = acquireDataLock(config.server.dataDir);
  let database: AppDatabase | undefined;
  try {
    database = new AppDatabase(path.join(config.server.dataDir, "weixin-household-gateway.sqlite"));
    database.initialize();
    const plan = collectCleanupPlan({
      dataDir: config.server.dataDir,
      activeSessionIds: new Set(database.listSessionLifecycle().filter((session) => session.status === "active").map((session) => session.id)),
      retentionDays: positiveInteger(argument("--days"), config.retention.retentionDays, "--days"),
      maxWorkspaceBytes: positiveInteger(argument("--max-bytes"), config.retention.maxWorkspaceBytes, "--max-bytes"),
    });
    const json = process.argv.includes("--json");
    if (process.argv.includes("--apply")) {
      const result = applyCleanupPlan({ dataDir: config.server.dataDir, plan });
      if (json) console.log(JSON.stringify({ plan, result }, null, 2));
      else console.log(`清理完成：删除 ${result.removedFiles} 个文件，释放 ${formatBytes(result.removedBytes)}；跳过 ${result.skippedFiles} 个已变化文件。`);
    } else if (json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`清理预览：共 ${plan.totalFiles} 个文件、${formatBytes(plan.totalBytes)}；候选 ${plan.candidates.length} 个、${formatBytes(plan.candidateBytes)}。`);
      console.log(`保留期限：${plan.retentionDays} 天；目标上限：${formatBytes(plan.maxWorkspaceBytes)}；预计剩余：${formatBytes(plan.remainingBytes)}。`);
      if (!plan.quotaSatisfied) console.log("警告：活跃会话或受保护文件占用空间，按当前策略仍无法满足配额。");
      for (const candidate of plan.candidates.slice(0, 20)) console.log(`- ${candidate.relativePath} (${formatBytes(candidate.sizeBytes)}, ${candidate.reason})`);
      if (plan.candidates.length > 20) console.log(`… 其余 ${plan.candidates.length - 20} 个候选未展开。`);
      console.log("仅预览未删除文件；确认后追加 --apply 执行。");
    }
  } finally {
    database?.close();
    release();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
