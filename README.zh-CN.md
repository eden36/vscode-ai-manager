# AI Manager

[English](README.md) | **简体中文** | [日本語](README.ja.md)

AI Manager 是一个 VS Code 桌面扩展，用于集中管理 OpenAI-compatible 渠道、动态模型目录和 VS Code 原生 Chat 模型绑定。

## 开发初衷

在 VS Code 中使用 AI 功能时，代码补全和 Git 提交信息生成等能力通常默认由 GitHub Copilot 提供；若想改用其他 AI 模型，往往需要手动调整多处配置。AI Manager 因此而生：它将不同 AI 模型的接入、管理和切换集中到一个界面中，让你能够更灵活地为不同场景选择合适的模型。

需要 VS Code 1.121.0 或更高版本。

## 核心功能

- 内置 OpenCode、OpenAI、Anthropic、Google Gemini、OpenRouter、DeepSeek、SiliconFlow、Mistral、Groq、Together AI 和 xAI 等渠道预设，并支持自定义 OpenAI-compatible 渠道。
- 刷新模型目录，并保留最近一次成功获取的缓存。
- 为发现的模型设置别名、筛选条件、元数据和启用状态。
- 将已启用的模型注册到 VS Code 原生 Chat 模型选择器。
- 分别为 Chat、Inline Chat、Plan、Plan 实现阶段、Utility 和 Utility Small 设置绑定模型。
- 同一 VS Code 发行版的所有 Profile 自动共享渠道、完整模型目录、刷新状态和 Chat 绑定，并可通过 `Settings Sync` 加密同步到其他设备。

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
| OpenAI Responses | Responses | `/v1/responses` |

自定义渠道可以分别配置四种协议的接口，并使用 Bearer、`x-api-key` 或 `x-goog-api-key` 认证。Gemini 接口路径必须包含 `{model}` 占位符。

每个模型使用的协议按以下顺序判定：渠道目录中的显式字段、`models.dev` 提供的协议元数据、已知模型系列的本地规则，最后是渠道默认协议。若请求因所选协议的接口不存在而失败，AI Manager 会用另一个已配置的协议重试一次，并记住结果。

你可以在模型编辑器中手动修改协议和 Token 上限。工具调用能力取自模型目录：目录明确声明时按声明上报，目录未声明时默认视为支持。

## 跨设备同步

同一 VS Code 发行版的所有 Profile 会通过本机共享目录共用渠道、完整模型目录、刷新结果、Chat 绑定和加密保险库。在任一 Profile 手动修改 Chat 设置后，其他 Profile 也会自动应用；Stable、Insiders 等不同发行版使用相互隔离的目录。

启用跨设备同步后，完整共享状态会经过压缩和完整性校验，再写入 VS Code `Settings Sync`。API Key 会先使用 PBKDF2-SHA256 和 AES-256-GCM 加密；同步主密码不会被保存，每个 Profile 的 `SecretStorage` 中只保存自己的派生密钥。

在另一台电脑上登录同一个 VS Code 账号并启用 `Settings Sync`，然后在每个使用 AI Manager 的 Profile 中使用相同主密码解锁一次。若忘记主密码，只能重置保险库；重置会删除同步密文和 API Key，但保留本机非敏感配置。

## 注意事项与限制

- Chat 默认模型只作用于新建会话，不会替换现有会话中手动选择的模型。
- Plan 实现阶段模型使用 VS Code 实验性设置，可能因 VS Code 版本或组织策略而不可用。
- 已停用、不可用或未配置协议接口的模型不会显示在原生模型选择器中。
- 扩展需要读写本机共享状态目录，因此声明为 UI 扩展。在 Remote-SSH、WSL 和 Codespaces 窗口中，它运行在本地电脑而不是远端主机上。

## 隐私

请求日志只包含渠道、别名、模型 ID、耗时、HTTP 状态和错误类别。AI Manager 不会记录提示词、响应正文、凭据、同步主密码或派生密钥，也不会读取本机 OpenCode 认证文件。

刷新模型目录时，AI Manager 还会请求 `https://models.dev/api.json` 以判断各模型使用的接口协议。该请求不携带 API Key 和任何用户数据，结果会缓存 6 小时。

## 开发

```powershell
npm install
npm run check
npm run package:vsix
```

使用 `npm test` 运行单元测试，使用 `npm run test:integration` 运行 Extension Host 集成测试。在 VS Code 中按 `F5` 可启动 Extension Development Host。
