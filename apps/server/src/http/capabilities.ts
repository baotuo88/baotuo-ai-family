import fs from "node:fs";
import type http from "node:http";
import type { AppConfig } from "../config/types.js";
import type { AppDatabase } from "../storage/database.js";
import type { SettingsRoutes } from "./settings.js";
import { SettingsBusyError, SettingsInputError } from "../settings/model-settings.js";
import { ModelServiceError } from "../operations/model-failure.js";
import { resolveGeneratedFile } from "../media/image-service.js";
import { readJsonBody, respondJson } from "./response.js";

/** Called only after central management authentication and origin validation. */
export async function handleCapabilityRoutes(context: SettingsRoutes & {
  request: http.IncomingMessage; response: http.ServerResponse; config: AppConfig; database: AppDatabase;
  pathname: string; method: string;
}): Promise<boolean> {
  const { pathname, method, request, response, database, settings } = context;
  const mediaRoute = /^\/api\/media\/([a-f0-9-]{36})\/(content|redeliver)$/.exec(pathname);
  if (!["/api/setup", "/api/settings/models/copy", "/api/settings/images", "/api/members", "/api/media", "/api/diagnostics"].includes(pathname) && !mediaRoute) return false;
  response.setHeader("Cache-Control", "no-store");
  try {
    if (method === "GET") {
      if (pathname === "/api/setup") {
        const roles = settings ? Object.fromEntries((["admin", "family"] as const).map(role => {
          const value = settings.effective(role);
          return [role, { configured: Boolean(value.apiKey && value.baseUrl && value.model), backend: value.backend,
            check: database.capabilities.check(role, settings.fingerprint(role)), sandboxVerified: false }];
        })) : null;
        respondJson(response, 200, { ok: true, roles, accounts: database.listAccounts().map(a => ({ id: a.id, role: a.role, status: a.status })),
          adminContacts: database.listAdminContacts().length, images: settings?.imagesView() ?? null });
      } else if (pathname === "/api/members") respondJson(response, 200, { ok: true, members: database.capabilities.listMembers() });
      else if (pathname === "/api/media") respondJson(response, 200, { ok: true, media: database.capabilities.listMedia() });
      else if (pathname === "/api/diagnostics") respondJson(response, 200, { ok: true, diagnostics: database.capabilities.diagnostics() });
      else if (pathname === "/api/settings/images" && settings) respondJson(response, 200, { ok: true, ...settings.imagesView() });
      else if (mediaRoute?.[2] === "content") {
        const media = database.capabilities.media(mediaRoute[1]!);
        const file = media && resolveGeneratedFile(context.config, media);
        if (!media) { respondJson(response, 404, { ok: false, error: "media_not_found" }); return true; }
        if (!file || fs.statSync(file).size > context.config.fileSend.maxBytes || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(media.mime_type ?? "")) {
          respondJson(response, 410, { ok: false, error: "media_unavailable" }); return true;
        }
        const data = fs.readFileSync(file);
        response.setHeader("Content-Type", media.mime_type!);
        response.setHeader("Content-Length", data.length);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Disposition", `inline; filename="image-${media.id}"`);
        response.end(data);
      } else { respondJson(response, 405, { ok: false, error: "method_not_allowed" }); }
      return true;
    }
    if (method !== "POST") { respondJson(response, 405, { ok: false, error: "method_not_allowed" }); return true; }
    if (request.headers["x-gateway-request"] !== "dashboard" || !request.headers["content-type"]?.startsWith("application/json")) {
      respondJson(response, 403, { ok: false, error: "invalid_management_request" }); return true;
    }
    const body = await readJsonBody(request);
    if (pathname === "/api/settings/models/copy") {
      if (!settings || !context.saveModelSettings) throw new SettingsInputError("模型设置不可用");
      if (body.confirm !== true) throw new SettingsInputError("请确认将管理员模型复制给家庭聊天");
      context.saveModelSettings("family", settings.copyAdminForFamily());
      respondJson(response, 200, { ok: true, ...settings.view() });
    } else if (pathname === "/api/settings/images") {
      if (!settings) throw new SettingsInputError("生图设置不可用");
      settings.saveImages(settings.prepareImages(body));
      respondJson(response, 200, { ok: true, ...settings.imagesView() });
    } else if (pathname === "/api/members") {
      if (typeof body.accountId !== "string" || !database.getAccountById(body.accountId) ||
          typeof body.contactId !== "string" || !body.contactId.trim() || body.contactId.length > 256 || /[\x00-\x1f]/.test(body.contactId)) throw new SettingsInputError("账号或联系人无效");
      if (typeof body.chatEnabled !== "boolean" || typeof body.imagesEnabled !== "boolean") throw new SettingsInputError("请选择成员权限");
      const integer = (value: unknown, min: number): number => {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > 100000) throw new SettingsInputError("每日次数超出范围");
        return value;
      };
      database.capabilities.savePolicy(body.accountId, body.contactId, { chatEnabled: body.chatEnabled, imagesEnabled: body.imagesEnabled,
        dailyChatLimit: integer(body.dailyChatLimit, 0), dailyImageLimit: integer(body.dailyImageLimit, 1) });
      respondJson(response, 200, { ok: true });
    } else if (mediaRoute?.[2] === "redeliver") {
      if (body.confirm !== true) throw new SettingsInputError("补发可能重复送达，请确认向原联系人补发已有图片");
      if (!context.redeliverMedia) throw new SettingsBusyError("当前无法补发");
      await context.redeliverMedia(mediaRoute[1]!);
      respondJson(response, 200, { ok: true });
    } else respondJson(response, 405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    if (error instanceof SettingsInputError || error instanceof SettingsBusyError || error instanceof ModelServiceError) {
      respondJson(response, error instanceof SettingsBusyError ? 409 : error instanceof ModelServiceError ? 422 : 400,
        { ok: false, error: error instanceof ModelServiceError ? error.code : "invalid_settings", message: error.message });
    } else throw error;
  }
  return true;
}
