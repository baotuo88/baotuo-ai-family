import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ModelServiceError } from "../operations/model-failure.js";

export const CAPABILITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_checks (
  role TEXT NOT NULL, fingerprint TEXT NOT NULL, ok INTEGER NOT NULL,
  code TEXT, checked_at TEXT NOT NULL, PRIMARY KEY(role, fingerprint)
);
CREATE TABLE IF NOT EXISTS member_policies (
  account_id TEXT NOT NULL, contact_id TEXT NOT NULL, chat_enabled INTEGER NOT NULL DEFAULT 1,
  images_enabled INTEGER NOT NULL DEFAULT 0, daily_chat_limit INTEGER NOT NULL DEFAULT 0,
  daily_image_limit INTEGER NOT NULL DEFAULT 3, updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, contact_id)
);
CREATE TABLE IF NOT EXISTS member_usage (
  account_id TEXT NOT NULL, contact_id TEXT NOT NULL, usage_date TEXT NOT NULL,
  capability TEXT NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, contact_id,capability,request_id)
);
CREATE INDEX IF NOT EXISTS member_usage_day ON member_usage(usage_date,capability,account_id,contact_id);
CREATE TABLE IF NOT EXISTS generated_media (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, contact_id TEXT NOT NULL, session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'not_attempted', local_path TEXT, mime_type TEXT,
  size_bytes INTEGER, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id,source_message_id)
);
CREATE TABLE IF NOT EXISTS invocation_diagnostics (
  id TEXT PRIMARY KEY, job_id INTEGER, role TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
export interface MemberPolicy {
  chatEnabled: boolean; imagesEnabled: boolean; dailyChatLimit: number; dailyImageLimit: number;
}
export interface GeneratedMedia {
  id: string; account_id: string; contact_id: string; session_id: string; source_message_id: string;
  model: string; status: string; delivery_status: string; local_path: string | null;
  mime_type: string | null; size_bytes: number | null; error_code: string | null; created_at: string; updated_at: string;
}
export function usageDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
/** Persistent limits and media state share the application's SQLite transaction boundary. */
export class CapabilityStore {
  constructor(private readonly db: DatabaseSync) {}
  policy(accountId: string, contactId: string): MemberPolicy {
    const row = this.db.prepare("SELECT * FROM member_policies WHERE account_id=? AND contact_id=?").get(accountId, contactId);
    return row ? { chatEnabled: Boolean(row.chat_enabled), imagesEnabled: Boolean(row.images_enabled),
      dailyChatLimit: Number(row.daily_chat_limit), dailyImageLimit: Number(row.daily_image_limit) }
      : { chatEnabled: true, imagesEnabled: false, dailyChatLimit: 0, dailyImageLimit: 3 };
  }
  savePolicy(accountId: string, contactId: string, value: MemberPolicy): void {
    this.db.prepare(`INSERT INTO member_policies VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,contact_id) DO UPDATE SET
      chat_enabled=excluded.chat_enabled,images_enabled=excluded.images_enabled,daily_chat_limit=excluded.daily_chat_limit,
      daily_image_limit=excluded.daily_image_limit,updated_at=excluded.updated_at`).run(accountId, contactId,
      Number(value.chatEnabled), Number(value.imagesEnabled), value.dailyChatLimit, value.dailyImageLimit, new Date().toISOString());
  }
  listMembers(): Record<string, unknown>[] {
    const peers = this.db.prepare(`SELECT wechat_account_id AS accountId,contact_id AS contactId FROM contacts
      UNION SELECT account_id,contact_id FROM member_policies LIMIT 500`).all();
    return peers.map(row => ({ ...row, ...this.policy(String(row.accountId), String(row.contactId)),
      chatUsed: this.used(String(row.accountId), String(row.contactId), "chat"),
      imagesUsed: this.used(String(row.accountId), String(row.contactId), "image"), date: usageDay() }));
  }
  used(accountId: string, contactId: string, capability: "chat" | "image", date = usageDay()): number {
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM member_usage WHERE account_id=? AND contact_id=?
      AND capability=? AND usage_date=?`).get(accountId, contactId, capability, date)?.count ?? 0);
  }
  reserve(accountId: string, contactId: string, capability: "chat" | "image", requestId: string,
      options: { admin?: boolean; globalImageLimit?: number } = {}): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const policy = this.policy(accountId, contactId), date = usageDay();
      if (!options.admin && !(capability === "chat" ? policy.chatEnabled : policy.imagesEnabled)) throw new ModelServiceError("permission");
      const existing = this.db.prepare("SELECT 1 FROM member_usage WHERE account_id=? AND contact_id=? AND capability=? AND request_id=?")
        .get(accountId, contactId, capability, requestId);
      if (!existing) {
        const limit = capability === "chat" ? policy.dailyChatLimit : policy.dailyImageLimit;
        if (!options.admin && limit > 0 && this.used(accountId, contactId, capability, date) >= limit) {
          throw new ModelServiceError("quota_exceeded", `今日${capability === "image" ? "画图" : "聊天"}次数已用完，请明天再试或联系管理员。`);
        }
        const globalUsed = Number(this.db.prepare("SELECT COUNT(*) AS count FROM member_usage WHERE capability='image' AND usage_date=?").get(date)?.count ?? 0);
        if (capability === "image" && options.globalImageLimit && globalUsed >= options.globalImageLimit) {
          throw new ModelServiceError("quota_exceeded", "今日全站画图额度已用完，请明天再试。");
        }
        this.db.prepare("INSERT INTO member_usage VALUES (?,?,?,?,?,?)").run(accountId, contactId, date, capability, requestId, new Date().toISOString());
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  recordCheck(role: string, fingerprint: string, ok: boolean, code: string | null): void {
    this.db.prepare("DELETE FROM model_checks WHERE role=?").run(role);
    this.db.prepare("INSERT INTO model_checks VALUES (?,?,?,?,?)").run(role, fingerprint, Number(ok), code, new Date().toISOString());
  }
  check(role: string, fingerprint: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT ok,code,checked_at AS checkedAt FROM model_checks WHERE role=? AND fingerprint=?").get(role, fingerprint);
    return row ? { ...row, ok: Boolean(row.ok) } : null;
  }
  diagnose(role: string, code: string, jobId?: number): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO invocation_diagnostics VALUES (?,?,?,?,?)").run(id, jobId ?? null, role, code, new Date().toISOString());
    return id;
  }
  diagnostics(): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM invocation_diagnostics ORDER BY created_at DESC LIMIT 100").all();
  }
  createMedia(params: { accountId: string; contactId: string; sessionId: string; sourceMessageId: string; model: string }): GeneratedMedia {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare(`INSERT INTO generated_media(id,account_id,contact_id,session_id,source_message_id,model,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'queued',?,?)`).run(id, params.accountId, params.contactId, params.sessionId, params.sourceMessageId, params.model, now, now);
    return this.media(id)!;
  }
  media(id: string): GeneratedMedia | undefined {
    return this.db.prepare("SELECT * FROM generated_media WHERE id=?").get(id) as unknown as GeneratedMedia | undefined;
  }
  mediaForMessage(accountId: string, sourceMessageId: string): GeneratedMedia | undefined {
    return this.db.prepare("SELECT * FROM generated_media WHERE account_id=? AND source_message_id=?").get(accountId, sourceMessageId) as unknown as GeneratedMedia | undefined;
  }
  listMedia(): Record<string, unknown>[] {
    return this.db.prepare(`SELECT id,account_id,contact_id,model,status,delivery_status,mime_type,size_bytes,error_code,created_at,updated_at,
      local_path IS NOT NULL AS has_result FROM generated_media ORDER BY created_at DESC LIMIT 100`).all();
  }
  updateMedia(id: string, status: string, options: { delivery?: string; localPath?: string; mimeType?: string; sizeBytes?: number; errorCode?: string } = {}): void {
    this.db.prepare(`UPDATE generated_media SET status=?,delivery_status=COALESCE(?,delivery_status),local_path=COALESCE(?,local_path),
      mime_type=COALESCE(?,mime_type),size_bytes=COALESCE(?,size_bytes),error_code=?,updated_at=? WHERE id=?`)
      .run(status, options.delivery ?? null, options.localPath ?? null, options.mimeType ?? null, options.sizeBytes ?? null,
        options.errorCode ?? null, new Date().toISOString(), id);
  }
  recoverMedia(): void {
    this.db.prepare("UPDATE generated_media SET status='needs_review',error_code='interrupted_generation',updated_at=? WHERE status IN ('queued','generating')")
      .run(new Date().toISOString());
    this.db.prepare("UPDATE generated_media SET delivery_status='uncertain',updated_at=? WHERE delivery_status='sending'").run(new Date().toISOString());
  }
}
