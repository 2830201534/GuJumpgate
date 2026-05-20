# 本地 CPA JSON 浏览器直写盘设计

- 日期：2026-05-21
- 适用范围：`local-cpa-json`、`local-cpa-json-no-rt`
- 目标：移除本地 CPA JSON 导出对 `scripts/hotmail_helper.py` 的主路径依赖，改为由扩展前端基于浏览器目录授权直接写入本地文件系统。

## 1. 背景

当前项目在导出本地 CPA JSON 时，流程分为两段：

1. 后台步骤负责生成 CPA JSON artifact；
2. 后台再通过 `POST /save-auth-json` 调用本地 `hotmail_helper.py` 落盘。

这个方案存在三个核心问题：

- 用户必须额外启动本地 helper，运维成本高；
- 一旦 helper 未启动、端口错误、版本过旧，扩展流程会在最后一步失败；
- 前端已经采集“插件目录”信息，但该信息当前只是字符串路径，浏览器自身并不能基于字符串路径直接写盘，导致用户感知与真实能力不一致。

本次目标不是继续增强 helper，而是把本地 CPA JSON 导出主路径切换为浏览器本地写盘。

## 2. 目标与非目标

### 2.1 目标

- 支持用户在侧边栏动态选择任意“根目录”。
- 扩展基于浏览器目录句柄，在该根目录下自动定位或创建 `.cli-proxy-api` 子目录。
- `local-cpa-json` 与 `local-cpa-json-no-rt` 两条链路统一写入 `${registrationEmail}.json`。
- 后台仍负责业务流程与 artifact 生成，真实写盘由 sidepanel 执行。
- 权限失效、sidepanel 未就绪、目录未选择、写盘失败时，输出明确错误。
- 不改变既有 CPA JSON 结构，不改变已有 worker 对齐逻辑。

### 2.2 非目标

- 不处理 `sub2api`、`codex2api`、传统 `cpa` 的文件写盘。
- 不将任意字符串路径升级为可直接写盘的能力。
- 不依赖 Chrome 下载目录能力实现“保存到指定插件目录”。
- 不在本次设计中移除 helper 的全部代码；仅将其从本地 CPA JSON 主路径中移除。

## 3. 方案选型

### 3.1 方案 A：File System Access API 目录句柄直写

做法：

- 由 sidepanel 触发 `showDirectoryPicker()`；
- 持久化 `FileSystemDirectoryHandle`；
- 写盘时自动进入或创建 `.cli-proxy-api`；
- 将 artifact 写为 `${email}.json`。

优点：

- 不需要额外本地服务；
- 用户交互与写盘目标一致；
- 可以真正写入用户授权的任意目录；
- 能保留现有 artifact 生成链路，仅替换落盘层。

缺点：

- 依赖用户授权；
- 目录权限可能失效，需要重授权；
- 写盘动作需要前端页面上下文，不适合完全依赖后台 service worker。

### 3.2 方案 B：下载文件

做法：后台或 sidepanel 生成 JSON 后触发下载。

否决原因：

- 无法可靠写到用户指定的插件目录；
- 最终文件可能落到浏览器下载目录；
- 不满足“选择根目录后直接写进去”的目标。

### 3.3 方案 C：Native Messaging 或其他本地桥

做法：引入新的本地宿主程序替代 HTTP helper。

否决原因：

- 本质仍是本地桥；
- 部署复杂度并未降低；
- 与“不要再单独起一个服务”的诉求不一致。

### 3.4 结论

采用方案 A：`File System Access API + IndexedDB 目录句柄持久化 + sidepanel 执行写盘`。

## 4. 总体架构

### 4.1 职责分层

#### background

- 负责流程控制；
- 负责生成 CPA JSON artifact；
- 负责向 sidepanel 发起“写入本地 CPA JSON”请求；
- 负责等待写入结果并完成对应节点。

#### sidepanel

- 负责用户选择根目录；
- 负责目录句柄持久化与权限检查；
- 负责创建 `.cli-proxy-api` 目录；
- 负责执行实际文件写入；
- 负责将写入结果返回 background。

