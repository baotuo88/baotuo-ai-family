import { applyModelSettings, ModelSettingsStore, SettingsBusyError, type ModelSettings } from "../../settings/model-settings.js";
import { errorToRedactedMessage } from "../../policy/redact-sensitive.js";
import { RuntimeStatus } from "../../operations/runtime-status.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AppConfig,
  CodexProviderRoute,
  CodexRuntimeConfig,
  isCodexModelReasoningEffortSupported,
  isCodexReasoningEffort,
  UserRole,
} from "../../config/index.js";
import {
  parseBuiltInCommand,
  parseNaturalFileRequest,
  buildCommandReply,
} from "../../commands/index.js";
import type { ParsedCommand } from "../../commands/index.js";
import {
  CodexBackend,
  CodexProgressEvent,
  CodexResponseMode,
  buildApiSystemPrompt,
  buildCodexPromptSet,
  createCodexBackend,
} from "../../codex/index.js";
import {
  filterFamilyOutput,
  stripCodexRuntimeNoise,
} from "../../policy/index.js";
import { resolveRole } from "../../router/index.js";
import {
  createNextSession,
  ensureSessionWorkspaceDirs,
  ensureActiveSession,
  parseSessionMemory,
  PendingInboundAttachment,
  stringifySessionMemory,
  estimateTextTokens,
  shouldRotateByThresholds,
  buildDayChangeUserNotice,
  summarizeCarryoverContext,
  buildDeterministicSessionSummary,
} from "../../sessions/index.js";
import {
  AppDatabase,
  SessionRecord,
  WechatAccountRecord,
} from "../../storage/index.js";
import { sendTextMessage } from "./media.js";
import { ILinkApiClient } from "./api-client.js";
import {
  buildAttachmentPromptBlock,
  buildInboundAttachmentAckPlaceholders,
  buildMediaAckReply,
  downloadInboundAttachments,
} from "./attachments.js";
import {
  normalizeInboundWechatMessages,
} from "./inbound.js";
import { InboundTaskQueue } from "./inbound-task-queue.js";
import {
  splitReplyTextBySystemNotice,
  buildCodexErrorReply,
  buildCommandErrorReply,
  buildThinkingNoticeText,
} from "./reply.js";
import {
  FINAL_REPLY_MESSAGE_SLOTS,
  ProgressReplySender,
  StreamingReplySender,
  buildThinkingNoticeScheduleMs,
  compactFinalReplyChunks,
  createFamilyApiStreamingSender,
  createProgressReplySender,
  createTurnMessageBudget,
  shouldSendProgressByTimeline,
} from "./reply-senders.js";
import { withTypingIndicator } from "./typing.js";
import { handleAssistantFileActions, handleFileCommand } from "./file-command.js";
import { sleep } from "../../utils/index.js";
import { decideFamilyBackend } from "./routing.js";
import { buildApiInputParts } from "./api-input.js";
import {
  appendFamilyApiContext,
  buildAcpTaskNote,
  buildFamilyConversationContext,
} from "./conversation-context.js";

function buildMessageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

interface ActiveTurn {
  controller: AbortController;
  conversationId: string;
  backend?: CodexBackend | undefined;
  startedAt: string;
}

function isStopCommand(command: ParsedCommand | undefined): boolean {
  return command?.name === "/stop" || command?.name === "/cancel";
}

function resolveOutputProgressEnabled(params: {
  config: AppConfig;
  role: UserRole;
  sessionMemory: ReturnType<typeof parseSessionMemory>;
}): boolean {
  return (
    params.sessionMemory.outputProgressEnabled ??
    (params.role === "admin"
      ? params.config.wechat.adminProgressEnabled
      : params.config.wechat.familyProgressEnabled)
  );
}

function resolveFamilyApiStreamingEnabled(params: {
  config: AppConfig;
  sessionMemory: ReturnType<typeof parseSessionMemory>;
}): boolean {
  return (
    params.sessionMemory.familyApiStreamingEnabled ??
    params.config.wechat.familyApiStreamingEnabled
  );
}

