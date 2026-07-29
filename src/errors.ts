export type RequestErrorCategory = 'authentication' | 'invalid-request' | 'model-unavailable' | 'rate-limit' | 'server' | 'timeout' | 'network' | 'cancelled';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly category: RequestErrorCategory,
    readonly status?: number,
    readonly retryable = false,
    readonly responseStarted = false,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export function classifyHttpError(status: number): RequestError {
  if (status === 401 || status === 403) {
    return new RequestError(`认证失败（HTTP ${status}）`, 'authentication', status);
  }
  if (status === 404) {
    return new RequestError('模型或接口不存在（HTTP 404）', 'model-unavailable', status, true);
  }
  if (status === 429) {
    return new RequestError('请求频率或额度受限（HTTP 429）', 'rate-limit', status, true);
  }
  if (status >= 500) {
    return new RequestError(`渠道服务异常（HTTP ${status}）`, 'server', status, true);
  }
  return new RequestError(`请求参数错误（HTTP ${status}）`, 'invalid-request', status);
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消或超时';
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}
