# AI Manager

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

AI Manager is a VS Code desktop extension for managing OpenAI-compatible channels, dynamic model catalogs, and native VS Code Chat model bindings from one place.

## Why AI Manager

In VS Code, AI features such as code completions and Git commit-message generation typically default to GitHub Copilot. Using another AI model often means manually changing settings in several places. AI Manager was built to bring model connections, management, and switching into one place, so you can choose the right model more freely for each workflow.

Requires VS Code 1.121.0 or later.

## Highlights

- Manage OpenCode Go, OpenCode Console, and custom OpenAI-compatible channels.
- Refresh model catalogs while keeping the last successful cache available.
- Rename, filter, configure, and selectively enable discovered models.
- Register enabled models in the native VS Code Chat model picker.
- Bind separate models to Chat, Inline Chat, Plan, Plan implementation, Utility, and Utility Small settings.
- Store API keys in VS Code `SecretStorage`, with optional encrypted synchronization through `Settings Sync`.

## Screenshots

### Channel and model management

![AI Manager channel and model management](docs/images/channel-management.png)

### Chat model bindings

![AI Manager Chat model bindings](docs/images/chat-bindings.png)

## Quick Start

1. Open **AI Manager** from the Activity Bar.
2. Add a channel and enter its Base URL, endpoint paths, authentication mode, and optional API key.
3. Refresh the channel to load its model catalog.
4. Review the discovered models, adjust aliases or metadata when needed, and enable the models you want to use.
5. Open the Chat settings page in AI Manager and assign a channel and model to each setting you want to manage.

Newly discovered models are disabled by default.

## Supported Protocols

| Protocol | API | Typical endpoint |
| --- | --- | --- |
| OpenAI | Chat Completions | `/v1/chat/completions` |
| Anthropic | Messages | `/v1/messages` |
| Gemini | `streamGenerateContent` | `/v1beta/models/{model}:streamGenerateContent?alt=sse` |

Custom channels can configure independent endpoints for all three protocols and use Bearer, `x-api-key`, or `x-goog-api-key` authentication. A Gemini endpoint must include the `{model}` placeholder.

OpenCode Go automatically infers the protocol for known model families. You can override the protocol, token limits, and tool-calling capability from the model editor.

## Cross-device Sync

AI Manager can synchronize channels, model preferences, and encrypted API keys through VS Code `Settings Sync`.

When sync is enabled, API keys are encrypted with PBKDF2-SHA256 and AES-256-GCM before entering synchronized storage. The master password is never saved; only the derived key is stored locally in `SecretStorage`.

On another computer, sign in to the same VS Code account, enable `Settings Sync`, and unlock AI Manager once with the same master password. If the password is lost, the vault must be reset, which removes the synchronized ciphertext and local API keys.

## Notes and Limitations

- The main Chat default model applies to new conversations and does not replace a model manually selected in an existing conversation.
- The Plan implementation model uses an experimental VS Code setting and may be unavailable because of the VS Code version or organization policy.
- Disabled, unavailable, or unconfigured models are not exposed to the native model picker.

## Privacy

Request logs contain only the channel, alias, model ID, duration, HTTP status, and error category. AI Manager does not log prompts, responses, credentials, the sync master password, or derived keys, and it does not read local OpenCode authentication files.

## Development

```powershell
npm install
npm run check
npm run package:vsix
```

Use `npm test` for unit tests and `npm run test:integration` for the Extension Host integration test. Press `F5` in VS Code to launch an Extension Development Host.
