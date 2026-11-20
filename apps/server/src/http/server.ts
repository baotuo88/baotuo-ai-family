import type { SettingsRoutes } from "./settings.js";
import type { RuntimeSnapshot } from "../operations/runtime-status.js";
import http from "node:http";
import { AppConfig } from "../config/types.js";
import { AppDatabase } from "../storage/index.js";
import { LoginManager } from "./login-manager.js";
import { InvalidJsonBodyError, respondJson } from "./response.js";
import { routeHttpRequest } from "./routes.js";

export interface GatewayHttpServerParams extends SettingsRoutes {
  config: AppConfig;
  database: AppDatabase;
  loginManager: LoginManager;
  startedAt: string;
  getRuntimeStatus?: (() => RuntimeSnapshot) | undefined;
}

export function createGatewayHttpServer(
  params: GatewayHttpServerParams,
): http.Server {
  return http.createServer(async (request, response) => {
    try {
      await routeHttpRequest({
        ...params,
        request,
        response,
      });
    } catch (error) {
      if (error instanceof InvalidJsonBodyError) {
        respondJson(response, 400, {
          ok: false,
          error: "invalid_json",
          message: error.message,
        });
        return;
      }

      respondJson(response, 500, {
        ok: false,
        error: "internal_error",
        message: "Request failed; inspect server logs",
      });
    }
  });
}

export async function listenServer(
  server: http.Server,
  port: number,
  host = "127.0.0.1",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
