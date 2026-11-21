import type { ImageSettings } from "../settings/image-settings.js";
import { ModelServiceError, providerFailure } from "../operations/model-failure.js";
import { downloadProviderImage } from "./provider-download.js";

export function imageFormat(buffer: Buffer): { extension: string; mimeType: string } {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { extension: "png", mimeType: "image/png" };
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { extension: "jpg", mimeType: "image/jpeg" };
  if (buffer.length >= 12 && buffer.toString("ascii",0,4) === "RIFF" && buffer.toString("ascii",8,12) === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString("ascii",0,6))) return { extension: "gif", mimeType: "image/gif" };
  throw new ModelServiceError("invalid_response", "接口没有返回可识别的 PNG、JPEG、WebP 或 GIF 图片。");
}
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new ModelServiceError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ModelServiceError("invalid_response", "图片响应超过大小限制。"); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ModelServiceError("invalid_response"); }
  } finally { reader.releaseLock(); }
}
/** One paid submission only. Transport failures never trigger an automatic regeneration. */
export async function generateImage(settings: ImageSettings, prompt: string, signal: AbortSignal, maxBytes: number) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);
  try {
    requestSignal.throwIfAborted();
    const response = await fetch(`${settings.baseUrl}/images/generations`, { method: "POST", redirect: "error", signal: requestSignal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model, prompt, n: 1, size: settings.size, quality: settings.quality,
        ...(settings.responseFormat === "b64_json" ? { response_format: "b64_json" } : {}) }) });
    if (!response.ok) {
      let code = "";
      try {
        const payload = await boundedJson(response, 32768) as { error?: { code?: unknown; type?: unknown } };
        code = typeof payload.error?.code === "string" ? payload.error.code : typeof payload.error?.type === "string" ? payload.error.type : "";
      } catch { /* Upstream error bodies are never logged or returned. */ }
      throw providerFailure(response.status, code);
    }
    const payload = await boundedJson(response, Math.ceil(maxBytes * 4 / 3) + 131072) as { data?: { b64_json?: unknown; url?: unknown }[] };
    const item = payload?.data?.[0];
    let buffer: Buffer;
    if (typeof item?.b64_json === "string") {
      const encoded = item.b64_json.replace(/\s/g, "");
      if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new ModelServiceError("invalid_response");
      buffer = Buffer.from(encoded, "base64");
    } else if (typeof item?.url === "string") {
      buffer = await downloadProviderImage(item.url, requestSignal, maxBytes);
    } else throw new ModelServiceError("invalid_response");
    if (!buffer.length || buffer.length > maxBytes) throw new ModelServiceError("invalid_response", "生成图片为空或超过允许大小，请降低尺寸。");
    return { buffer, ...imageFormat(buffer) };
  } catch (error) {
    if (error instanceof ModelServiceError) throw error;
    if (signal.aborted) throw new ModelServiceError("cancelled");
    if (requestSignal.aborted) throw new ModelServiceError("timeout");
    throw new ModelServiceError("network");
  }
}
