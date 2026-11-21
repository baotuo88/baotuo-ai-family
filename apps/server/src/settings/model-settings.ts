import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AppConfig, CodexApiWireApi, CodexRuntimeConfig, CodexReasoningEffort, UserRole } from "../config/types.js";
import { validateImageSettings, type ImageSettings } from "./image-settings.js";
import { SettingsInputError } from "./settings-errors.js";
export { SettingsInputError } from "./settings-errors.js";
import { isCodexReasoningEffort, isCodexModelReasoningEffortSupported } from "../config/reasoning.js";

export interface ModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  backend: "api" | "acp";
  wireApi: CodexApiWireApi;
}
export type ModelSettingsMap = Partial<Record<UserRole, ModelSettings>>;
export class SettingsBusyError extends Error {}
export class ModelNotConfiguredError extends Error {
  constructor(readonly role: UserRole) {
    super(role === "family" ? "家庭聊天模型尚未配置" : "管理员模型尚未配置");
  }
}

function validate(input: Record<string, unknown>, previous?: ModelSettings): ModelSettings {
  const text = (name: string, max: number): string => {
    const value = input[name];
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
      throw new SettingsInputError(`Invalid ${name}`);
    }
    return value.trim();
  };
  const baseUrl = text("baseUrl", 2048);
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new SettingsInputError("Invalid baseUrl"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new SettingsInputError("API 地址仅支持无凭据、查询参数和片段的 HTTP(S) URL");
  }
  const model = text("model", 200);
  const reasoningEffort = text("reasoningEffort", 20);
  if (!isCodexReasoningEffort(reasoningEffort) || !isCodexModelReasoningEffortSupported(model, reasoningEffort)) {
    throw new SettingsInputError("模型与思考强度不兼容");
  }
  if (input.backend !== 'api' && input.backend !== 'acp') throw new SettingsInputError("Invalid backend");
  const wireApi = input.wireApi === undefined ? (previous?.wireApi ?? "auto") : input.wireApi;
  if (wireApi !== "auto" && wireApi !== "responses" && wireApi !== "chat") throw new SettingsInputError("Invalid API interface");
  const apiKey = input.apiKey === undefined || input.apiKey === ""
    ? previous?.apiKey : text("apiKey", 8192);
  if (!apiKey) throw new SettingsInputError("首次保存必须填写 API Key；留空仅保留已有 Key");
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model, apiKey, reasoningEffort, backend: input.backend, wireApi };
}

export function applyModelSettings(base: CodexRuntimeConfig, settings: ModelSettings): CodexRuntimeConfig {
  return { ...base, backend: settings.backend, apiBaseUrl: settings.baseUrl, apiKey: settings.apiKey,
    apiWireApi: settings.wireApi,
    apiModel: settings.model, acpAuthMode: 'env',
    roleOverrides: { model: settings.model, reasoningEffort: settings.reasoningEffort },
    envOverrides: { ...base.envOverrides,
      CODEX_CLI_API_KEY: settings.apiKey, OPENAI_API_KEY: settings.apiKey, CODEX_API_KEY: settings.apiKey,
      CODEX_CLI_BASE_URL: settings.baseUrl, CODEX_API_BASE_URL: settings.baseUrl,
    } };
}

