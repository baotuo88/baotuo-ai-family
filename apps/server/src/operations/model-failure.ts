export type ModelFailureCode = "not_configured" | "authentication" | "quota_exceeded" | "rate_limited" |
  "model_unavailable" | "timeout" | "cancelled" | "network" | "invalid_response" | "provider_error" | "permission";

const details: Record<ModelFailureCode, string> = {
  not_configured: "模型服务尚未配置，请在后台选择对应用途和角色后保存。",
  authentication: "模型鉴权失败，请检查该用途的 API Key、接口地址及权限。",
  quota_exceeded: "模型额度不足，请检查供应商账户余额或套餐。",
  rate_limited: "模型请求受到限流，请稍后再试或降低并发。",
  model_unavailable: "模型或接口不可用，请核对模型 ID 与接口协议。",
  timeout: "模型请求超时；结果可能已在上游产生，请先检查任务记录。",
  cancelled: "任务已停止；停止本地等待不保证供应商取消计费。",
  network: "无法连接模型服务，请检查地址和服务器网络。",
  invalid_response: "模型未返回可用结果，请核对模型能力及响应格式。",
  provider_error: "模型服务返回异常，请查看任务编号并检查供应商状态。",
  permission: "当前成员没有使用这项功能的权限，请联系家庭管理员。",
};
export class ModelServiceError extends Error {
  constructor(readonly code: ModelFailureCode, detail = details[code]) { super(detail); }
}
export function modelFailure(error: unknown): { code: ModelFailureCode; detail: string } {
  if (error instanceof ModelServiceError) return { code: error.code, detail: error.message };
  const value = error instanceof Error ? error.message : String(error);
  const code: ModelFailureCode = /未配置|missing.*(?:key|url)|not configured/i.test(value) ? "not_configured"
    : /insufficient_quota|usage_limit_exceeded|余额|额度不足|billing|quota exceeded/i.test(value) ? "quota_exceeded"
    : /HTTP 429|rate.?limit/i.test(value) ? "rate_limited"
    : /HTTP 40[13]|unauthorized|invalid.?api.?key|authenticate|authentication/i.test(value) ? "authentication"
    : /HTTP (?:404|405)|model.?not.?found|unsupported.*model|not supported by this endpoint/i.test(value) ? "model_unavailable"
    : /cancelled|canceled|取消/i.test(value) ? "cancelled"
    : /timeout|timed out|AbortError/i.test(value) ? "timeout"
    : /fetch failed|ECONN|ENOTFOUND|network|socket/i.test(value) ? "network"
    : /empty content|未返回有效|invalid response/i.test(value) ? "invalid_response" : "provider_error";
  return { code, detail: details[code] };
}
export function providerFailure(status: number, code?: string): ModelServiceError {
  return new ModelServiceError(modelFailure(new Error(`HTTP ${status} ${code ?? ""}`)).code);
}
