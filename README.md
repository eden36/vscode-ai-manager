# AI Manager

AI Manager 是一个 VS Code 桌面扩展，用于统一管理 OpenAI-compatible 渠道、动态模型目录和 Chat 模型绑定。

## 当前功能

- 内置 OpenCode Go、OpenCode Console 预设，也支持自定义 OpenAI-compatible 地址。
- 从 `/models` 刷新目录并保留上次成功缓存。
- 在模型列表中设置别名和启用状态；默认别名为“渠道名： 模型名”。
- 将启用的可用模型注册到 VS Code 原生 Chat 模型选择器。
- 分别通过“渠道 → 模型”联动选择主 Chat、Inline Chat、Plan、Plan 实现阶段、Utility 和 Utility Small 模型。
- 支持搜索和筛选模型，并延迟渲染折叠的模型列表。
- 绑定模型失效时安全恢复绑定前的用户级 Chat 设置，也可以主动解除绑定。
- API Key 使用 VS Code `SecretStorage` 保存，不写入配置、缓存或日志。
- 支持在渠道编辑界面单独清除已保存的 API Key。
- 可通过 VS Code Settings Sync 跨设备同步渠道、模型偏好和加密后的 API Key。

## 跨设备同步

在“同步”页面创建同步主密码后，扩展会使用 PBKDF2-SHA256 和 AES-256-GCM 加密现有 API Key，并将密文与可移植配置交给 VS Code Settings Sync。同步主密码不能为空，但不限制长度；原始主密码不会保存，本机只在 `SecretStorage` 中保存派生密钥。

在新电脑上登录同一 VS Code 账号并启用 Settings Sync 后，AI Manager 会恢复渠道和模型偏好，并提示输入一次同步主密码。忘记主密码时只能重置保险库；重置会清除同步密文和本机 API Key，无法恢复旧密钥。

扩展只调用 OpenAI Chat Completions。新发现模型默认不启用；OpenCode Go 的目录不提供协议元数据，扩展会标记已知的 Messages 模型，也可以在模型详情中手动修正协议和能力。

主 Chat 默认模型只作用于新建会话，当前会话中手动选择的模型不会被覆盖。Plan 实现阶段模型是 VS Code 实验性设置，可能因 VS Code 版本或组织策略而不可用。上述设置保存在当前 Profile 的用户设置中，并由 VS Code Settings Sync 按其设置同步规则处理。

## 开发

```powershell
npm install
npm run check
npm run package:vsix
```

`npm test` 只运行单元测试；`npm run test:integration` 会优先使用本机 VS Code 启动 Extension Host。CI 中可设置 `AI_MANAGER_VSCODE_VERSION=1.121.0` 验证最低支持版本，或通过 `AI_MANAGER_VSCODE_EXECUTABLE` 指定可执行文件。

在 VS Code 中按 `F5` 启动 Extension Development Host。打开 Activity Bar 中的 AI Manager，添加渠道、刷新模型目录并创建别名。

## 隐私

请求日志仅包含渠道、别名、实际模型、耗时、状态码和错误类别。扩展不会记录提示词、响应正文、凭据、同步主密码或派生密钥，也不会读取本机 OpenCode 的认证文件。