/** Only this module handles encryption and key-preserving updates. Public views never contain keys. */
export class ModelSettingsStore {
  private current: ModelSettingsMap = {};
  private images: ImageSettings | undefined;
  private readonly directory: string;
  private readonly file: string;
  private readonly keyFile: string;
  constructor(dataDir: string, private readonly config: AppConfig) {
    this.directory = path.join(dataDir, '.settings');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Settings directory must not be a symlink');
    if (process.platform !== 'win32') fs.chmodSync(this.directory, 0o700);
    this.file = path.join(this.directory, 'models.enc');
    this.keyFile = path.join(this.directory, 'key');
    for (const file of [this.file, this.keyFile]) {
      if (fs.existsSync(file)) {
        if (!fs.lstatSync(file).isFile()) throw new Error('Invalid settings file');
        if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      }
    }
    if (fs.existsSync(this.file)) {
      try {
        const encrypted = fs.readFileSync(this.file);
        const decipher = createDecipheriv('aes-256-gcm', fs.readFileSync(this.keyFile), encrypted.subarray(0, 12));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        const parsed = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8'));
        for (const role of ['admin', 'family'] as const) if (parsed[role]) this.current[role] = validate(parsed[role]);
        if (parsed.images) this.images = validateImageSettings(parsed.images);
      } catch { throw new Error('Cannot read model settings; restore .settings and its key together'); }
    }
  }
  get(role: UserRole): ModelSettings | undefined {
    const value = this.current[role];
    return value ? { ...value } : undefined;
  }
  view() {
    const roles = Object.fromEntries((['admin', 'family'] as const).map(role => {
      const saved = this.current[role];
      const base = this.config.codex[role];
      return [role, { baseUrl: saved?.baseUrl ?? base.apiBaseUrl ?? '', model: saved?.model ?? base.apiModel,
        reasoningEffort: saved?.reasoningEffort ?? base.roleOverrides?.reasoningEffort ?? 'high',
        backend: saved?.backend ?? base.backend, wireApi: saved?.wireApi ?? base.apiWireApi ?? 'auto', hasApiKey: Boolean(saved?.apiKey ?? base.apiKey),
        source: saved ? 'dashboard' : 'environment' }];
    }));
    return { roles, precedence: 'dashboard > environment/WeChat model and provider overrides for configured roles' };
  }
  prepare(role: UserRole, body: Record<string, unknown>): ModelSettings {
    const base = this.config.codex[role];
    const previous = this.current[role] ?? (base.apiKey ? {
      baseUrl: base.apiBaseUrl ?? '', apiKey: base.apiKey, model: base.apiModel,
      reasoningEffort: base.roleOverrides?.reasoningEffort ?? 'high', backend: base.backend === 'api' ? 'api' : 'acp', wireApi: base.apiWireApi ?? 'auto',
    } as ModelSettings : undefined);
    return validate(body, previous);
  }

  prepareEndpoint(role: UserRole, body: Record<string, unknown>): { baseUrl: string; apiKey: string } {
    const value = body.baseUrl;
    if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value)) {
      throw new SettingsInputError("Invalid baseUrl");
    }
    const baseUrl = value.trim();
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error();
      }
    } catch {
      throw new SettingsInputError("API 地址仅支持无凭据、查询参数和片段的 HTTP(S) URL");
    }
    const base = this.config.codex[role];
    const previous = this.current[role]?.apiKey ?? base.apiKey;
    const apiKey = body.apiKey === undefined || body.apiKey === "" ? previous : body.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) {
      throw new SettingsInputError("首次获取模型必须填写 API Key；留空仅保留已有 Key");
    }
    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: apiKey.trim() };
  }
  effective(role: UserRole): ModelSettings {
    const base = this.config.codex[role];
    return this.get(role) ?? { baseUrl: base.apiBaseUrl ?? '', apiKey: base.apiKey ?? '', model: base.apiModel,
      reasoningEffort: base.roleOverrides?.reasoningEffort ?? 'high', backend: base.backend === 'api' ? 'api' : 'acp',
      wireApi: base.apiWireApi ?? 'auto' };
  }
  fingerprint(role: UserRole, candidate = this.effective(role)): string {
    return createHash('sha256').update(JSON.stringify([role, candidate.baseUrl, candidate.apiKey,
      candidate.model, candidate.wireApi, candidate.reasoningEffort, candidate.backend])).digest('hex');
  }
  copyAdminForFamily(): ModelSettings {
    return validate({ ...this.effective('admin'), backend: 'api' });
  }
  getImages(): ImageSettings | undefined { return this.images ? { ...this.images } : undefined; }
  imagesView() {
    const value = this.images;
    if (!value) return { enabled: false, configured: false, hasApiKey: false, baseUrl: '', model: '',
      size: '1024x1024', quality: 'auto', responseFormat: 'b64_json', timeoutMs: 120000, maxConcurrent: 1, dailyLimit: 20 };
    const { apiKey, ...publicValue } = value;
    return { ...publicValue, configured: true, hasApiKey: Boolean(apiKey) };
  }
  prepareImages(body: Record<string, unknown>): ImageSettings { return validateImageSettings(body, this.images); }
  saveImages(value: ImageSettings): void {
    this.persist({ ...this.current, images: value });
    this.images = { ...value };
  }
  save(role: UserRole, settings: ModelSettings): void {
    const next = { ...this.current, [role]: settings };
    this.persist({ ...next, ...(this.images ? { images: this.images } : {}) });
    this.current = next;
  }
  private persist(value: Record<string, unknown>): void {
    if (!fs.existsSync(this.keyFile)) fs.writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', fs.readFileSync(this.keyFile), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
