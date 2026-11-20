import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { respondJson } from "./response.js";

// Basic auth supports the existing browser QR page without putting tokens in URLs.
export function authorizeManagement(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  token: string,
): boolean {
  if (token.length < 32) {
    respondJson(response, 503, { ok: false, error: "management_disabled" });
    return false;
  }
  const header = request.headers.authorization ?? "";
  let supplied = "";
  if (header.startsWith("Bearer ")) supplied = header.slice(7);
  if (header.startsWith("Basic ")) {
    const credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
    if (credentials.startsWith("admin:")) supplied = credentials.slice(6);
  }
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  // Reject cross-origin browser writes even when Basic credentials are cached.
  const origin = request.headers.origin;
  let sameOrigin = !origin;
  if (origin) {
    try { sameOrigin = new URL(origin).host === request.headers.host; } catch { /* deny */ }
  }
  if (!sameOrigin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    response.setHeader("WWW-Authenticate", 'Basic realm="Gateway management", charset="UTF-8"');
    respondJson(response, 401, { ok: false, error: "unauthorized" });
    return false;
  }
  response.setHeader("Cache-Control", "no-store");
  return true;
}
