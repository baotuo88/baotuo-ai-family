import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { respondJson } from "./response.js";

export const MANAGEMENT_SESSION_COOKIE = "gateway_management_session";
export const MANAGEMENT_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const MANAGEMENT_LOGIN_WINDOW_MS = 5 * 60 * 1000;
export const MANAGEMENT_LOGIN_MAX_FAILURES = 8;
export const MANAGEMENT_LOGIN_LOCKOUT_MS = 30 * 1000;
const MANAGEMENT_LOGIN_MAX_TRACKED_CLIENTS = 4096;
const revokedManagementSessions = new Map<string, number>();
const managementLoginAttempts = new Map<string, {
  windowStartedAt: number;
  failures: number;
  lockedUntil: number;
  lastSeenAt: number;
}>();
const SESSION_REVOCATION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPT_CLEANUP_INTERVAL_MS = 30 * 1000;
let lastRevocationCleanupAt = 0;
let lastLoginAttemptCleanupAt = 0;
const processSessionNonce = randomBytes(32).toString("base64url");

export function createManagementSession(token: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const id = randomBytes(24).toString("base64url");
  const signature = createManagementSessionSignature(token, issuedAt, id);
  return `${issuedAt}.${id}.${signature}`;
}

function validManagementSession(value: string, token: string, now = Date.now()): boolean {
  pruneRevokedManagementSessions(now);
  const revokedUntil = revokedManagementSessions.get(value);
  if (revokedUntil !== undefined && revokedUntil > now) return false;
  const [issuedAtText, id, signature, ...extra] = value.split(".");
  if (!issuedAtText || !id || !signature || extra.length) return false;
  const issuedAt = Number(issuedAtText);
  const current = Math.floor(now / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > current || current - issuedAt > MANAGEMENT_SESSION_TTL_SECONDS) return false;
  const expected = Buffer.from(createManagementSessionSignature(token, issuedAt, id));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createManagementSessionSignature(token: string, issuedAt: number, id: string): string {
  return createHmac("sha256", token).update(`management:${processSessionNonce}:${issuedAt}:${id}`).digest("base64url");
}

export function managementLoginClientKey(request: http.IncomingMessage): string {
  const remoteAddress = request.socket?.remoteAddress;
  return remoteAddress ? `ip:${remoteAddress}` : "";
}

export function checkManagementLoginRateLimit(
  request: http.IncomingMessage,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const key = managementLoginClientKey(request);
  if (!key) return { allowed: true, retryAfterSeconds: 0 };
  pruneManagementLoginAttempts(now);
  const attempt = managementLoginAttempts.get(key);
  if (!attempt || attempt.lockedUntil <= now) return { allowed: true, retryAfterSeconds: 0 };
  attempt.lastSeenAt = now;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((attempt.lockedUntil - now) / 1000)),
  };
}

export function recordManagementLoginFailure(
  request: http.IncomingMessage,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const key = managementLoginClientKey(request);
  if (!key) return { allowed: true, retryAfterSeconds: 0 };
  pruneManagementLoginAttempts(now);
  const current = managementLoginAttempts.get(key);
  const attempt = !current || now - current.windowStartedAt >= MANAGEMENT_LOGIN_WINDOW_MS
    ? { windowStartedAt: now, failures: 0, lockedUntil: 0, lastSeenAt: now }
    : current;
  attempt.failures += 1;
  attempt.lastSeenAt = now;
  if (attempt.failures >= MANAGEMENT_LOGIN_MAX_FAILURES) {
    attempt.lockedUntil = now + MANAGEMENT_LOGIN_LOCKOUT_MS;
  }
  managementLoginAttempts.set(key, attempt);
  return checkManagementLoginRateLimit(request, now);
}

export function clearManagementLoginFailures(request: http.IncomingMessage): void {
  const key = managementLoginClientKey(request);
  if (key) managementLoginAttempts.delete(key);
}

function pruneManagementLoginAttempts(now: number): void {
  if (now - lastLoginAttemptCleanupAt < LOGIN_ATTEMPT_CLEANUP_INTERVAL_MS &&
      managementLoginAttempts.size <= MANAGEMENT_LOGIN_MAX_TRACKED_CLIENTS) {
    return;
  }
  lastLoginAttemptCleanupAt = now;
  for (const [key, attempt] of managementLoginAttempts) {
    if (now - attempt.lastSeenAt >= MANAGEMENT_LOGIN_WINDOW_MS && attempt.lockedUntil <= now) {
      managementLoginAttempts.delete(key);
    }
  }
  if (managementLoginAttempts.size <= MANAGEMENT_LOGIN_MAX_TRACKED_CLIENTS) return;

  const oldest = [...managementLoginAttempts.entries()]
    .sort(([, left], [, right]) => left.lastSeenAt - right.lastSeenAt);
  const removeCount = managementLoginAttempts.size - MANAGEMENT_LOGIN_MAX_TRACKED_CLIENTS;
  for (let index = 0; index < removeCount; index += 1) {
    const entry = oldest[index];
    if (entry) managementLoginAttempts.delete(entry[0]);
  }
}

export function readManagementSessionCookie(request: http.IncomingMessage): string {
  const prefix = `${MANAGEMENT_SESSION_COOKIE}=`;
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) {
      try { return decodeURIComponent(cookie.slice(prefix.length)); } catch { return ""; }
    }
  }
  return "";
}

export function revokeManagementSession(value: string): void {
  if (!value) return;
  const now = Date.now();
  pruneRevokedManagementSessions(now);
  const issuedAt = Number(value.split(".", 1)[0]);
  if (!Number.isSafeInteger(issuedAt)) return;
  revokedManagementSessions.set(value, (issuedAt + MANAGEMENT_SESSION_TTL_SECONDS) * 1000);
}

function pruneRevokedManagementSessions(now: number): void {
  if (now - lastRevocationCleanupAt < SESSION_REVOCATION_CLEANUP_INTERVAL_MS) return;
  for (const [session, expiresAt] of revokedManagementSessions) {
    if (expiresAt <= now) revokedManagementSessions.delete(session);
  }
  lastRevocationCleanupAt = now;
}

export function originMatchesRequest(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

export function verifyManagementToken(supplied: string, token: string): boolean {
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isManagementAuthenticated(request: http.IncomingMessage, token: string): boolean {
  if (token.length < 32 || !originMatchesRequest(request)) return false;
  const header = request.headers.authorization ?? "";
  let supplied = "";
  if (header.startsWith("Bearer ")) supplied = header.slice(7);
  if (header.startsWith("Basic ")) {
    const credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
    if (credentials.startsWith("admin:")) supplied = credentials.slice(6);
  }
  return verifyManagementToken(supplied, token) ||
    validManagementSession(readManagementSessionCookie(request), token);
}

export function managementSessionCookie(request: http.IncomingMessage, token: string): string {
  const secure = Boolean((request.socket as (typeof request.socket & { encrypted?: boolean }) | undefined)?.encrypted) ||
    request.headers["x-forwarded-proto"] === "https";
  return `${MANAGEMENT_SESSION_COOKIE}=${createManagementSession(token)}; Path=/; Max-Age=${MANAGEMENT_SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function expiredManagementSessionCookie(): string {
  return `${MANAGEMENT_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

export function authorizeManagement(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  token: string,
): boolean {
  if (token.length < 32) {
    respondJson(response, 503, { ok: false, error: "management_disabled" });
    return false;
  }
  if (!isManagementAuthenticated(request, token)) {
    respondJson(response, 401, { ok: false, error: "unauthorized" });
    return false;
  }
  response.setHeader("Cache-Control", "no-store");
  return true;
}
