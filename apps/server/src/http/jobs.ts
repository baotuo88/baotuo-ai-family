import type http from "node:http";
import type { AppDatabase } from "../storage/index.js";
import { redactSensitiveText } from "../policy/redact-sensitive.js";
import { readJsonBody, respondJson } from "./response.js";

/** Called only after management authentication. No replay endpoint by design. */
export async function handleJobRoutes(params: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  database: AppDatabase;
  pathname: string;
  method: string;
}): Promise<boolean> {
  const { request, response, database, pathname, method } = params;
  if (pathname === '/api/jobs' && method === 'GET') {
    respondJson(response, 200, { ok: true, jobs: database.listInboundJobStatus(), ...database.getJobDiagnostics() });
    return true;
  }
  const match = /^\/api\/jobs\/([1-9]\d*)(\/resolve)?$/.exec(pathname);
  if (!match) return false;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) {
    respondJson(response, 400, { ok: false, error: 'invalid_job_id' });
    return true;
  }
  if (!match[2] && method === 'GET') {
    const job = database.getInboundJobDetail(id);
    respondJson(response, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: 'job_not_found' });
    return true;
  }
  if (match[2] && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.action !== 'dismiss' || typeof body.note !== 'string' ||
        !body.note.trim() || body.note.length > 500 || body.confirm !== true) {
      respondJson(response, 400, { ok: false, error: 'invalid_resolution',
        message: 'Require action=dismiss, confirm=true and a 1-500 character note. Replay is not supported.' });
      return true;
    }
    const result = database.dismissInboundJob(id, redactSensitiveText(body.note));
    respondJson(response, result === 'dismissed' ? 200 : result === 'not_found' ? 404 : 409,
      { ok: result === 'dismissed', result });
    return true;
  }
  return false;
}
