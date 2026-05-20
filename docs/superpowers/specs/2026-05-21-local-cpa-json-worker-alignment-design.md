# Local CPA JSON Worker Alignment Design

## 背景

当前项目里的 `CPA JSON` 导出分为两条链路：

- 有 RT：OAuth 回调换 token 后导出本地 `CPA JSON`
- 无 RT：注册完成后读取 `https://chatgpt.com/api/auth/session` 并导出本地 `CPA JSON`

现状中，两条链路虽然都能生成本地文件，但导出结构并未严格对齐 `/Users/yzpd/Desktop/auto_tools/worker.js` 中的 `CPA JSON` 规则。当前实现的主要问题如下：

- 导出 JSON 的最终字段语义由通用 `session-to-json-converter` 控制，不是 `worker.js` 的 `CPA` 专用结构。
- 无 RT 导出的 `last_refresh` 当前为空字符串，而 `worker.js` 固定写导出时刻。
- 文件命名规则不符合本次目标。当前文件名是 `codex-${email}-${plan}.json` 一类格式，而目标要求是 `本次注册邮箱.json`。
- 有 RT 和无 RT 两条导出链路没有共享同一个最终 `CPA JSON` 构建器，后续维护容易继续漂移。

本次整改目标是：让项目内所有 `CPA JSON` 导出结果严格对齐 `worker.js` 的 `cpa` 结构，并统一文件命名为“本次注册邮箱 + .json”。

## 范围

本次仅覆盖 `CPA JSON` 导出链路：

- 覆盖 `local-cpa-json` 有 RT 导出
- 覆盖 `local-cpa-json-no-rt` 无 RT 导出

本次不包含：

- `sub2api` 导出结构整改
- 非 `CPA JSON` 模式的导出逻辑调整
- 注册、支付、授权主流程本身的行为变更

## 目标

### 功能目标

- 有 RT / 无 RT 两种 `CPA JSON` 导出统一按 `worker.js` 的 `cpa` 结构生成。
- 输出文件名统一为本次注册邮箱，例如 `user@example.com.json`。
- 缺失真实 `id_token` 时，按 `worker.js` 规则生成可被 CPA 面板解析的 synthetic JWT。
- 缺失 `refresh_token` 时，仍允许无 RT 导出成功，并产出相同语义的 warning。

### 非功能目标

- 同一份 `CPA JSON` 构建规则只能在项目中保留一处权威实现。
- 两条导出链路的测试都要直接验证最终写入 JSON 的内容，而不是只验证中间参数。
- 不改变已有 helper 落盘接口 `/save-auth-json`。

## 失败根因分析

### 根因一：当前导出模型是通用 session 转换，不是 CPA 专用导出

当前无 RT 导出路径：

- `background/steps/wait-registration-success.js`
- `readChatGptSessionForExport()`
- `background/local-cli-proxy-api.js`
- `shared/session-to-json-converter.js`

这条链路本质是“把 session 记录转成通用 auth json”，而不是“按 `worker.js` 规则直接生成 `CPA JSON`”。因此即使导出成功，最终字段也可能和 `worker.js` 目标结构不一致。

### 根因二：文件命名规则不匹配

当前 `background/local-cli-proxy-api.js` 通过 `buildCredentialFileName()` 生成 `codex-*.json` 风格文件名。目标要求改为：

- 文件名固定为 `本次注册邮箱.json`

这意味着现有命名逻辑不能继续复用在 `CPA JSON` 导出上。

### 根因三：`last_refresh` 及无 RT 语义不匹配

当前无 RT 导出调用 `buildAuthJsonArtifact()` 时传入：

- `lastRefresh: ''`

这与 `worker.js` 中 `last_refresh = 当前导出时间` 的行为不一致，也会导致导出文件与目标结构发生偏差。

### 根因四：有 RT / 无 RT 没有共享同一套最终产物定义

如果只修无 RT，不修有 RT，项目内就会继续存在两种 `CPA JSON` 结构；后续用户一旦切换模式，就会再次遇到导出不一致问题。

## 设计决策

### 决策一：新增统一的 `CPA JSON` 构建器

新增一个专用模块，职责只有一件事：

- 将 session / token / account 信息转换成严格对齐 `worker.js` 的 `CPA JSON`

该模块是后续 `CPA JSON` 导出的唯一权威实现。有 RT 和无 RT 都必须调用它。

### 决策二：保留现有本地 helper 写入接口

仍然使用当前 helper：

- `POST /save-auth-json`

原因：

- helper 已经是当前项目的既有落盘能力
- 本次问题在于 JSON 构建规则，而不是写盘协议

### 决策三：`sub2api` 相关逻辑保持不变

`worker.js` 同时生成 `sub2api` 配置，但用户明确要求本次只覆盖 `CPA JSON`。因此 `sub2api` 不纳入本次整改，避免扩大影响面。

## 目标导出结构

最终 `CPA JSON` 必须与 `worker.js` 的 `cpa` 结构语义一致，至少包含以下字段：

```json
{
  "type": "codex",
  "email": "user@example.com",
  "account_id": "acct_xxx",
  "chatgpt_account_id": "acct_xxx",
  "plan_type": "plus",
  "chatgpt_plan_type": "plus",
  "id_token": "jwt-or-synthetic-jwt",
  "access_token": "access-token",
  "refresh_token": "refresh-token-or-empty",
  "session_token": "session-token-or-empty",
  "last_refresh": "2026-05-21T12:34:56.000Z",
  "expired": "2026-05-30T00:00:00.000Z",
  "disabled": false,
  "id_token_synthetic": true
}
```

说明：

