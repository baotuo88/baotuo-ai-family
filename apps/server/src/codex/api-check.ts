import { modelFailure, type ModelFailureCode } from "../operations/model-failure.js";
import { randomUUID } from "node:crypto";
import type { CodexRuntimeConfig } from "../config/types.js";
import { ApiCodexBackend } from "./api-backend.js";

export interface ApiCheckResult { ok: boolean; detail: string; code?: ModelFailureCode }

export interface ApiModelListResult { ok: boolean; models: string[]; detail: string }

function validateApiUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export async function listApiModels(baseUrl: string, apiKey: string): Promise<ApiModelListResult> {
  const url = validateApiUrl(baseUrl);
  if (!url || !apiKey) return { ok: false, models: [], detail: "API 地址或 API Key 无效" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${url.toString().replace(/\/+$/, "")}/models`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, models: [], detail: "模型列表获取失败，请检查接口地址、Key 或权限" };
    const payload: unknown = await response.json();
    const records = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
          ? (payload as { models: unknown[] }).models
          : [];
    const models = [...new Set(records.map(item => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return "";
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? id.trim() : "";
    }).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    return { ok: true, models: models.slice(0, 500), detail: models.length ? `已获取 ${Math.min(models.length, 500)} 个模型` : "接口返回的模型列表为空" };
  } catch (error) {
    return { ok: false, models: [], detail: error instanceof Error && error.name === "AbortError" ? "获取模型列表超时" : "模型列表获取失败，请检查接口地址和网络" };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkApiConnection(config: CodexRuntimeConfig): Promise<ApiCheckResult> {
  if (!config.apiBaseUrl || !config.apiKey) return { ok: false, code: "not_configured", detail: "缺少 API_BASE_URL 或 API_KEY" };
  try {
    if (!validateApiUrl(config.apiBaseUrl)) {
      return { ok: false, detail: "API 地址必须是无内嵌凭据、查询参数和片段的 HTTP(S) 地址" };
    }
  } catch { return { ok: false, detail: "API 地址无效" }; }
  const backend = new ApiCodexBackend({ ...config, timeoutMs: Math.min(config.timeoutMs, 15_000) });
  try {
    const result = await backend.run({
      conversationId: `doctor-${randomUUID()}`,
      role: "family",
      prompt: "Reply with exactly: doctor-ok",
    });
    if (result.exitCode === 0 && !result.timedOut && !result.cancelled && result.text.trim()) {
      return { ok: true, detail: "模型已返回有效文本（使用正式 API 后端及协议回退逻辑）" };
    }
    // Never print upstream error bodies: providers can echo request credentials.
    return { ok: false, ...modelFailure(new Error(result.timedOut ? "API timed out" : result.stderr || "未返回有效文本")) };
  } catch (error) { return { ok: false, ...modelFailure(error) }; }
  finally { backend.dispose(); }
}
