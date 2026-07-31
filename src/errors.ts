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

export function classifyHttpError(status: number, detail?: string): RequestError {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401) {
    return new RequestError(`认证失败（HTTP ${status}）${suffix}`, 'authentication', status);
  }
  if (status === 403) {
    if (detail && /opt[- ]?in|requires explicit/i.test(detail)) {
      return new RequestError(`模型访问受限（HTTP ${status}）${suffix}`, 'model-unavailable', status);
    }
    return new RequestError(`访问被拒绝（HTTP ${status}）${suffix}`, 'authentication', status);
  }
  if (status === 404) {
    return new RequestError(`模型或接口不存在（HTTP ${status}）${suffix}`, 'model-unavailable', status, true);
  }
  if (status === 429) {
    return new RequestError(`请求频率或额度受限（HTTP ${status}）${suffix}`, 'rate-limit', status, true);
  }
  if (status >= 500) {
    return new RequestError(`渠道服务异常（HTTP ${status}）${suffix}`, 'server', status, true);
  }
  return new RequestError(`请求参数错误（HTTP ${status}）${suffix}`, 'invalid-request', status);
}

export async function readHttpErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.clone().json() as { error?: { message?: unknown; code?: unknown; type?: unknown }; message?: unknown };
    const candidates = [payload?.error?.message, payload?.error?.code, payload?.error?.type, payload?.message];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    try {
      const text = (await response.clone().text()).trim();
      if (text) return text.slice(0, 240);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消或超时';
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

/** Agent Chat 通常会附带 tools；无 tools 的调用多为 Git 提交信息、标题生成等 utility 流程。 */
export function shouldNotifyLanguageModelFailure(
  options: { tools?: readonly unknown[] },
  error: unknown,
): boolean {
  if (error instanceof RequestError && error.category === 'cancelled') return false;
  if (error instanceof Error && error.name === 'AbortError') return false;
  return !options.tools?.length;
}
