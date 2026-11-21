import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config/types.js";
import type { AppDatabase, SessionRecord } from "../storage/index.js";
import type { GeneratedMedia } from "../storage/capabilities.js";
import type { ModelSettingsStore } from "../settings/model-settings.js";
import { BackendConcurrencyLimiter } from "../operations/backend-concurrency-limiter.js";
import { ModelServiceError, modelFailure } from "../operations/model-failure.js";
import { generateImage } from "./image-provider.js";
import type { ILinkApiClient } from "../transport/ilink/api-client.js";
import { sendLocalFileToSession } from "../files/local-file.js";
import { resolveFamilyOutputFile } from "../transport/ilink/file-command.js";

export function parseImagePrompt(text: string): string | undefined {
  const match = /^\/(?:画图|image)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? "").trim() : undefined;
}
export function resolveGeneratedFile(config: AppConfig, media: GeneratedMedia): string | undefined {
  if (!media.local_path) return undefined;
  try {
    const resolved = resolveFamilyOutputFile(config, media.session_id, path.resolve(config.server.dataDir, media.local_path));
    return resolved && fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch { return undefined; }
}
export class ImageGenerationService {
  private readonly limiter = new BackendConcurrencyLimiter();
  private active = 0;
  private readonly delivering = new Set<string>();
  constructor(private readonly options: { config: AppConfig; database: AppDatabase; settings?: ModelSettingsStore | undefined }) {}
  get busy(): boolean { return this.active > 0; }
  private isAdmin(session: SessionRecord): boolean {
    const { database } = this.options;
    return session.role === "admin" && database.getAccountById(session.wechatAccountId)?.role === "admin" &&
      database.isAdminContact(session.wechatAccountId, session.contactId);
  }
  async generate(params: { prompt: string; session: SessionRecord; sourceMessageId: string; signal: AbortSignal;
      client: ILinkApiClient; onDeliveryStart: () => void; onDeliveryAccepted: () => void; onDeliveryUncertain: () => void }): Promise<GeneratedMedia> {
    const { database, settings, config } = this.options;
    const images = settings?.getImages();
    if (!images?.enabled) throw new ModelServiceError("not_configured", "画图尚未启用，请让管理员在后台配置生图接口，并为成员开启画图权限。");
    if (!config.familyPolicy.allowFileSend) throw new ModelServiceError("permission", "媒体发送已关闭，请联系管理员。");
    if (!params.prompt || params.prompt.length > 4000) throw new ModelServiceError("invalid_response", "用法：/画图 提示词（1–4000 字），例如：/画图 窗边晒太阳的橘猫");
    const previous = database.capabilities.mediaForMessage(params.session.wechatAccountId, params.sourceMessageId);
    if (previous) throw new ModelServiceError("provider_error", `该消息已提交过画图任务。请让管理员查看作品记录，任务编号：${previous.id}`);
    const media = database.capabilities.createMedia({ accountId: params.session.wechatAccountId, contactId: params.session.contactId,
      sessionId: params.session.id, sourceMessageId: params.sourceMessageId, model: images.model });
    this.active++;
    try {
      return await this.limiter.run("image", images.maxConcurrent, async () => {
        params.signal.throwIfAborted();
        if (database.getAccountById(params.session.wechatAccountId)?.status !== "active") throw new ModelServiceError("permission");
        database.capabilities.reserve(params.session.wechatAccountId, params.session.contactId, "image", media.id,
          { admin: this.isAdmin(params.session), globalImageLimit: images.dailyLimit });
        database.capabilities.updateMedia(media.id, "generating");
        const result = await generateImage(images, params.prompt, params.signal, Math.min(config.fileSend.maxBytes, 10 * 1024 * 1024));
        const directory = path.join(config.server.dataDir, "outbox", params.session.id);
        fs.mkdirSync(directory, { recursive: true });
        if (fs.realpathSync(directory) !== path.join(fs.realpathSync(config.server.dataDir), "outbox", params.session.id)) throw new ModelServiceError("permission");
        const file = path.join(directory, `image-${media.id}.${result.extension}`);
        fs.writeFileSync(file, result.buffer, { flag: "wx", mode: 0o600 });
        database.capabilities.updateMedia(media.id, "generated", { localPath: path.relative(config.server.dataDir, file), mimeType: result.mimeType, sizeBytes: result.buffer.length });
        // A generated result survives cancellation or delivery failure and is never regenerated here.
        await this.deliver({ ...params, id: media.id });
        return database.capabilities.media(media.id)!;
      }, params.signal);
    } catch (error) {
      const current = database.capabilities.media(media.id)!;
      const failure = modelFailure(params.signal.aborted ? new ModelServiceError("cancelled") : error);
      if (current.status !== "generated") database.capabilities.updateMedia(media.id,
        ["network", "timeout", "cancelled"].includes(failure.code) && current.status === "generating" ? "needs_review" : "failed",
        { errorCode: failure.code });
      throw new ModelServiceError(failure.code,
        `${failure.detail}\n任务编号：${media.id}${current.local_path ? "\n图片已生成并保留，请让管理员查看作品记录；无需重新生成。" : ""}`);
    } finally { this.active--; }
  }
  async deliver(params: { id: string; client: ILinkApiClient; session: SessionRecord; signal: AbortSignal;
      onDeliveryStart: () => void; onDeliveryAccepted: () => void; onDeliveryUncertain: () => void }): Promise<void> {
    const { database, config } = this.options;
    const media = database.capabilities.media(params.id);
    if (!media || media.status !== "generated" || this.delivering.has(params.id)) throw new ModelServiceError("invalid_response", "作品不存在、尚未生成或正在投递。");
    if (params.session.wechatAccountId !== media.account_id || params.session.contactId !== media.contact_id) throw new ModelServiceError("permission");
    if (database.getAccountById(media.account_id)?.status !== "active" || !config.familyPolicy.allowFileSend ||
      (!this.isAdmin(params.session) && !database.capabilities.policy(media.account_id, media.contact_id).imagesEnabled)) throw new ModelServiceError("permission");
    const file = resolveGeneratedFile(config, media);
    if (!file) throw new ModelServiceError("invalid_response", "作品文件已被清理或不可访问。");
    if (fs.statSync(file).size > config.fileSend.maxBytes) throw new ModelServiceError("invalid_response", "作品超过当前媒体发送大小限制。");
    this.delivering.add(params.id);
    try {
      await sendLocalFileToSession({ client: params.client, database, session: params.session, filePath: file, signal: params.signal,
        onDeliveryStart: () => { database.capabilities.updateMedia(params.id, "generated", { delivery: "sending" }); params.onDeliveryStart(); },
        onDeliveryAccepted: () => { database.capabilities.updateMedia(params.id, "generated", { delivery: "accepted" }); params.onDeliveryAccepted(); },
        onDeliveryUncertain: () => { database.capabilities.updateMedia(params.id, "generated", { delivery: "uncertain", errorCode: "delivery_uncertain" }); params.onDeliveryUncertain(); } });
    } catch (error) {
      const current = database.capabilities.media(params.id)!;
      database.capabilities.updateMedia(params.id, "generated", { delivery: current.delivery_status, errorCode: current.delivery_status === "uncertain" ? "delivery_uncertain" : "upload_failed" });
      throw error;
    } finally { this.delivering.delete(params.id); }
  }
}
