import { handleSettingsRoutes } from "./settings.js";
import { renderAdminPage } from "./admin-page.js";
import type { SettingsRoutes } from "./settings.js";
import { handleJobRoutes } from "./jobs.js";
import type { RuntimeSnapshot } from "../operations/runtime-status.js";
import http from "node:http";
import { authorizeManagement } from "./auth.js";
import { AppConfig } from "../config/types.js";
import { renderLoginPage } from "../login-page.js";
import { formatBeijingTime } from "../sessions/index.js";
import { AppDatabase } from "../storage/index.js";
import { isUserRole, sanitizeAccountRecord } from "./accounts.js";
import { LoginManager } from "./login-manager.js";
import {
  readJsonBody,
  respondHtml,
  respondJson,
  respondPng,
} from "./response.js";

const SERVICE_NAME = "baotuo-ai-family";
const ROOT_ENDPOINTS = [
  "/api",
  "/healthz",
  "/readyz",
  "/api/accounts",
  "/api/logins",
  "/api/logins/:id",
  "/api/logins/:id/view",
  "/api/logins/:id/qrcode.png",
  "/api/accounts/:id/role",
  "/api/admin-contacts",
  "/api/jobs",
  "/api/jobs/:id",
  "/api/jobs/:id/resolve",
  "/api/status",
  "/admin",
  "/api/settings/models",
  "/api/settings/models/test",
  "/api/contacts",
];

interface HttpRouteContext extends SettingsRoutes {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  config: AppConfig;
  database: AppDatabase;
  loginManager: LoginManager;
  startedAt: string;
  getRuntimeStatus?: (() => RuntimeSnapshot) | undefined;
  method: string;
  pathname: string;
  segments: string[];
}

export async function routeHttpRequest(params: SettingsRoutes & {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  config: AppConfig;
  database: AppDatabase;
  loginManager: LoginManager;
  startedAt: string;
  getRuntimeStatus?: (() => RuntimeSnapshot) | undefined;
}): Promise<void> {
  const requestUrl = new URL(params.request.url ?? "/", "http://127.0.0.1");
  const context: HttpRouteContext = {
    ...params,
    method: params.request.method ?? "GET",
    pathname: requestUrl.pathname,
    segments: requestUrl.pathname.split("/").filter(Boolean),
  };

  if (context.pathname !== "/healthz" &&
      !authorizeManagement(context.request, context.response, context.config.server.adminToken)) {
    return;
  }

  if ((context.pathname === "/" || context.pathname === "/admin") && context.method === "GET") {
    const page = renderAdminPage();
    context.response.setHeader("Content-Security-Policy", page.csp);
    context.response.setHeader("X-Content-Type-Options", "nosniff");
    context.response.setHeader("Referrer-Policy", "no-referrer");
    respondHtml(context.response, 200, page.html);
    return;
  }
  if (await handleSettingsRoutes(context)) return;
  if (context.pathname === "/api/contacts" && context.method === "GET") {
    respondJson(context.response, 200, { ok: true, contacts: context.database.listContacts() });
    return;
  }
  if (await handleHealthRoutes(context)) {
    return;
  }

  if (context.pathname === "/api/admin-contacts" && context.method === "GET") {
    respondJson(context.response, 200, { ok: true, contacts: context.database.listAdminContacts() });
    return;
  }
  if (context.pathname === "/api/admin-contacts" && context.method === "POST") {
    const body = await readJsonBody(context.request);
    if (typeof body.accountId !== "string" || typeof body.contactId !== "string" ||
        !body.contactId.trim() || typeof body.allowed !== "boolean") {
      respondJson(context.response, 400, { ok: false, error: "invalid_contact_grant" });
      return;
    }
    if (!context.database.getAccountById(body.accountId)) {
      respondJson(context.response, 404, { ok: false, error: "account_not_found" });
      return;
    }
    context.database.setAdminContact(body.accountId, body.contactId, body.allowed);
    respondJson(context.response, 200, { ok: true });
    return;
  }
  if (await handleJobRoutes(context)) return;
  if (context.pathname === "/api/status" && context.method === "GET") {
    const runtime = context.getRuntimeStatus?.();
    respondJson(context.response, 200, { ok: true, runtime: runtime ?? null,
      jobs: context.database.getJobDiagnostics() });
    return;
  }

  if (await handleAccountRoutes(context)) {
    return;
  }

  if (await handleLoginRoutes(context)) {
    return;
  }

  if (await handleRootRoute(context)) {
    return;
  }

  respondJson(context.response, 404, {
    ok: false,
    error: "not_found",
    path: context.pathname,
  });
}

