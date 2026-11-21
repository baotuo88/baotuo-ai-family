import type http from "node:http";
import type { AppDatabase } from "../storage/database.js";
import type { AppConfig, UserRole } from "../config/types.js";
import { checkApiConnection, listApiModels } from "../codex/api-check.js";
import { applyModelSettings, ModelSettingsStore, SettingsBusyError, SettingsInputError, type ModelSettings } from "../settings/model-settings.js";
import { readJsonBody, respondJson } from "./response.js";
export interface SettingsRoutes {
  redeliverMedia?: ((id: string) => Promise<void>) | undefined;
  settings?: ModelSettingsStore | undefined;
  saveModelSettings?: ((role: UserRole, value: ModelSettings) => void) | undefined;
}
const testing = new WeakSet<ModelSettingsStore>();
export async function handleSettingsRoutes(context: SettingsRoutes & {
  request: http.IncomingMessage; response: http.ServerResponse; config: AppConfig; database?: AppDatabase; pathname: string; method: string;
}): Promise<boolean> {
  if (!['/api/settings/models', '/api/settings/models/test', '/api/settings/models/list'].includes(context.pathname)) return false;
  const { settings, response } = context;
  if (!settings) { respondJson(response, 503, { ok: false, error: 'settings_unavailable' }); return true; }
  if (context.method === 'GET' && context.pathname === '/api/settings/models') {
    respondJson(response, 200, { ok: true, ...settings.view() }); return true;
  }
  if (context.method !== 'POST') { respondJson(response, 405, { ok: false, error: 'method_not_allowed' }); return true; }
  // JSON + custom header prevents cross-site form posts with cached Basic auth.
  if (context.request.headers['x-gateway-request'] !== 'dashboard' ||
      !context.request.headers['content-type']?.startsWith('application/json')) {
    respondJson(response, 403, { ok: false, error: 'invalid_management_request' }); return true;
  }
  try {
    const body = await readJsonBody(context.request);
    if (body.role !== 'admin' && body.role !== 'family') throw new SettingsInputError('Invalid role');
    if (context.pathname.endsWith('/list')) {
      const endpoint = settings.prepareEndpoint(body.role, body);
      const result = await listApiModels(endpoint.baseUrl, endpoint.apiKey);
      respondJson(response, result.ok ? 200 : 502, { ...result });
      return true;
    }
    const value = settings.prepare(body.role, body);
    if (context.pathname.endsWith('/test')) {
      if (testing.has(settings)) throw new SettingsBusyError('连接测试进行中，请稍后');
      testing.add(settings);
      try {
        const result = await checkApiConnection(applyModelSettings(context.config.codex[body.role], value));
        context.database?.capabilities.recordCheck(body.role, settings.fingerprint(body.role, value), result.ok, result.code ?? null);
        respondJson(response, 200, { ...result, scope: 'API only; ACP sandbox not tested' });
      } finally { testing.delete(settings); }
    } else {
      if (!context.saveModelSettings) throw new Error('Settings update unavailable');
      context.saveModelSettings(body.role, value);
      respondJson(response, 200, { ok: true, ...settings.view() });
    }
  } catch (error) {
    if (error instanceof SettingsInputError || error instanceof SettingsBusyError) {
      respondJson(response, error instanceof SettingsBusyError ? 409 : 400,
        { ok: false, error: error instanceof SettingsBusyError ? 'busy' : 'invalid_settings', message: error.message });
    } else throw error;
  }
  return true;
}