#### shared

- 保持现有 `cpa-json-builder` 产物结构与命名逻辑；
- 可新增轻量共享协议常量或消息辅助函数，但不把写盘能力塞入 shared 纯逻辑模块。

### 4.2 数据流

1. 用户在 sidepanel 点击“选择根目录”并授权。
2. sidepanel 保存目录句柄并更新状态。
3. 后台在 `local-cpa-json` 或 `local-cpa-json-no-rt` 模式下生成 artifact。
4. 后台通过 panel bridge 请求 sidepanel 写入本地文件。
5. sidepanel 在 `<root>/.cli-proxy-api/` 下写入 `${email}.json`。
6. 写入成功后，sidepanel 返回逻辑路径信息。
7. 后台完成对应步骤并向日志输出“已导出”。

## 5. 目录与文件策略

### 5.1 用户选择粒度

- 用户只选择“根目录”。
- 允许用户后续重新选择任意新目录。
- UI 不要求用户手填真实路径作为写盘依据。

### 5.2 目标目录

固定规则：

`<selectedRoot>/.cli-proxy-api/${registrationEmail}.json`

行为要求：

- 如果 `.cli-proxy-api` 不存在，自动创建；
- 如果 `${registrationEmail}.json` 已存在，则覆盖写入；
- 文件内容保持 UTF-8 文本 JSON，与现有 artifact 完全一致。

### 5.3 文件名

- `baseName = registrationEmail`
- 输出文件名：`${registrationEmail}.json`

若最终无法得到有效邮箱：

- 直接中断导出并报错；
- 不允许写出匿名或随机命名文件。

## 6. 权限与持久化

### 6.1 目录句柄获取

由 sidepanel 调用：

- `window.showDirectoryPicker()`

要求：

- 仅在明确用户手势下触发；
- 选择成功后立即检查 `readwrite` 权限。

### 6.2 目录句柄持久化

采用 `IndexedDB` 保存 `FileSystemDirectoryHandle`。

原因：

- `chrome.storage.local` 不适合持久化目录句柄对象；
- 目录句柄仅存内存会在 sidepanel 刷新或浏览器重启后丢失。

同时在 `chrome.storage.local` 保存轻量展示状态：

- `localCpaJsonRootDirName`
- `localCpaJsonRootDirPickedAt`
- `localCpaJsonRootDirStatus`

这些字段仅用于 UI 展示和状态同步，不作为真实写盘依据。

### 6.3 权限检查策略

每次写盘前：

1. `queryPermission({ mode: 'readwrite' })`
2. 若非 `granted`，调用 `requestPermission({ mode: 'readwrite' })`
3. 若仍非 `granted`，报错并中断

错误文案要可行动，例如：

- `本地 CPA 根目录权限已失效，请在侧边栏重新授权后重试。`

## 7. 后台与 sidepanel 通信

### 7.1 通信原则

- background 不直接持有目录句柄；
- sidepanel 不负责构建 artifact；
- 写盘请求与响应必须是显式消息，不依赖共享可变全局状态。

### 7.2 请求内容

background -> sidepanel：

- `type`
- `fileName`
- `jsonText`
- `relativeAuthDir`
- `registrationEmail`

其中：

- `relativeAuthDir` 默认仍为 `.cli-proxy-api`
- 但真实目录定位规则仍由 sidepanel 控制，避免后台把路径拼接逻辑写死到字符串路径模型里

### 7.3 响应内容

sidepanel -> background：

- `ok`
- `filePathLabel`
- `rootDirName`
- `error`

`filePathLabel` 用于日志展示，可形如：

- `MyPlugin/.cli-proxy-api/user@example.com.json`

不要求返回操作系统绝对路径，因为目录句柄 API 未必总能可靠给出完整本机绝对路径字符串。

## 8. UI 改造

### 8.1 输入区域调整

保留现有本地 CPA 区域，但将“插件目录”从纯文本输入升级为“目录授权状态展示 + 选择动作入口”。

建议新增：

- `选择根目录`
- `重新选择`
- `检测权限`

