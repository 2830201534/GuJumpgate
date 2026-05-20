# PayPal Hosted Verification Retry Design

日期：2026-05-20
分支：`feature/paypal-hosted-verification-retry`
范围：仅设计 `hosted checkout` 下的 PayPal 验证码失败恢复机制，不包含普通 PayPal 授权页。

## 1. 背景

当前 `hosted checkout` PayPal 验证码流程已经支持：

- 后台轮询验证码接口获取 6 位验证码；
- 页面脚本将验证码填入 PayPal hosted verification 输入框；
- 后续继续支付链路。

当前缺口在于：

- 如果验证码提交后 PayPal 页面提示 `Sorry, something went wrong. Get a new code.`，流程不会自动恢复；
- 如果验证码接口返回的仍然是旧码，当前流程会重复提交无效验证码；
- 程序重启后没有利用“上一次成功验证码”来预防重复提交旧码。

本设计补齐以上恢复链路，并保持现有职责分层：后台负责编排和状态，页面脚本负责 DOM 交互。

## 2. 目标

新增一套生产级的 PayPal hosted verification 自动恢复机制，满足以下行为：

1. 全局持久化最近一次“成功通过 PayPal hosted verification”的验证码。
2. 本次待输入验证码若与该持久化值一致，则在输入前先点击 `Resend`，再重新取码。
3. 验证码提交后等待 5 秒，如出现目标错误块 `/html/body/div[3]/div/section/div[2]/div[1]`，且内容包含 `Sorry, something went wrong. Get a new code.`，则自动点击 `/html/body/div[3]/div/section/div[2]/p/button` 的 `Resend` 按钮。
4. `Resend` 后等待 3 秒重新拉取验证码；如果为空或与禁用集合重复，则最多再等待 3 秒重拉一次。
5. 两次重拉仍失败时，停止当前流程，记录日志、向侧边栏提示“需要手动输入验证码”、将当前节点标记为失败。
6. 成功通过后，将本次成功验证码写入浏览器本地存储。

## 3. 非目标

本设计不包含以下内容：

- 不改造普通 PayPal 账号登录/授权页；
- 不新增新的 UI 面板或独立弹窗；
- 不保存验证码历史列表；
- 不引入按会话或按接口地址隔离的验证码缓存；
- 不修改 hosted checkout 验证码接口协议。

## 4. 方案选择

### 方案 A：后台主导恢复，页面脚本仅补 DOM 能力

做法：

- 在 `background/steps/create-plus-checkout.js` 中扩展 hosted PayPal verification 编排；
- 在 `content/paypal-flow.js` 中新增“检测错误块”和“点击 Resend”的页面能力；
- 后台继续负责取码、等待、比较、重试、存储、失败终止。

优点：

- 与项目当前“后台编排，内容脚本执行 DOM”的模式一致；
- 改动集中，最容易和现有日志、节点失败语义整合；
- 测试边界明确。

缺点：

- `create-plus-checkout.js` 中的 hosted checkout 状态机会进一步变长。

### 方案 B：页面脚本主导恢复

做法：

- 把等待 5 秒、检测错误、点击 `Resend`、再次填码的大部分逻辑下沉到 `content/paypal-flow.js`；
- 后台只负责给页面脚本提供验证码。

优点：

- DOM 判断就近完成。

缺点：

- 页面脚本开始承担流程策略和恢复状态，职责变重；
- 与现有后台中心化编排模式不一致；
- 存储和失败广播仍需回流后台，边界会变模糊。

### 方案 C：新增独立 hosted verification recovery 模块

做法：

- 从 `create-plus-checkout.js` 中抽一个专门的恢复 helper；
- 由该 helper 协调页面状态、验证码获取和本地存储。

优点：

- 边界最清晰，后续容易继续扩展。

缺点：

- 当前需求下改动面偏大；
- 对一次定向增强来说成本略高。

### 结论

采用方案 A。原因是它最符合现有代码结构，能最小成本接入现有日志、节点状态和自动化节奏控制。

## 5. 设计概览

主要涉及两个文件：

- `background/steps/create-plus-checkout.js`
- `content/paypal-flow.js`

职责分工保持如下：

