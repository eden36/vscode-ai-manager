# AI Manager

[English](README.md) | **简体中文** | [日本語](README.ja.md)

AI Manager 是一个 VS Code 桌面扩展，用于集中管理 OpenAI-compatible 渠道、动态模型目录和 VS Code 原生 Chat 模型绑定。

## 开发初衷

在 VS Code 中使用 AI 功能时，代码补全和 Git 提交信息生成等能力通常默认由 GitHub Copilot 提供；若想改用其他 AI 模型，往往需要手动调整多处配置。AI Manager 因此而生：它将不同 AI 模型的接入、管理和切换集中到一个界面中，让你能够更灵活地为不同场景选择合适的模型。

需要 VS Code 1.121.0 或更高版本。

## 核心功能

- 管理 OpenCode Go、OpenCode Console 和自定义 OpenAI-compatible 渠道。
- 刷新模型目录，并保留最近一次成功获取的缓存。
- 为发现的模型设置别名、筛选条件、元数据和启用状态。
- 将已启用的模型注册到 VS Code 原生 Chat 模型选择器。
- 分别为 Chat、Inline Chat、Plan、Plan 实现阶段、Utility 和 Utility Small 设置绑定模型。
- 使用 VS Code `SecretStorage` 保存 API Key，并可通过 `Settings Sync` 加密同步。

## 界面截图

### 渠道与模型管理

![AI Manager 渠道与模型管理](docs/images/channel-management.png)

### Chat 模型绑定

![AI Manager Chat 模型绑定](docs/images/chat-bindings.png)

## 快速开始

1. 从 Activity Bar 打开 **AI Manager**。
2. 添加渠道，填写 Base URL、接口路径、认证方式和可选的 API Key。
3. 刷新渠道以加载模型目录。
4. 检查发现的模型，按需调整别名或元数据，然后启用需要使用的模型。
5. 打开 AI Manager 的 Chat 设置页面，为需要管理的设置选择渠道和模型。

新发现的模型默认不启用。

## 支持的协议

| 协议 | API | 常用接口路径 |
| --- | --- | --- |
| OpenAI | Chat Completions | `/v1/chat/completions` |
| Anthropic | Messages | `/v1/messages` |
| Gemini | `streamGenerateContent` | `/v1beta/models/{model}:streamGenerateContent?alt=sse` |

自定义渠道可以分别配置三种协议的接口，并使用 Bearer、`x-api-key` 或 `x-goog-api-key` 认证。Gemini 接口路径必须包含 `{model}` 占位符。

OpenCode Go 会自动推断已知模型系列使用的协议。你也可以在模型编辑器中手动修改协议、Token 上限和工具调用能力。

## 跨设备同步

AI Manager 可以通过 VS Code `Settings Sync` 同步渠道、模型偏好和加密后的 API Key。

启用同步后，API Key 会先使用 PBKDF2-SHA256 和 AES-256-GCM 加密，再写入同步存储。同步主密码不会被保存，本机 `SecretStorage` 中只保存派生密钥。

在另一台电脑上登录同一个 VS Code 账号并启用 `Settings Sync`，然后使用相同的同步主密码解锁一次 AI Manager。若忘记主密码，只能重置保险库；重置会删除同步密文和本机 API Key。

## 注意事项与限制

- Chat 默认模型只作用于新建会话，不会替换现有会话中手动选择的模型。
- Plan 实现阶段模型使用 VS Code 实验性设置，可能因 VS Code 版本或组织策略而不可用。
- 已停用、不可用或未配置协议接口的模型不会显示在原生模型选择器中。

## 隐私

请求日志只包含渠道、别名、模型 ID、耗时、HTTP 状态和错误类别。AI Manager 不会记录提示词、响应正文、凭据、同步主密码或派生密钥，也不会读取本机 OpenCode 认证文件。

## 开发

```powershell
npm install
npm run check
npm run package:vsix
```

使用 `npm test` 运行单元测试，使用 `npm run test:integration` 运行 Extension Host 集成测试。在 VS Code 中按 `F5` 可启动 Extension Development Host。