### 8.2 状态展示

至少支持以下状态：

- `未选择目录`
- `已授权，可写入`
- `权限失效，需重新授权`
- `写入失败，请查看日志`

### 8.3 兼容展示

现有 `localCpaJsonPluginDir` 可继续保留为展示字段或兼容字段，但必须明确：

- 它不再是实际写盘能力来源；
- 即使文本框内有值，如果没有目录句柄授权，也不能写盘。

## 9. 导出链路改造

### 9.1 无 RT

文件：

- `background/steps/wait-registration-success.js`

调整：

- 保留会话读取逻辑；
- 保留 artifact 构建逻辑；
- 移除对 `/save-auth-json` 的主路径依赖；
- 改为调用 sidepanel 写盘桥；
- 成功后完成 `local-cpa-json-export`。

### 9.2 有 RT

文件：

- `background/steps/platform-verify.js`

调整：

- 保留 OAuth callback exchange 与 artifact 构建逻辑；
- 改为调用 sidepanel 写盘桥；
- 成功后完成 `platform-verify`。

### 9.3 helper 策略

本次改造后：

- helper 不再是本地 CPA JSON 的主路径；
- 是否保留 helper 作为显式降级能力，由实现阶段另行决定；
- 默认实现不自动 fallback 到 helper，避免再次出现双路径排障混乱。

## 10. 错误处理

### 10.1 sidepanel 未就绪

报错：

- `当前未检测到侧边栏写盘通道，请打开扩展侧边栏后重试。`

### 10.2 未选择根目录

报错：

- `尚未选择本地 CPA 根目录，请先在侧边栏完成授权。`

### 10.3 权限失效或拒绝

报错：

- `本地 CPA 根目录权限已失效，请重新选择或重新授权后重试。`

### 10.4 写盘失败

报错要求：

- 包含目标逻辑路径；
- 包含浏览器原始错误摘要；
- 不能只输出 `Failed to write` 之类无上下文错误。

### 10.5 邮箱缺失

报错：

- `缺少注册邮箱，无法生成本地 CPA JSON 文件名。`

## 11. 测试策略

### 11.1 sidepanel 单测

覆盖：

- 目录选择成功后的状态持久化；
- 目录句柄读取失败后的状态回退；
- 权限检查与重新授权分支；
- 自动创建 `.cli-proxy-api`；
- 正确写入 `${email}.json`；
- 写盘异常时返回明确错误。

### 11.2 background 单测

覆盖：

- `local-cpa-json` 导出请求 sidepanel 写盘；
- `local-cpa-json-no-rt` 导出请求 sidepanel 写盘；
- sidepanel 未在线时明确失败；
- sidepanel 返回错误时日志与异常正确传播。

### 11.3 回归测试

覆盖：

- CPA JSON 结构与 `worker.js` 对齐逻辑不回归；
- 文件命名继续为 `${email}.json`；
- PayPal 验证码、普通注册步骤、非本地 CPA 模式不受影响。

## 12. 风险与约束

### 12.1 浏览器支持

本方案依赖 `File System Access API`。若运行环境不支持：

- 需要在 UI 明确提示当前浏览器环境不支持本地目录直写；
- 不隐式回退到字符串路径写盘。

### 12.2 sidepanel 生命周期

由于目录句柄与用户手势天然属于前端页面上下文：

- 写盘动作依赖 sidepanel 通道；
- 当 sidepanel 完全未打开时，后台不能静默完成本地写盘。

这是接受的架构约束，不再通过后台直接写本地文件规避。

### 12.3 权限波动

浏览器重启、用户撤销权限、存储异常都可能导致目录句柄失效。

系统必须把这种情况视为正常失败路径，而不是异常边角。

## 13. 实施结论

本次实施应当：

- 以 sidepanel 目录句柄写盘替换 helper 主路径；
- 保持 artifact 生成层不变；
- 将“插件目录字符串”从写盘依据降级为展示信息；
- 为 `有RT` / `无RT` 两条路径提供统一、明确、可验证的本地写盘能力。