- 后台：
  - 拉取 hosted checkout 验证码；
  - 读取/写入最近成功验证码；
  - 决定是否预先 `Resend`；
  - 在提交后等待并检查 PayPal 验证失败状态；
  - 驱动 `Resend -> 重拉验证码 -> 再次提交`；
  - 决定失败终止与提示用户。
- 页面脚本：
  - 检测 PayPal hosted verification 错误块是否出现；
  - 点击 `Resend`；
  - 检测验证码输入框是否可见；
  - 填入验证码。

## 6. 本地存储设计

使用 `chrome.storage.local` 保存一个全局键：

- `paypalHostedLastSuccessfulVerificationCode`

存储规则：

- 仅在 PayPal hosted verification 最终成功通过后写入；
- 自动恢复失败时不覆盖；
- 不保存时间戳；
- 不保存失败验证码；
- 不做多条历史记录。

选择全局单值是因为本次需求已明确指定该粒度，继续增加维度会让恢复逻辑和测试复杂度上升，没有必要。

## 7. 后台流程设计

### 7.1 进入 verification 阶段前置检查

当 `create-plus-checkout.js` 检测到：

- `pageState.hostedStage === 'verification'`
- `pageState.verificationInputsVisible === true`

后台执行以下顺序：

1. 从 `chrome.storage.local` 读取 `paypalHostedLastSuccessfulVerificationCode`；
2. 调用现有 `pollHostedCheckoutVerificationCode()` 拉取当前验证码；
3. 如果当前验证码与最近成功验证码一致：
   - 调用页面脚本点击 `Resend`；
   - 等待 3 秒；
   - 再次拉取验证码；
   - 若仍为空或仍等于最近成功验证码，再等待 3 秒拉最后一次；
   - 若最终仍为空或仍等于最近成功验证码，则失败终止，提示用户手动输入验证码；
4. 若得到可用验证码，则进入提交流程。

这里“可用验证码”的判定是：

- 非空；
- 不等于最近成功验证码。

### 7.2 提交后错误检测与自动恢复

后台把可用验证码发送给 `content/paypal-flow.js` 填入并提交后，执行以下恢复链：

1. 等待 5 秒；
2. 让页面脚本检测目标错误块是否出现，并要求文案匹配 `Sorry, something went wrong. Get a new code.`；
3. 若未出现错误块：
   - 视为本轮验证码提交成功；
   - 将本次验证码写入 `paypalHostedLastSuccessfulVerificationCode`；
   - 继续原有后续支付链路。
4. 若出现错误块：
   - 让页面脚本点击 `Resend`；
   - 等待 3 秒重新拉取验证码；
   - 若新码为空，或与下列任一值相同，则视为无效：
     - 刚刚提交失败的验证码；
     - 本轮第一次 `Resend` 后取到的验证码；
   - 若第一次重取无效，则再等待 3 秒重拉一次；
   - 第二次仍无效则失败终止，提示用户手动输入验证码；
   - 若取得有效新码，则再次下发给页面脚本填写。

这里的“禁用集合”定义为：

- 本轮刚刚提交失败的验证码；
- 本轮第一次 `Resend` 后拉取到的验证码（用于防止两次重取拿到同一旧码）。

### 7.3 成功写入规则

只有在“提交后 5 秒未检测到错误块”的情况下，后台才写入：

- `paypalHostedLastSuccessfulVerificationCode = 当前提交码`

这样可以避免把失败验证码污染为新的全局基线。

## 8. 页面脚本设计

`content/paypal-flow.js` 新增或扩展以下页面能力：

1. `detectHostedVerificationFailure()`
   - 检测错误块 `/html/body/div[3]/div/section/div[2]/div[1]`；
   - 同时校验文案包含 `Sorry, something went wrong. Get a new code.`；
   - 返回布尔结果和必要的诊断信息。

2. `clickHostedVerificationResend()`
   - 定位 `/html/body/div[3]/div/section/div[2]/p/button`；
   - 校验按钮文案包含 `Resend`；
   - 执行点击；
   - 返回点击结果。

3. `runHostedCheckoutStep(payload)` 扩展
   - 在 verification 阶段支持新的子动作，例如：
     - 仅检查失败态；
     - 仅点击 `Resend`；
     - 继续沿用现有填码能力。

页面脚本不负责：