- `id_token_synthetic` 在缺少真实 `id_token` 时为 `true`
- `disabled` 固定为 `false`
- `last_refresh` 固定为导出时刻 ISO 时间
- `expired` 优先取 session/tokens 中可解析的过期时间

## 字段提取规则

字段提取统一按 `worker.js` 语义实现：

- `access_token`
  - 必填
  - 来源优先 `accessToken` / `access_token`
- `session_token`
  - 来源优先 `session.sessionToken` / `session_token`
- `refresh_token`
  - 有 RT 时优先取 OAuth token exchange 结果
  - 无 RT 时允许为空
- `email`
  - 优先 `session.user.email`
  - 其次 access token profile claims
  - 其次显式入参
- `account_id` / `chatgpt_account_id`
  - 优先 `session.account.id`
  - 其次 access token auth claims
- `plan_type` / `chatgpt_plan_type`
  - 优先 `session.account.planType`
  - 其次 access token auth claims
  - 缺失时允许为 `unknown`
- `expired`
  - 优先 `session.expires`
  - 其次 access token `exp`
- `id_token`
  - 优先真实 `id_token`
  - 缺失时生成 synthetic JWT

## 文件命名规则

`CPA JSON` 文件名规则固定为：

- `${registrationEmail}.json`

其中 `registrationEmail` 必须是本次注册成功使用的邮箱，不能退回旧的 `codex-*` 命名风格。

如果无法解析本次注册邮箱，则直接报错终止导出，不允许静默生成模糊文件名。

## 模块与职责调整

### 新模块

建议新增共享模块，例如：

- `shared/cpa-json-builder.js`

职责：

- 解析 access token payload
- 提取 account / profile claims
- 生成 synthetic `id_token`
- 生成最终 `cpa` 对象
- 生成 `${email}.json` 文件名
- 返回 warnings

### 现有模块调整

#### `background/local-cli-proxy-api.js`

调整为：

- 保留 OAuth 地址生成、PKCE、token exchange 能力
- 不再直接决定 `CPA JSON` 的最终字段结构
- `buildAuthJsonArtifact()` 内部改为调用新的统一 `CPA JSON` 构建器

#### `shared/session-to-json-converter.js`

本次不再作为 `CPA JSON` 的最终权威格式来源。

处理方式：

- 可以保留给其他历史用途
- 但 `CPA JSON` 导出不得继续直接依赖其产物结构作为最终输出

#### `background/steps/wait-registration-success.js`

无 RT 导出保持现有时序：

- Step 7 等待 5 秒
- 读取 `https://chatgpt.com/api/auth/session`
- 构建 `CPA JSON`
- 调 helper 落盘

但最终 JSON 改为统一构建器生成。

#### `background/steps/platform-verify.js`

有 RT 导出在 OAuth callback exchange 成功后：

- 使用 access token / refresh token / id token
- 调统一构建器生成 `CPA JSON`
- 调 helper 落盘

## 错误处理

以下情况必须直接失败并给出明确错误：

- 缺少 `access_token`
- 无法识别本次注册邮箱
- 无法识别 `account_id`，且无法从 claims 中恢复
- helper 写入失败
- helper 版本过旧，不支持 `/save-auth-json`

以下情况允许成功但要输出 warning：

- 缺少 `refresh_token`
- 缺少真实 `id_token`，已改用 synthetic `id_token`
- 缺少 `session_token`

## 测试设计

### 单元测试

新增针对统一 `CPA JSON` 构建器的测试，覆盖：

- 标准 session 输入可生成完整 `CPA JSON`
- 缺少 `refresh_token` 时 warning 正确
- 缺少真实 `id_token` 时生成 synthetic JWT
- 从 access token claims 恢复 `account_id` / `plan_type`
- 文件名固定为 `${email}.json`

### 集成测试

#### 无 RT

更新：

- `tests/background-step6-retry-limit.test.js`

验证：

- 写入 helper 的 `content` 必须是 `worker.js` 风格的 `CPA JSON`
- 文件名必须为 `user@example.com.json`
- `last_refresh` 为有效 ISO 时间
- `id_token_synthetic`、`disabled` 等字段语义正确

#### 有 RT

更新：

- `tests/background-platform-verify-cpa-api.test.js`
- 以及任何直接断言本地 `CPA JSON` 结构的相关测试

验证：

- OAuth exchange 后导出的 `CPA JSON` 与 `worker.js` 语义一致
- `refresh_token` 被正确写入
- 文件名规则与无 RT 一致

## 验收标准

满足以下条件才算完成：

1. `local-cpa-json` 与 `local-cpa-json-no-rt` 两种模式最终写入的 `CPA JSON` 都严格对齐 `worker.js` 的 `cpa` 结构。
2. 两种模式导出的文件名都为“本次注册邮箱 + .json”。
3. 缺失 `refresh_token` 的无 RT 场景仍可成功导出，并给出 warning。
4. 缺失真实 `id_token` 时会生成 synthetic JWT，并显式标记 `id_token_synthetic: true`。
5. 相关单元测试和集成测试全部通过。

## 风险与兼容性

### 风险一：旧测试依赖 `codex-*` 文件名

本次会打破旧命名假设，相关测试必须同步更新。

### 风险二：旧代码可能复用了通用 auth json 结构

如果项目里还有别处隐式依赖旧 `buildAuthJsonArtifact()` 输出格式，需要在整改时一并核对调用点，避免误伤非 `CPA JSON` 场景。

### 风险三：synthetic `id_token` 兼容性

本次 synthetic JWT 必须严格沿用 `worker.js` 的 claims 语义，不能自创字段，避免 CPA 面板无法识别套餐与账号信息。
