import { UserRole } from "../config/types.js";

export interface RouteTarget {
  role: UserRole;
  reason: string;
}

export function resolveRole(params: {
  configuredRole?: UserRole;
  adminContactAllowed?: boolean;
}): RouteTarget {
  if (params.configuredRole === "admin" && params.adminContactAllowed === true) {
    return { role: "admin", reason: "admin account and explicitly authorized contact" };
  }
  return { role: "family", reason: "default to family without both authorizations" };
}
