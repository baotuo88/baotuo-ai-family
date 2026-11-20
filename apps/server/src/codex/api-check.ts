import { randomUUID } from "node:crypto";
import type { CodexRuntimeConfig } from "../config/types.js";
import { ApiCodexBackend } from "./api-backend.js";

export interface ApiCheckResult { ok: boolean; detail: string }
export async function checkApiConnection(config: CodexRuntimeConfig): Promise<ApiCheckResult> {
  if (!config.apiBaseUrl || !config.apiKey) return { ok: false, detail: "缺少 API_BASE_URL 或 API_KEY" };
  try {
    const url = new URL(config.apiBaseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
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
    return { ok: false, detail: result.timedOut ? "API 连接超时" : "API 未返回有效文本，请检查地址、Key、模型及额度" };
  } catch { return { ok: false, detail: "API 连接失败，请检查配置和网络" }; }
  finally { backend.dispose(); }
}
