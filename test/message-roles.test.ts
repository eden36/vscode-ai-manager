import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class TextPart {
    constructor(readonly value: string) {}
  }
  return {
    LanguageModelTextPart: TextPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  };
});

import * as vscode from 'vscode';
import { extractMessageText, normalizeMessageRole } from '../src/message-roles';

describe('message-roles', () => {
  it('识别 User、Assistant 与 System 角色', () => {
    expect(normalizeMessageRole({ role: 1, content: [], name: undefined } as any)).toBe('user');
    expect(normalizeMessageRole({ role: 2, content: [], name: undefined } as any)).toBe('assistant');
    expect(normalizeMessageRole({ role: 3, content: [], name: undefined } as any)).toBe('system');
  });

  it('提取文本内容', () => {
    expect(extractMessageText({
      role: 3,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('hello')],
    } as any)).toBe('hello');
  });
});
