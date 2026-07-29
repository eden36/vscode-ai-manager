import { describe, expect, it } from 'vitest';
import { classifyHttpError } from '../src/errors';

describe('classifyHttpError', () => {
  it.each([
    [401, 'authentication', false],
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
});
