import { SettingsInputError } from "./settings-errors.js";

export interface ImageSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
  quality: string;
  responseFormat: "b64_json" | "auto";
  timeoutMs: number;
  maxConcurrent: number;
  dailyLimit: number;
}
export function validateImageSettings(body: Record<string, unknown>, previous?: ImageSettings): ImageSettings {
  const text = (name: string, max: number): string => {
    const value = body[name];
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
      throw new SettingsInputError(`生图配置 ${name} 无效`);
    }
    return value.trim();
  };
  const baseUrl = text("baseUrl", 2048).replace(/\/+$/, "");
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
  } catch { throw new SettingsInputError("生图地址仅支持无凭据、查询参数和片段的 HTTP(S) URL"); }
  const apiKey = body.apiKey === undefined || body.apiKey === "" ? previous?.apiKey : text("apiKey", 8192);
  if (!apiKey) throw new SettingsInputError("首次配置生图必须填写 Key；聊天 Key 不会自动用于生图");
  if (typeof body.enabled !== "boolean") throw new SettingsInputError("请选择是否启用生图");
  const integer = (name: string, min: number, max: number, fallback: number): number => {
    const value = body[name] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new SettingsInputError(`生图配置 ${name} 超出范围`);
    return value;
  };
  const size = text("size", 30), quality = text("quality", 30);
  if (!/^(?:auto|(?:[1-9]\d{1,3})x(?:[1-9]\d{1,3}))$/.test(size)) throw new SettingsInputError("图片尺寸应为 auto 或宽x高");
  if (!["auto", "low", "medium", "high", "standard", "hd"].includes(quality)) throw new SettingsInputError("图片质量无效");
  const responseFormat = body.responseFormat ?? "b64_json";
  if (responseFormat !== "b64_json" && responseFormat !== "auto") throw new SettingsInputError("图片响应格式无效");
  return { enabled: body.enabled, baseUrl, apiKey, model: text("model", 200), size, quality, responseFormat,
    timeoutMs: integer("timeoutMs", 10000, 300000, 120000), maxConcurrent: integer("maxConcurrent", 1, 4, 1),
    dailyLimit: integer("dailyLimit", 1, 10000, 20) };
}