- 拉取验证码；
- 持久化验证码；
- 决定重试次数；
- 终止流程。

## 9. 日志与用户提示

出现以下关键分支时，后台必须写日志：

- 当前验证码与最近成功验证码一致，准备先 `Resend`；
- 提交后 5 秒检测到 `Sorry, something went wrong`；
- 第一次重取验证码为空；
- 第一次重取验证码与禁用集合重复；
- 第二次重取仍失败，准备停止自动流程；
- 成功写入新的最近成功验证码。

失败终止时，必须同时满足：

1. 后台日志明确写出失败原因；
2. 通过现有侧边栏消息/Toast 体系提示“需要手动输入验证码”；
3. 当前节点状态标记为失败。

这里不新增专门弹窗，沿用现有日志和侧边栏提示渠道。

## 10. 错误处理

### 可自动恢复

- 当前验证码与最近成功验证码一致；
- 提交后命中 `Sorry, something went wrong`；
- 第一次重取为空；
- 第一次重取与禁用集合重复。

处理策略：

- 自动 `Resend`；
- 等待固定时长；
- 最多进行两次重拉。

### 不可自动恢复

- 两次重拉后仍为空；
- 两次重拉后仍重复；
- 找不到 `Resend` 按钮；
- 找不到错误块但页面状态异常；
- 验证输入框消失且无法恢复到可填写状态。

处理策略：

- 当前节点失败；
- 记录明确日志；
- 提示用户手动输入验证码；
- 停止当前自动链路。

### 基础设施错误

- 验证码接口请求失败；
- PayPal 标签页关闭；
- 内容脚本通信超时；
- 页面脚本返回执行错误。

处理策略：

- 继续沿用现有 `create-plus-checkout.js` 错误语义；
- 不额外发明新的全局异常机制。

## 11. 测试设计

### 11.1 页面脚本测试

在 `tests/paypal-flow-content.test.js` 新增覆盖：

- 能识别目标错误块和 `Sorry, something went wrong. Get a new code.` 文案；
- 能识别并点击 `Resend` 按钮；
- 在验证码输入框存在时可以继续正常填码；
- 当错误块不存在或文案不匹配时，不误判为失败态。

### 11.2 后台步骤测试

为 `background/steps/create-plus-checkout.js` 增加或扩展测试，覆盖：

1. 当前验证码等于最近成功验证码时，输入前先 `Resend`；
2. `Resend` 后第一次重取为空，第二次重取成功；
3. `Resend` 后两次重取都为空，流程失败；
4. 提交后 5 秒命中错误块时，自动 `Resend` 并重拉；
5. 重拉新码与“刚刚失败码”一致时继续等待；
6. 重拉新码与“本轮第一次重取值”一致时失败；
7. 成功通过时写入新的 `paypalHostedLastSuccessfulVerificationCode`；
8. 正常一次成功路径不被额外恢复逻辑拖坏。

### 11.3 回归要求

至少验证以下不回归：

- 普通 PayPal 授权页不受影响；
- hosted checkout 非 verification 阶段不受影响；
- 原有验证码接口轮询逻辑不被替换；
- 成功页回跳和后续 OAuth 链路不受影响。

## 12. 风险与边界

主要风险：

- PayPal 页面 DOM 结构可能变化，导致 XPath 对应元素失效；
- 固定等待 5 秒和 3 秒依赖目标页面节奏，未来可能需要调参；
- 全局单值存储可能在极端并发场景下互相污染。

当前接受这些边界，理由如下：

- 本次需求已明确指定目标元素和固定等待时长；
- 当前项目本身以串行自动化为主，并发污染不是主问题；
- 若未来 PayPal hosted verification 恢复逻辑继续增长，再考虑抽独立 recovery helper 或引入更细的存储粒度。

## 13. 交付闸门

本功能进入实现前，必须满足以下设计闸门：

1. 仅针对 hosted checkout PayPal verification；
2. 仅保存全局一个最近成功验证码；
3. 输入前旧码预检必须先于首次提交；
4. 提交后错误恢复最多两次拉码；
5. 最终失败必须日志、提示、节点失败三者同时具备；
6. 不新增独立 UI，只复用现有提示体系。

满足以上条件后，再进入实现计划阶段。
