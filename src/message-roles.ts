import * as vscode from 'vscode';

export type NormalizedMessageRole = 'user' | 'assistant' | 'system';

/** VS Code/Copilot 在 utility 流程（如 Git 提交信息）中会发送 System 角色消息。 */
const SYSTEM_ROLE = 3;

export function normalizeMessageRole(message: vscode.LanguageModelChatRequestMessage): NormalizedMessageRole {
  if (message.role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  if (message.role === vscode.LanguageModelChatMessageRole.User) return 'user';
  if ((message.role as number) === SYSTEM_ROLE) return 'system';
  return 'user';
}

export function extractMessageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : undefined))
    .filter((value): value is string => value !== undefined)
    .join('');
}