function buildFamilyAcpHandoff(params: {
  session: SessionRecord;
  database: AppDatabase;
  userText: string;
  attachments: PendingInboundAttachment[];
}): string {
  const conversationContext = buildFamilyConversationContext({
    database: params.database,
    session: params.session,
    currentUserText: params.userText,
  });
  const attachmentSummary = buildAttachmentPromptBlock(params.attachments);
  return [
    conversationContext,
    attachmentSummary ? `Files for this task:\n${attachmentSummary}` : "",
    `Current request:\n${params.userText.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function buildCodexReply(params: {
  backend: CodexBackend;
  backendKind: CodexRuntimeConfig["backend"];
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  userText: string;
  attachments: PendingInboundAttachment[];
  persistentContext: boolean;
  includeRecentTurns?: boolean;
  responseMode?: CodexResponseMode;
  onProgress?: (event: CodexProgressEvent) => void;
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal | undefined;
}): Promise<string> {
  const promptSet = buildCodexPromptSet({
    config: params.config,
    database: params.database,
    role: params.role,
    session: params.session,
    userText: params.userText,
    persistentContext: params.persistentContext,
    ...(params.includeRecentTurns !== undefined
      ? { includeRecentTurns: params.includeRecentTurns }
      : {}),
  });
  const result = await params.backend.run({
    conversationId: params.session.id,
    prompt: params.backendKind === "api" ? params.userText : promptSet.prompt,
    ...(promptSet.systemPrompt ? { systemPrompt: promptSet.systemPrompt } : {}),
    ...(params.backendKind === "api"
      ? {
          systemPrompt:
            buildApiSystemPrompt({
              config: params.config,
              role: params.role,
            }),
          inputParts: buildApiInputParts({
            session: params.session,
            userText: params.userText,
            attachments: params.attachments,
          }),
          promptCacheKey: `wechat:${params.role}:${params.session.wechatAccountId}:${params.session.contactId}`,
        }
      : {}),
    ...(promptSet.bootstrapPrompt
      ? { bootstrapPrompt: promptSet.bootstrapPrompt }
      : {}),
    persistentSession: params.persistentContext,
    role: params.role,
    additionalDirectories: promptSet.additionalDirectories,
    readOnlyDirectories: promptSet.readOnlyDirectories,
    ...(params.responseMode ? { responseMode: params.responseMode } : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (result.cancelled) {
    if (result.text.trim()) {
      return [
        result.text.trim(),
        "这轮任务已停止。上面是停止前已经生成的内容，可能不是完整最终结果。",
      ].join("\n");
    }

    return "这轮任务已停止。";
  }

  if (result.timedOut) {
    if (result.text.trim()) {
      return [
        result.text.trim(),
        "这轮处理已经超过等待时间，我已停止继续等待。上面是已生成内容，可能不是完整最终结果。",
      ].join("\n");
    }

    throw new Error("Codex timed out");
  }

  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.text, `exit code ${result.exitCode}`]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`Codex failed: ${detail}`);
  }

  if (!result.text.trim()) {
    throw new Error(result.stderr || "Codex returned an empty response");
  }

  return result.text;
}

export interface WechatWorkerOptions {
  settings?: ModelSettingsStore;
  config: AppConfig;
  database: AppDatabase;
}

export class WechatWorker {
  private running = false;

  private readonly scheduledJobs = new Set<number>();

  private readonly scheduledControls = new Set<number>();

  private lifecycleController = new AbortController();

  private stopPromise: Promise<void> | undefined;

  private readonly runtimeStatus = new RuntimeStatus();

  getRuntimeStatus() {
    return this.runtimeStatus.snapshot(this.running, this.options.database.listAccounts()
      .filter(account => account.status === "active").map(account => account.id), this.scheduledJobs.size);
  }

  private readonly accountPollers = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  private loopPromise: Promise<void> | undefined;

  private readonly activeTurns = new Map<string, ActiveTurn>();

  private readonly inboundTasks = new Set<Promise<void>>();

  private readonly inboundTaskQueue = new InboundTaskQueue();

  private codexBackends: Record<"admin" | "family-acp" | "family-api", CodexBackend>;

  constructor(private readonly options: WechatWorkerOptions) {
    this.codexBackends = {
      admin: createCodexBackend(
        this.buildRuntimeCodexConfig("admin", { providerRoute: "admin-acp" }),
      ),
      "family-acp": createCodexBackend(
        this.buildRuntimeCodexConfig("family", {
          backendOverride: "acp",
          providerRoute: "family-acp",
        }),
      ),
      "family-api": createCodexBackend(
        this.buildRuntimeCodexConfig("family", {
          backendOverride: "api",
          providerRoute: "family-api",
        }),
      ),
    };
  }

  private buildRuntimeCodexConfig(
    role: UserRole,
    options?: {
      backendOverride?: CodexRuntimeConfig["backend"];
      providerRoute?: CodexProviderRoute;
    },
  ): CodexRuntimeConfig {
    const baseConfig = this.options.config.codex[role];
    const managed = this.options.settings?.get(role);
    if (managed) {
      const effective = applyModelSettings(baseConfig, managed);
      if (options?.backendOverride) effective.backend = options.backendOverride;
      return effective;
    }
    const config: CodexRuntimeConfig = {
      ...baseConfig,
      args: [...baseConfig.args],
      acpArgs: [...baseConfig.acpArgs],
      envPassthrough: [...baseConfig.envPassthrough],
      envOverrides: { ...baseConfig.envOverrides },
      ...(baseConfig.roleOverrides
        ? { roleOverrides: { ...baseConfig.roleOverrides } }
        : {}),
      ...(options?.backendOverride
        ? { backend: options.backendOverride }
        : {}),
    };
    const providerRoute = options?.providerRoute;
    const providerName = providerRoute
      ? this.options.database.getCodexProviderRouteSettings(providerRoute)
          ?.providerName
      : undefined;
    const provider = providerName
      ? this.options.config.codex.providers.find(
          (profile) =>
            profile.name.toLowerCase() === providerName.toLowerCase(),
        )
      : undefined;
    if (providerName && !provider) {
      console.warn(
        `[codex] provider '${providerName}' for ${providerRoute} is not configured; using default config`,
      );
    }

    const providerRoleOverrides: NonNullable<
      CodexRuntimeConfig["roleOverrides"]
    > = {};
    if (provider) {
      if (provider.backend && !options?.backendOverride) {
        config.backend = provider.backend;
      }
      if (provider.apiBaseUrl) {
        config.apiBaseUrl = provider.apiBaseUrl;
        config.apiKey = provider.apiKey;
      } else if (provider.apiKey) {
        config.apiKey = provider.apiKey;
      }
      const providerModel = provider.apiModel ?? provider.model;
      if (providerModel && config.backend === "api") {
        config.apiModel = providerModel;
      }
      const agentModel = provider.model ?? provider.apiModel;
      if (agentModel) {
        providerRoleOverrides.model = agentModel;
      }
      if (provider.reasoningEffort) {
        providerRoleOverrides.reasoningEffort = provider.reasoningEffort;
      }
      if (provider.codexHome) {
        config.codexHome = provider.codexHome;
      }
      if (provider.acpArgs.length > 0) {
        config.acpArgs = [...config.acpArgs, ...provider.acpArgs];
        config.args = [...config.args, ...provider.acpArgs];
      }
      config.envOverrides = {
        ...config.envOverrides,
        ...provider.envOverrides,
      };
    }

    const settings = this.options.database.getCodexRoleSettings(role);
    const roleOverrides: NonNullable<CodexRuntimeConfig["roleOverrides"]> = {
      ...(config.roleOverrides ?? {}),
      ...providerRoleOverrides,
    };
    if (settings?.model) {
      roleOverrides.model = settings.model;
      if (config.backend === "api") {
        config.apiModel = settings.model;
      }
    }
    if (
      settings?.reasoningEffort &&
      isCodexReasoningEffort(settings.reasoningEffort)
    ) {
      roleOverrides.reasoningEffort = settings.reasoningEffort;
    }
    if (roleOverrides.model || roleOverrides.reasoningEffort) {
      config.roleOverrides = roleOverrides;
    } else {
      delete config.roleOverrides;
    }

    if (roleOverrides.reasoningEffort && !this.options.settings?.get(role)) {
      const effectiveModels = new Set(
        [
          roleOverrides.model,
          config.backend === "api" ? config.apiModel : undefined,
        ].filter((model): model is string => Boolean(model)),
      );
      for (const model of effectiveModels) {
        if (
          !isCodexModelReasoningEffortSupported(
            model,
            roleOverrides.reasoningEffort,
          )
        ) {
          throw new Error(
            `Invalid Codex route ${providerRoute ?? role}: model ${model} does not support reasoning ${roleOverrides.reasoningEffort}`,
          );
        }
      }
    }

    return { ...config };
  }

  saveModelSettings(role: UserRole, settings: ModelSettings): void {
    if (this.scheduledJobs.size || this.activeTurns.size || this.inboundTasks.size) {
      throw new SettingsBusyError("有任务正在执行，请等待完成后保存；不会中断当前任务");
    }
    if (!this.options.settings) throw new Error("Settings unavailable");
    const replacements: Partial<typeof this.codexBackends> = {};
    try {
      const runtime = applyModelSettings(this.options.config.codex[role], settings);
      if (role === "admin") replacements.admin = createCodexBackend(runtime);
      else {
        replacements["family-api"] = createCodexBackend({ ...runtime, backend: "api" });
        replacements["family-acp"] = createCodexBackend({ ...runtime, backend: "acp" });
      }
      this.options.settings.save(role, settings);
    } catch (error) {
      for (const backend of Object.values(replacements)) backend?.dispose();
      throw error;
    }
    for (const key of Object.keys(replacements) as Array<keyof typeof this.codexBackends>) {
      const previous = this.codexBackends[key];
      this.codexBackends[key] = replacements[key]!;
      previous.dispose();
    }
  }

  private rebuildCodexBackend(role: UserRole): void {
    if (role === "admin") {
      this.codexBackends.admin.dispose();
      this.codexBackends.admin = createCodexBackend(
        this.buildRuntimeCodexConfig("admin", { providerRoute: "admin-acp" }),
      );
      return;
    }

    this.codexBackends["family-acp"].dispose();
    this.codexBackends["family-api"].dispose();
    this.codexBackends["family-acp"] = createCodexBackend(
      this.buildRuntimeCodexConfig("family", {
        backendOverride: "acp",
        providerRoute: "family-acp",
      }),
    );
    this.codexBackends["family-api"] = createCodexBackend(
      this.buildRuntimeCodexConfig("family", {
        backendOverride: "api",
        providerRoute: "family-api",
      }),
    );
  }

  private rebuildProviderRoutes(routes: CodexProviderRoute[]): void {
    const routeSet = new Set(routes);
    if (routeSet.has("admin-acp")) {
      this.codexBackends.admin.dispose();
      this.clearAcpSessionMap(
        this.buildRuntimeCodexConfig("admin", { providerRoute: "admin-acp" }),
      );
      this.codexBackends.admin = createCodexBackend(
        this.buildRuntimeCodexConfig("admin", { providerRoute: "admin-acp" }),
      );
    }
    if (routeSet.has("family-acp")) {
      this.codexBackends["family-acp"].dispose();
      this.clearAcpSessionMap(
        this.buildRuntimeCodexConfig("family", {
          backendOverride: "acp",
          providerRoute: "family-acp",
        }),
      );
      this.codexBackends["family-acp"] = createCodexBackend(
        this.buildRuntimeCodexConfig("family", {
          backendOverride: "acp",
          providerRoute: "family-acp",
        }),
      );
    }
    if (routeSet.has("family-api")) {
      this.codexBackends["family-api"].dispose();
      this.codexBackends["family-api"] = createCodexBackend(
        this.buildRuntimeCodexConfig("family", {
          backendOverride: "api",
          providerRoute: "family-api",
        }),
      );
    }
  }

  private clearAcpSessionMap(config: CodexRuntimeConfig): void {
    if (config.backend !== "acp") {
      return;
    }

    const sessionMapPath = path.join(config.workspace, ".acp-session-map.json");
    try {
      fs.rmSync(sessionMapPath, { force: true });
    } catch (error) {
      console.warn("[codex] failed to clear ACP session map", error);
    }
  }

  start(): void {
    if (this.running) {
      return;
    }
    if (this.stopPromise) throw new Error("Stopped worker cannot be restarted; create a new worker");

    this.lifecycleController = new AbortController();
    this.options.database.recoverInterruptedJobs();
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopWorker();
    return this.stopPromise;
  }

  private async stopWorker(): Promise<void> {
    this.running = false;
    this.lifecycleController.abort();
    for (const poller of this.accountPollers.values()) poller.controller.abort();
    // Cancel every active task before awaiting pollers or other cancellations.
    const cancellations = [...this.activeTurns.values()].map(async turn => {
      turn.controller.abort();
      await turn.backend?.cancel(turn.conversationId);
    });
    try {
      await Promise.allSettled([
        ...cancellations,
        ...[...this.accountPollers.values()].map(poller => poller.promise),
        ...(this.loopPromise ? [this.loopPromise] : []),
      ]);
      await Promise.allSettled([...this.inboundTasks]);
    } finally {
      for (const backend of Object.values(this.codexBackends)) backend.dispose();
    }
  }

  private getActiveTurnKey(params: {
    wechatAccountId: string;
    contactId: string;
  }): string {
    return `${params.wechatAccountId}\0${params.contactId}`;
  }

  private dispatchInboundMessage(
    account: WechatAccountRecord,
    client: ILinkApiClient,
    inbound: ReturnType<typeof normalizeInboundWechatMessages>[number],
    jobId: number,
  ): void {
    const run = async (): Promise<void> => {
      // Leave unstarted jobs durable on shutdown or account suspension.
      const current = this.options.database.getAccountById(account.id);
      if (!this.running || current?.status !== "active") return;
      if (!this.options.database.claimInboundJob(jobId)) return;
      const started = Date.now();
      console.log(JSON.stringify({ event: "job_started", jobId, accountId: account.id }));
      try {
        await this.handleInboundMessage(current, client, inbound, jobId);
        this.options.database.finishInboundJob(jobId, "succeeded");
        console.log(JSON.stringify({ event: "job_succeeded", jobId, durationMs: Date.now() - started }));
      } catch (error) {
        this.options.database.finishInboundJob(jobId, "needs_review");
        console.error(JSON.stringify({ event: "job_needs_review", jobId, durationMs: Date.now() - started, errorCode: "processing_failed" }));
      }
    };
    const command = parseBuiltInCommand(inbound.text);
    const task = isStopCommand(command)
      ? run()
      : this.inboundTaskQueue.enqueue(
          this.getActiveTurnKey({
            wechatAccountId: inbound.wechatAccountId,
            contactId: inbound.contactId,
          }),
          run,
        );
    this.inboundTasks.add(task);
    task.finally(() => {
      this.inboundTasks.delete(task);
      this.scheduledJobs.delete(jobId);
      this.scheduledControls.delete(jobId);
      // Refill slots immediately; do not wait for the next long-poll response.
      if (this.running) this.scheduleQueuedJobs();
    }).catch(() => undefined);
  }

  private getBackendForTurn(params: {
    role: UserRole;
    userText: string;
    attachments: PendingInboundAttachment[];
  }): {
    backend: CodexBackend;
    backendKind: CodexRuntimeConfig["backend"];
    persistentSession: boolean;
  } {
    if (params.role === "admin") {
      const adminConfig = this.buildRuntimeCodexConfig("admin", {
        providerRoute: "admin-acp",
      });
      if (this.options.settings && !adminConfig.apiKey &&
          !fs.existsSync(path.join(adminConfig.codexHome ?? "", "auth.json"))) {
        throw new Error("请先在管理后台配置模型服务");
      }
      return {
        backend: this.codexBackends.admin,
        backendKind: adminConfig.backend,
        persistentSession: adminConfig.backend === "acp",
      };
    }

    const decision = decideFamilyBackend({
      userText: params.userText,
      attachments: params.attachments,
    });

    const familyApiConfig = this.buildRuntimeCodexConfig("family", {
      backendOverride: "api",
      providerRoute: "family-api",
    });
    const canUseFamilyApi = Boolean(
      familyApiConfig.apiBaseUrl && familyApiConfig.apiKey,
    );

    const managedFamily = this.options.settings?.get("family");
    if (managedFamily?.backend === "api" && decision.backend === "acp") {
      throw new Error("家庭账号当前为纯 API 模式；复杂文件和工具任务需在后台启用 ACP");
    }
    if (!canUseFamilyApi && this.options.settings && !managedFamily &&
        !fs.existsSync(path.join(familyApiConfig.codexHome ?? "", "auth.json"))) {
      throw new Error("请先在管理后台配置模型服务");
    }
    if (decision.backend === "acp" || !canUseFamilyApi) {
      return {
        backend: this.codexBackends["family-acp"],
        backendKind: "acp",
        persistentSession: false,
      };
    }

    return {
      backend: this.codexBackends["family-api"],
      backendKind: "api",
      persistentSession: false,
    };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        this.scheduleQueuedJobs();
        const active = new Set(this.options.database.listAccounts()
          .filter(account => account.status === "active").map(account => account.id));
        for (const [id, poller] of this.accountPollers) {
          if (!active.has(id)) poller.controller.abort();
        }
        for (const id of active) {
          if (this.accountPollers.has(id)) continue;
          const controller = new AbortController();
          const promise = this.pollAccountLoop(id, controller.signal);
          this.accountPollers.set(id, { controller, promise });
          void promise.finally(() => this.accountPollers.delete(id)).catch(error => {
            console.error(`[worker] account poller stopped: ${id}`, error);
          });
        }
      } catch (error) {
        console.error("[worker] failed to reconcile accounts", error);
      }
      await sleep(1_000, this.lifecycleController.signal);
    }
  }

  private async pollAccountLoop(accountId: string, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (this.running && !signal.aborted) {
      const account = this.options.database.getAccountById(accountId);
      if (account?.status !== "active") return;
      try {
        await this.pollAccount(account, signal);
        failures = 0;
        this.runtimeStatus.recordPoll(accountId, true);
        // Protect against an upstream that returns empty batches immediately.
        await sleep(100, signal);
      } catch (error) {
        if (signal.aborted || !this.running) return;
        failures++;
        this.runtimeStatus.recordPoll(accountId, false);
        console.error(JSON.stringify({ event: "poll_failed", accountId, consecutiveFailures: failures }));
        await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)), signal);
      }
    }
  }

  private async pollAccount(account: WechatAccountRecord, signal?: AbortSignal): Promise<void> {
    const client = new ILinkApiClient({
      baseUrl: account.baseUrl ?? this.options.config.wechat.apiBaseUrl,
      cdnBaseUrl: this.options.config.wechat.cdnBaseUrl,
      channelVersion: this.options.config.wechat.channelVersion,
      ...(this.options.config.wechat.routeTag
        ? { routeTag: this.options.config.wechat.routeTag }
        : {}),
      token: account.authToken,
    });

    const cursor = this.options.database.getPollingCursor(account.id) ?? "";
    const response = await client.getUpdates(cursor, 35_000, signal);
    if ((response.ret !== undefined && response.ret !== 0) ||
        (response.errcode !== undefined && response.errcode !== 0)) {
      throw new Error(`iLink polling rejected: ret=${response.ret}, errcode=${response.errcode}`);
    }

    const inboundMessages = normalizeInboundWechatMessages({
      wechatAccountId: account.id,
      messages: response.msgs ?? [],
    });
    this.options.database.receiveInboundBatch(account.id, response.get_updates_buf, inboundMessages);
    this.scheduleQueuedJobs();
  }

  private scheduleQueuedJobs(): void {
    if (!this.running) return;
    const normalCount = this.scheduledJobs.size - this.scheduledControls.size;
    const maxTasks = this.options.config.wechat.maxConcurrentTasks;
    const controls = this.options.database.listDispatchableJobs(
      Math.max(0, 4 - this.scheduledControls.size), true, [...this.scheduledJobs],
    );
    const normal = this.options.database.listDispatchableJobs(
      Math.max(0, maxTasks - normalCount), false, [...this.scheduledJobs],
    );
    for (const job of [...controls, ...normal]) {
      const account = this.options.database.getAccountById(job.message.wechatAccountId);
      if (account?.status !== "active") continue;
      const client = new ILinkApiClient({
        baseUrl: account.baseUrl ?? this.options.config.wechat.apiBaseUrl,
        cdnBaseUrl: this.options.config.wechat.cdnBaseUrl,
        channelVersion: this.options.config.wechat.channelVersion,
        ...(this.options.config.wechat.routeTag ? { routeTag: this.options.config.wechat.routeTag } : {}),
        token: account.authToken,
      });
      this.scheduledJobs.add(job.id);
      if (isStopCommand(parseBuiltInCommand(job.message.text))) this.scheduledControls.add(job.id);
      this.dispatchInboundMessage(account, client, job.message, job.id);
    }
  }

  private async handleInboundMessage(
    account: WechatAccountRecord,
    client: ILinkApiClient,
    inbound: ReturnType<typeof normalizeInboundWechatMessages>[number],
    jobId?: number,
  ): Promise<void> {
    const phase = (value: "processing" | "executing" | "delivering"): void => {
      if (jobId !== undefined) this.options.database.setInboundJobPhase(jobId, value);
    };
    const deliveryAccepted = (): void => {
      if (jobId !== undefined) this.options.database.setInboundJobDeliveryStatus(jobId, "accepted");
    };
    const deliveryUncertain = (): void => {
      if (jobId !== undefined) this.options.database.setInboundJobDeliveryStatus(jobId, "uncertain");
    };
    const deliveryStart = (): void => {
      if (jobId !== undefined) this.options.database.setInboundJobPhase(jobId, "delivering");
    };
    let executionFailed = false;
    const accountRoute = resolveRole({
      configuredRole: account.role,
      adminContactAllowed: this.options.database.isAdminContact(account.id, inbound.contactId),
    });
    let session = ensureActiveSession({
      database: this.options.database,
      wechatAccountId: inbound.wechatAccountId,
      contactId: inbound.contactId,
      role: accountRoute.role,
    });
    if (accountRoute.role !== "admin" &&
        (session.role === "admin" || parseSessionMemory(session.memoryJson).routeMode === "admin")) {
      this.codexBackends.admin.clearSession(session.id);
      session = createNextSession({
        database: this.options.database,
        previousSession: session,
        role: "family",
        contextToken: inbound.contextToken,
      });
    }
    const existingSessionMemory = parseSessionMemory(session.memoryJson);
    if (accountRoute.role !== "admin" && existingSessionMemory.routeMode === "admin") {
      existingSessionMemory.routeMode = "family";
      this.codexBackends.admin.clearSession(session.id);
    }
    const route: { role: UserRole } =
      existingSessionMemory.routeMode === "admin" ||
      existingSessionMemory.routeMode === "family"
        ? { role: existingSessionMemory.routeMode }
        : { role: accountRoute.role };
    const recentMessagesForCarryover = this.options.database
      .listSessionMessages(session.id, 12)
      .reverse();
    const archivedSummary =
      buildDeterministicSessionSummary({
        session,
        recentMessages: recentMessagesForCarryover,
      }) || session.summaryText;
    const carryoverSummary = summarizeCarryoverContext({
      session,
      recentMessages: recentMessagesForCarryover,
    });
    const rotateDecision = shouldRotateByThresholds({
      session,
      memory: existingSessionMemory,
      config: this.options.config,
      role: route.role,
    });
    const sessionForTurn = rotateDecision.shouldRotate
        ? createNextSession({
          database: this.options.database,
          previousSession: session,
          role: route.role,
          summaryText: archivedSummary,
          memoryJson: stringifySessionMemory({
            ...(existingSessionMemory.routeMode
              ? { routeMode: existingSessionMemory.routeMode }
              : {}),
            ...(carryoverSummary
              ? {
                  carryoverSummary,
                  carryoverSourceSessionId: session.id,
                  carryoverSourceLastActiveAt: session.lastActiveAt,
                }
              : {}),
          }),
          contextToken: inbound.contextToken,
          lastActiveAt: inbound.receivedAt,
        })
      : session;
    const dayChangeNotice =
      rotateDecision.shouldRotate &&
      rotateDecision.reason === "crossed into a new Beijing calendar day"
        ? buildDayChangeUserNotice({
            session,
            role: route.role,
            now: new Date(),
          })
        : undefined;

    const activeSession = this.options.database.saveSession({
      id: sessionForTurn.id,
      wechatAccountId: sessionForTurn.wechatAccountId,
      contactId: sessionForTurn.contactId,
      role: route.role,
      status: sessionForTurn.status,
      summaryText: sessionForTurn.summaryText,
      memoryJson: sessionForTurn.id === session.id
        ? stringifySessionMemory(existingSessionMemory) : sessionForTurn.memoryJson,
      contextToken: inbound.contextToken,
      lastActiveAt: inbound.receivedAt,
    });
    ensureSessionWorkspaceDirs({
      config: this.options.config,
      sessionId: activeSession.id,
    });
    const sessionMemory = parseSessionMemory(activeSession.memoryJson);
    const parsedControlCommand = parseBuiltInCommand(inbound.text);
    const activeTurnKey = this.getActiveTurnKey({
      wechatAccountId: inbound.wechatAccountId,
      contactId: inbound.contactId,
    });
    const existingActiveTurn = this.activeTurns.get(activeTurnKey);
    if (isStopCommand(parsedControlCommand)) {
      this.options.database.appendMessage({
        id: buildMessageId("inbound"),
        sessionId: activeSession.id,
        direction: "inbound",
        messageType: "text",
        textContent: inbound.text,
        createdAt: inbound.receivedAt,
        sourceMessageId: inbound.sourceMessageId,
      });

      const reply = existingActiveTurn
        ? "已收到停止请求，正在停止当前任务。"
        : "当前没有正在处理的任务。";
      if (existingActiveTurn) {
        existingActiveTurn.controller.abort();
        await existingActiveTurn.backend?.cancel(existingActiveTurn.conversationId);
      }
      deliveryStart();
      const clientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: reply,
      });
      deliveryAccepted();
      this.options.database.appendMessage({
        id: buildMessageId("outbound"),
        sessionId: activeSession.id,
        direction: "outbound",
        messageType: "text",
        textContent: reply,
        createdAt: new Date().toISOString(),
        sourceMessageId: clientId || inbound.sourceMessageId,
      });
      return;
    }

    phase("executing");
    const parsedCommand =
      parsedControlCommand ??
      parseNaturalFileRequest(inbound.text);
    const turnController =
      !parsedCommand && (inbound.text.trim() || inbound.attachments.length > 0)
        ? new AbortController()
        : undefined;
    if (turnController) {
      this.activeTurns.set(activeTurnKey, {
        controller: turnController,
        conversationId: activeSession.id,
        startedAt: new Date().toISOString(),
      });
    }

    if (inbound.attachments.length > 0 && !inbound.text.trim()) {
      const ack = buildMediaAckReply({
        role: route.role,
        attachments: buildInboundAttachmentAckPlaceholders(inbound.attachments),
      });
      deliveryStart();
      const clientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: ack,
      });
      deliveryAccepted();
      this.options.database.appendMessage({
        id: buildMessageId("outbound"),
        sessionId: activeSession.id,
        direction: "outbound",
        messageType: "text",
        textContent: ack,
        createdAt: new Date().toISOString(),
        sourceMessageId: clientId || inbound.sourceMessageId,
      });
    }
    let downloadedAttachments: PendingInboundAttachment[];
    try {
      downloadedAttachments =
        inbound.attachments.length > 0
          ? await downloadInboundAttachments({
              attachments: inbound.attachments,
              config: this.options.config,
              client,
              database: this.options.database,
              session: activeSession,
              sourceMessageId: inbound.sourceMessageId,
              receivedAt: inbound.receivedAt,
          })
          : [];
    } catch (error) {
      const activeTurn = this.activeTurns.get(activeTurnKey);
      if (activeTurn?.controller === turnController) {
        this.activeTurns.delete(activeTurnKey);
      }
      throw error;
    }

    this.options.database.appendMessage({
      id: buildMessageId("inbound"),
      sessionId: activeSession.id,
      direction: "inbound",
      messageType: downloadedAttachments.length > 0 ? "mixed" : "text",
      textContent: [inbound.mediaSummary, inbound.text].filter(Boolean).join("\n"),
      createdAt: inbound.receivedAt,
      sourceMessageId: inbound.sourceMessageId,
    });

    if (downloadedAttachments.length > 0 && !inbound.text.trim()) {
      const nextMemory = stringifySessionMemory({
        ...sessionMemory,
        turnCount: (sessionMemory.turnCount ?? 0) + 1,
        estimatedTokenCount:
          (sessionMemory.estimatedTokenCount ?? 0) +
          estimateTextTokens([inbound.mediaSummary, inbound.text].filter(Boolean).join("\n")),
        pendingInboundAttachments: [
          ...(sessionMemory.pendingInboundAttachments ?? []),
          ...downloadedAttachments,
        ].slice(-10),
      });
      const nextSession = this.options.database.saveSession({
        id: activeSession.id,
        wechatAccountId: activeSession.wechatAccountId,
        contactId: activeSession.contactId,
        role: route.role,
        status: activeSession.status,
        summaryText: activeSession.summaryText,
        memoryJson: nextMemory,
        contextToken: activeSession.contextToken,
        lastActiveAt: activeSession.lastActiveAt,
      });
      if (downloadedAttachments.some((attachment) => attachment.downloadStatus === "failed")) {
        const failureAck = buildMediaAckReply({
          role: route.role,
          attachments: downloadedAttachments,
        });
        deliveryStart();
        const clientId = await sendTextMessage({
          client,
          toUserId: inbound.contactId,
          contextToken: inbound.contextToken,
          text: failureAck,
        });
        deliveryAccepted();
        this.options.database.appendMessage({
          id: buildMessageId("outbound"),
          sessionId: nextSession.id,
          direction: "outbound",
          messageType: "text",
          textContent: failureAck,
          createdAt: new Date().toISOString(),
          sourceMessageId: clientId || inbound.sourceMessageId,
        });
      }
      const activeTurn = this.activeTurns.get(activeTurnKey);
      if (activeTurn?.controller === turnController) {
        this.activeTurns.delete(activeTurnKey);
      }
      return;
    }

    const pendingAttachments = parsedCommand
      ? downloadedAttachments
      : [
          ...(sessionMemory.pendingInboundAttachments ?? []),
          ...downloadedAttachments,
        ];
    const userTextForCodex =
      pendingAttachments.length > 0
        ? `${buildAttachmentPromptBlock(pendingAttachments)}\n\n用户这次的文字要求：\n${inbound.text}`
        : inbound.text;
    const sessionForReply =
      pendingAttachments.length > 0 && !parsedCommand
        ? this.options.database.saveSession({
            id: activeSession.id,
            wechatAccountId: activeSession.wechatAccountId,
            contactId: activeSession.contactId,
            role: route.role,
            status: activeSession.status,
            summaryText: activeSession.summaryText,
            memoryJson: stringifySessionMemory({
              ...sessionMemory,
              pendingInboundAttachments: [],
            }),
            contextToken: activeSession.contextToken,
            lastActiveAt: activeSession.lastActiveAt,
          })
        : activeSession;

    let rawReply: string;
    let progressReplySender: ProgressReplySender | undefined;
    let streamingReplySender: StreamingReplySender | undefined;
    let backendForCompletedTurn:
      | {
          backendKind: CodexRuntimeConfig["backend"];
          persistentSession: boolean;
        }
      | undefined;
    let familyBackendReason: ReturnType<typeof decideFamilyBackend>["reason"] | undefined;
    let codexTurnSucceeded = false;

    if (parsedCommand) {
      const activeTurn = this.activeTurns.get(activeTurnKey);
      if (activeTurn?.controller === turnController) {
        this.activeTurns.delete(activeTurnKey);
      }
      try {
        if (
          parsedCommand.name === "/new" ||
          parsedCommand.name === "/reset" ||
          parsedCommand.name === "/clear"
        ) {
          if (route.role === "admin") {
            this.codexBackends.admin.clearSession(activeSession.id);
          } else {
            this.codexBackends["family-acp"].clearSession(activeSession.id);
            this.codexBackends["family-api"].clearSession(activeSession.id);
          }
        }

        rawReply =
          parsedCommand.name === "/file" || parsedCommand.name === "/sendfile"
            ? await handleFileCommand({
                command: parsedCommand,
                config: this.options.config,
                client,
                database: this.options.database,
                session: sessionForReply,
                role: route.role,
                onDeliveryStart: deliveryStart,
                onDeliveryAccepted: deliveryAccepted,
                onDeliveryUncertain: deliveryUncertain,
              })
            : buildCommandReply({
                command: parsedCommand,
                session: sessionForReply,
                database: this.options.database,
                role: route.role,
                accountRole: accountRoute.role,
                sessionMemory: sessionMemory,
                account,
                config: this.options.config,
                onRoleModeChanged: () => {
                  this.codexBackends.admin.clearSession(activeSession.id);
                  this.codexBackends["family-acp"].clearSession(activeSession.id);
                  this.codexBackends["family-api"].clearSession(activeSession.id);
                },
                onCodexSettingsChanged: (changedRole) => {
                  this.rebuildCodexBackend(changedRole);
                },
                onProviderSettingsChanged: (changedRoutes) => {
                  this.rebuildProviderRoutes(changedRoutes);
                },
              });
      } catch (error) {
        executionFailed = true;
        console.error("[worker] command failed", errorToRedactedMessage(error));
        rawReply = buildCommandErrorReply({
          error,
          role: route.role,
        });
      }
    } else {
      try {
        const progress: CodexProgressEvent = { phase: "thinking" };
        const backendForTurn = this.getBackendForTurn({
          role: route.role,
          userText: inbound.text,
          attachments: pendingAttachments,
        });
        if (turnController) {
          const activeTurn = this.activeTurns.get(activeTurnKey);
          if (activeTurn?.controller === turnController) {
            activeTurn.conversationId = sessionForReply.id;
            activeTurn.backend = backendForTurn.backend;
          } else {
            this.activeTurns.set(activeTurnKey, {
              controller: turnController,
              conversationId: sessionForReply.id,
              backend: backendForTurn.backend,
              startedAt: new Date().toISOString(),
            });
          }
        }
        backendForCompletedTurn = {
          backendKind: backendForTurn.backendKind,
          persistentSession: backendForTurn.persistentSession,
        };
        familyBackendReason =
          route.role === "family"
            ? decideFamilyBackend({
                userText: inbound.text,
                attachments: pendingAttachments,
              }).reason
            : undefined;
        const outputProgressEnabled = resolveOutputProgressEnabled({
          config: this.options.config,
          role: route.role,
          sessionMemory,
        });
        const familyApiStreamingEnabled = resolveFamilyApiStreamingEnabled({
          config: this.options.config,
          sessionMemory,
        });
        const turnStartedAt = Date.now();
        const turnMessageBudget = createTurnMessageBudget({
          role: route.role,
          turnMessageLimit: this.options.config.wechat.turnMessageLimit,
        });
        progressReplySender =
          outputProgressEnabled && backendForTurn.backendKind === "acp"
            ? createProgressReplySender({
                client,
                toUserId: inbound.contactId,
                contextToken: inbound.contextToken,
                includeToolProgress: route.role === "admin",
                maxProgressMessages: turnMessageBudget.progressMessageBudget,
                minIntervalMs: route.role === "admin" ? 15_000 : 8_000,
                shouldSend: turnMessageBudget.tryReservePreFinalMessage,
                shouldSendAt: ({ queuedCount, now }) =>
                  shouldSendProgressByTimeline({
                    queuedCount,
                    elapsedMs: now - turnStartedAt,
                    timeoutMs: this.options.config.codex[route.role].timeoutMs,
                    maxMessages: turnMessageBudget.progressMessageBudget,
                  }),
                filterText: (text) =>
                  route.role === "family"
                    ? filterFamilyOutput(text, this.options.config.familyPolicy)
                    : stripCodexRuntimeNoise(text),
                onDeliveryStart: deliveryStart,
                onDeliveryAccepted: deliveryAccepted,
                onDeliveryUncertain: deliveryUncertain,
              })
            : undefined;
        streamingReplySender =
          route.role === "family" &&
          backendForTurn.backendKind === "api" &&
          familyApiStreamingEnabled
            ? createFamilyApiStreamingSender({
                client,
                toUserId: inbound.contactId,
                contextToken: inbound.contextToken,
                config: this.options.config,
                maxEarlyMessages: turnMessageBudget.familyApiEarlyMessageBudget,
                shouldSend: turnMessageBudget.tryReservePreFinalMessage,
                onDeliveryStart: deliveryStart,
                onDeliveryAccepted: deliveryAccepted,
                onDeliveryUncertain: deliveryUncertain,
              })
            : undefined;
        const codexUserText =
          route.role === "family" && backendForTurn.backendKind === "acp"
            ? buildFamilyAcpHandoff({
                session: sessionForReply,
                database: this.options.database,
                userText: inbound.text,
                attachments: pendingAttachments,
              })
            : backendForTurn.backendKind === "api"
              ? inbound.text
              : userTextForCodex;
        rawReply = await withTypingIndicator({
          client,
          toUserId: inbound.contactId,
          contextToken: inbound.contextToken,
          typingRefreshMs: this.options.config.wechat.typingRefreshMs,
          thinkingNoticeIntervalMs:
            progressReplySender
              ? 0
              : this.options.config.wechat.thinkingNoticeMs,
          thinkingNoticeScheduleMs:
            !progressReplySender
              ? buildThinkingNoticeScheduleMs({
                  intervalMs: this.options.config.wechat.thinkingNoticeMs,
                  timeoutMs: this.options.config.codex[route.role].timeoutMs,
                  maxMessages: turnMessageBudget.preFinalMessageBudget,
                  streamingEnabled: Boolean(streamingReplySender),
                })
              : undefined,
          shouldSendThinkingNotice: () =>
            !(streamingReplySender?.hasSentText() ?? false) &&
            turnMessageBudget.tryReservePreFinalMessage(),
          buildThinkingNoticeText: (elapsedSeconds) =>
            buildThinkingNoticeText({
              role: route.role,
              elapsedSeconds,
            }),
          onDeliveryStart: deliveryStart,
          onDeliveryAccepted: deliveryAccepted,
          onDeliveryUncertain: deliveryUncertain,
          work: () =>
            buildCodexReply({
              backend: backendForTurn.backend,
              backendKind: backendForTurn.backendKind,
              config: this.options.config,
              database: this.options.database,
              role: route.role,
              session: sessionForReply,
              userText: codexUserText,
              attachments: pendingAttachments,
              persistentContext: backendForTurn.persistentSession,
              includeRecentTurns:
                !(
                  route.role === "family" &&
                  backendForTurn.backendKind === "acp"
                ),
              responseMode:
                backendForTurn.backendKind === "acp"
                  ? "final_message_run"
                  : "full_text",
              onProgress: (event) => {
                progress.phase = event.phase;
                progressReplySender?.handle(event);
              },
              ...(streamingReplySender
                ? {
                    onTextDelta: (delta) => {
                      streamingReplySender?.handleDelta(delta);
                    },
                  }
                : {}),
              ...(turnController ? { signal: turnController.signal } : {}),
            }),
        });
        await progressReplySender?.flush();
        await streamingReplySender?.flush();
        rawReply = await handleAssistantFileActions({
          rawReply,
          config: this.options.config,
          client,
          database: this.options.database,
          session: sessionForReply,
          role: route.role,
          onDeliveryStart: deliveryStart,
          onDeliveryAccepted: deliveryAccepted,
          onDeliveryUncertain: deliveryUncertain,
        });
        codexTurnSucceeded = true;
      } catch (error) {
        executionFailed = true;
        console.error("[worker] codex reply failed", errorToRedactedMessage(error));
        rawReply = buildCodexErrorReply({
          error,
          role: route.role,
          accountRole: accountRoute.role,
          sessionMode: sessionMemory.routeMode,
          codexCommand: this.options.config.codex[route.role].command,
        });
      } finally {
        const activeTurn = this.activeTurns.get(activeTurnKey);
        if (activeTurn?.controller === turnController) {
          this.activeTurns.delete(activeTurnKey);
        }
      }
    }

    const replyText =
      route.role === "family"
        ? filterFamilyOutput(rawReply, this.options.config.familyPolicy)
        : stripCodexRuntimeNoise(rawReply);
    const remainingReplyText =
      progressReplySender?.removeAlreadySentText(replyText) ??
      streamingReplySender?.removeAlreadySentText(replyText) ??
      replyText;
    const finalReplyText = [dayChangeNotice, replyText].filter(Boolean).join("\n");

    if (!finalReplyText.trim()) {
      return;
    }

    const textToSend = [dayChangeNotice, remainingReplyText]
      .filter(Boolean)
      .join("\n");
    phase("delivering");
    let lastClientId = "";
    if (textToSend.trim()) {
      const chunks = compactFinalReplyChunks(
        splitReplyTextBySystemNotice(textToSend),
        FINAL_REPLY_MESSAGE_SLOTS,
      );
      for (const [index, chunk] of chunks.entries()) {
        lastClientId = await sendTextMessage({
          client,
          toUserId: inbound.contactId,
          contextToken: inbound.contextToken,
          text: chunk,
        });
        if (index < chunks.length - 1) {
          await sleep(350);
        }
      }
    }
    deliveryAccepted();

    this.options.database.appendMessage({
      id: buildMessageId("outbound"),
      sessionId: sessionForReply.id,
      direction: "outbound",
      messageType: "text",
      textContent: finalReplyText,
      createdAt: new Date().toISOString(),
      sourceMessageId: lastClientId || inbound.sourceMessageId,
    });
    const latestSession =
      this.options.database.getSessionById(sessionForReply.id) ?? sessionForReply;
    const latestMemory = parseSessionMemory(latestSession.memoryJson);
    const familyApiContext =
      codexTurnSucceeded &&
      route.role === "family" &&
      backendForCompletedTurn?.backendKind === "api"
        ? appendFamilyApiContext({
            existingContext: latestMemory.familyApiContext,
            userText: inbound.text,
            assistantText: replyText,
          })
        : latestMemory.familyApiContext;
    const lastAcpTaskNote =
      codexTurnSucceeded &&
      route.role === "family" &&
      backendForCompletedTurn?.backendKind === "acp"
        ? buildAcpTaskNote({
            attachments: pendingAttachments,
            finalText: replyText,
          })
        : codexTurnSucceeded && backendForCompletedTurn?.backendKind === "api"
          ? undefined
          : latestMemory.lastAcpTaskNote;
    const {
      familyApiContext: _previousFamilyApiContext,
      lastAcpTaskNote: _previousLastAcpTaskNote,
      lastFamilyBackend: _previousLastFamilyBackend,
      lastFamilyBackendReason: _previousLastFamilyBackendReason,
      ...nextMemoryBase
    } = latestMemory;
    this.options.database.saveSession({
      id: sessionForReply.id,
      wechatAccountId: sessionForReply.wechatAccountId,
      contactId: sessionForReply.contactId,
      role: latestSession.role,
      status: latestSession.status,
      summaryText: latestSession.summaryText,
      memoryJson: stringifySessionMemory({
        ...nextMemoryBase,
        ...(familyApiContext ? { familyApiContext } : {}),
        ...(lastAcpTaskNote ? { lastAcpTaskNote } : {}),
        ...(route.role === "family" && backendForCompletedTurn
          ? {
              lastFamilyBackend:
                backendForCompletedTurn.backendKind === "acp" ? "acp" : "api",
            }
          : {}),
        ...(familyBackendReason
          ? { lastFamilyBackendReason: familyBackendReason }
          : {}),
        turnCount:
          Math.max(latestMemory.turnCount ?? 0, sessionMemory.turnCount ?? 0) + 1,
        estimatedTokenCount:
          Math.max(
            latestMemory.estimatedTokenCount ?? 0,
            sessionMemory.estimatedTokenCount ?? 0,
          ) +
          estimateTextTokens(userTextForCodex) +
          estimateTextTokens(finalReplyText),
      }),
      contextToken: latestSession.contextToken,
      lastActiveAt: new Date().toISOString(),
    });
    if (executionFailed) throw new Error("Task failed; inspect history before resubmitting");
  }
}
