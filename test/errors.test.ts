import { describe, expect, it } from 'vitest';
import { classifyHttpError, shouldNotifyLanguageModelFailure, RequestError } from '../src/errors';

describe('classifyHttpError', () => {
  it.each([
    [401, 'authentication', false],
    [403, 'authentication', false],
    [400, 'invalid-request', false],
    [404, 'model-unavailable', true],
    [429, 'rate-limit', true],
    [503, 'server', true],
  ] as const)('分类 HTTP %i', (status, category, retryable) => {
    const error = classifyHttpError(status);
    expect(error.category).toBe(category);
    expect(error.retryable).toBe(retryable);
    expect(error.message).not.toContain('secret');
  });

  it('将 OpenCode 中国区模型 opt-in 403 归类为模型不可用', () => {
    const error = classifyHttpError(403, 'The latest version of this model is only available hosted in China and requires explicit opt in');
    expect(error.category).toBe('model-unavailable');
    expect(error.message).toContain('模型访问受限');
    expect(error.message).not.toContain('认证失败');
  });

  it('将通用 Permission denied 403 仍归类为访问被拒绝', () => {
    const error = classifyHttpError(403, 'Permission denied');
    expect(error.category).toBe('authentication');
    expect(error.message).toContain('访问被拒绝');
  });
});

describe('shouldNotifyLanguageModelFailure', () => {
  it('utility 流程失败时提示用户', () => {
    expect(shouldNotifyLanguageModelFailure({}, new RequestError('模型访问受限', 'model-unavailable', 403))).toBe(true);
    expect(shouldNotifyLanguageModelFailure({ tools: [{ name: 'read_file' }] }, new RequestError('失败', 'server', 500))).toBe(false);
    expect(shouldNotifyLanguageModelFailure({}, new RequestError('已取消', 'cancelled'))).toBe(false);
  });
});
