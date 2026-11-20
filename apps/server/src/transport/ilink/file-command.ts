import fs from "node:fs";
import path from "node:path";
import {
  parseAssistantFileAction,
  type ParsedCommand,
} from "../../commands/index.js";
import { AppConfig, UserRole } from "../../config/types.js";
import {
  assertFileAllowedForWechatCommand,
  isInsideDirectory,
  sendLocalFileToSession,
} from "../../files/index.js";
import { buildSessionWorkspacePaths } from "../../sessions/index.js";
import { AppDatabase, SessionRecord } from "../../storage/index.js";
import { ILinkApiClient } from "./api-client.js";
import { formatBytes } from "./reply.js";

// Resolve links before authorization. Even the session outbox itself must not
// redirect to another session or an external directory.
export function resolveFamilyOutputFile(config: AppConfig, sessionId: string, requested: string): string | undefined {
  try {
    const { outboxDir } = buildSessionWorkspacePaths({ config, sessionId });
    const expected = path.join(fs.realpathSync(config.server.dataDir), "outbox", sessionId);
    if (fs.realpathSync(outboxDir) !== expected) return undefined;
    const realFile = fs.realpathSync(requested);
    return isInsideDirectory(realFile, expected) ? realFile : undefined;
  } catch {
    return undefined;
  }
}

export async function handleFileCommand(params: {
  command: ParsedCommand;
  config: AppConfig;
  client: ILinkApiClient;
  database: AppDatabase;
  session: SessionRecord;
  role: UserRole;
  onDeliveryStart?: () => void;
  onDeliveryAccepted?: () => void;
  onDeliveryUncertain?: () => void;
}): Promise<string> {
  if (!params.config.familyPolicy.allowFileSend) {
    return "文件发送当前已被配置关闭。";
  }

  const [rawFilePath, ...captionParts] = params.command.args;
  if (!rawFilePath) {
    return [
      "用法：/file <文件路径> [说明文字]",
      `允许目录：${params.config.fileSend.allowedDirs.join(", ")}`,
    ].join("\n");
  }

  if (!params.session.contextToken.trim()) {
    return "当前会话缺少 context_token。请先从这个微信会话再发一条普通消息。";
  }

  let filePath = path.resolve(rawFilePath);
  if (params.role === "family") {
    const allowedPath = resolveFamilyOutputFile(params.config, params.session.id, filePath);
    if (!allowedPath) return "当前只允许回传本次会话 outbox 中的成品文件。";
    filePath = allowedPath;
  } else {
    assertFileAllowedForWechatCommand(filePath, params.config.fileSend);
    filePath = fs.realpathSync(filePath);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("请求的路径不是普通文件。");
  if (stat.size > params.config.fileSend.maxBytes) {
    throw new Error(`文件太大：${formatBytes(stat.size)}，上限 ${formatBytes(params.config.fileSend.maxBytes)}`);
  }

  const caption = captionParts.join(" ").trim();
  params.onDeliveryStart?.();
  let result: Awaited<ReturnType<typeof sendLocalFileToSession>>;
  try {
    result = await sendLocalFileToSession({
      client: params.client,
      database: params.database,
      session: params.session,
      filePath,
      ...(caption ? { caption } : {}),
    });
  } catch (error) {
    params.onDeliveryUncertain?.();
    throw error;
  }
  params.onDeliveryAccepted?.();

  return [
    "文件已发送。",
    `文件：${result.fileName}`,
    `大小：${formatBytes(result.sizeBytes)}`,
    `MD5：${result.plaintextMd5}`,
  ].join("\n");
}

export async function handleAssistantFileActions(params: {
  rawReply: string;
  config: AppConfig;
  client: ILinkApiClient;
  database: AppDatabase;
  session: SessionRecord;
  role: UserRole;
  onDeliveryStart?: () => void;
  onDeliveryAccepted?: () => void;
  onDeliveryUncertain?: () => void;
}): Promise<string> {
  const action = parseAssistantFileAction(params.rawReply);
  if (!action) {
    return params.rawReply;
  }

  if (params.role === "family") {
    const requestedPath = action.command.args[0];
    if (!requestedPath || !resolveFamilyOutputFile(params.config, params.session.id, requestedPath)) {
      return action.cleanedText;
    }
  } else if (params.role !== "admin") {
    return params.rawReply;
  }

  const fileReply = await handleFileCommand({
    command: action.command,
    config: params.config,
    client: params.client,
    database: params.database,
    session: params.session,
    role: params.role,
    ...(params.onDeliveryStart ? { onDeliveryStart: params.onDeliveryStart } : {}),
    ...(params.onDeliveryAccepted ? { onDeliveryAccepted: params.onDeliveryAccepted } : {}),
    ...(params.onDeliveryUncertain ? { onDeliveryUncertain: params.onDeliveryUncertain } : {}),
  });

  return [action.cleanedText, fileReply].filter(Boolean).join("\n");
}