async function handleHealthRoutes(
  context: HttpRouteContext,
): Promise<boolean> {
  if (context.method === "GET" && context.pathname === "/healthz") {
    respondJson(context.response, 200, {
      ok: true,
      service: SERVICE_NAME,
      timezone: context.config.server.timezone,
      startedAt: context.startedAt,
    });
    return true;
  }

  if (context.method === "GET" && context.pathname === "/readyz") {
    const runtime = context.getRuntimeStatus?.();
    respondJson(context.response, runtime?.ready ? 200 : 503, {
      ok: runtime?.ready ?? false,
      databaseFile: context.database.getFilePath(),
      accounts: context.database.listAccounts().length,
      runtime: runtime ?? null,
      jobs: context.database.getJobDiagnostics(),
    });
    return true;
  }

  return false;
}

async function handleAccountRoutes(
  context: HttpRouteContext,
): Promise<boolean> {
  if (context.method === "GET" && context.pathname === "/api/accounts") {
    respondJson(context.response, 200, {
      ok: true,
      accounts: context.database.listAccounts().map(sanitizeAccountRecord),
    });
    return true;
  }

  if (
    context.method === "POST" &&
    context.segments[0] === "api" &&
    context.segments[1] === "accounts" &&
    context.segments[3] === "role" &&
    context.segments.length === 4
  ) {
    const accountId = decodeURIComponent(context.segments[2] ?? "");
    const body = await readJsonBody(context.request);

    if (!isUserRole(body.role)) {
      respondJson(context.response, 400, {
        ok: false,
        error: "invalid_role",
      });
      return true;
    }

    if (!context.database.getAccountById(accountId)) {
      respondJson(context.response, 404, {
        ok: false,
        error: "account_not_found",
      });
      return true;
    }

    const updated = context.database.updateAccountRole(accountId, body.role);
    respondJson(context.response, 200, {
      ok: true,
      account: sanitizeAccountRecord(updated),
    });
    return true;
  }

  return false;
}

async function handleLoginRoutes(context: HttpRouteContext): Promise<boolean> {
  if (context.method === "POST" && context.pathname === "/api/logins") {
    const body = await readJsonBody(context.request);
    const role = isUserRole(body.role) ? body.role : "family";
    const created = await context.loginManager.create(role);

    respondJson(context.response, 201, {
      ok: true,
      login: created,
    });
    return true;
  }

  if (
    context.method === "GET" &&
    context.segments[0] === "api" &&
    context.segments[1] === "logins" &&
    context.segments.length === 3
  ) {
    const login = context.loginManager.serializeById(
      decodeURIComponent(context.segments[2] ?? ""),
    );
    if (!login) {
      respondJson(context.response, 404, {
        ok: false,
        error: "login_not_found",
      });
      return true;
    }

    respondJson(context.response, 200, {
      ok: true,
      login,
    });
    return true;
  }

  if (
    context.method === "GET" &&
    context.segments[0] === "api" &&
    context.segments[1] === "logins" &&
    context.segments[3] === "view" &&
    context.segments.length === 4
  ) {
    const loginId = decodeURIComponent(context.segments[2] ?? "");
    const login = context.loginManager.serializeById(loginId);
    if (!login) {
      respondJson(context.response, 404, {
        ok: false,
        error: "login_not_found",
      });
      return true;
    }

    respondHtml(
      context.response,
      200,
      renderLoginPage({
        loginId,
        role: String(login.role ?? "family"),
        status: String(login.status ?? "waiting"),
      }),
    );
    return true;
  }

  if (
    context.method === "GET" &&
    context.segments[0] === "api" &&
    context.segments[1] === "logins" &&
    context.segments[3] === "qrcode.png" &&
    context.segments.length === 4
  ) {
    const buffer = context.loginManager.getQrCodeBuffer(
      decodeURIComponent(context.segments[2] ?? ""),
    );
    if (!buffer) {
      respondJson(context.response, 404, {
        ok: false,
        error: "login_not_found",
      });
      return true;
    }

    respondPng(context.response, 200, buffer);
    return true;
  }

  return false;
}

async function handleRootRoute(context: HttpRouteContext): Promise<boolean> {
  if (context.method !== "GET" || context.pathname !== "/api") {
    return false;
  }

  respondJson(context.response, 200, {
    service: SERVICE_NAME,
    status: "running",
    time: formatBeijingTime(new Date()),
    endpoints: ROOT_ENDPOINTS,
  });
  return true;
}
