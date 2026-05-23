# PayPal Checkout Flow Split Design

- 日期：2026-05-23
- 适用范围：`plus-checkout-create`、新增 `paypal-checkout-flow`
- 目标：将当前步骤 6 中混合的“创建 checkout”与“进入 PayPal 后执行支付链路”拆分为两个独立节点，降低职责耦合，明确失败边界与重试策略。

## 1. 背景

当前 `plus-checkout-create` 同时承担了两类职责：

1. 创建 ChatGPT / hosted checkout 链接并推进到支付页；
2. 进入 PayPal 后继续执行登录、guest/card、验证码、review/approve、成功检测。

这导致：

- 节点职责过重，日志和失败原因不易区分；
- PayPal 自动化增强会频繁改动 checkout 创建逻辑；
- 回退策略粒度太粗，PayPal 内部可恢复问题与 checkout 已失效问题没有明确分层。

本次目标是把 PayPal 后续支付链路独立成一个新节点。

## 2. 目标与非目标

### 2.1 目标

- 保留 `plus-checkout-create` 作为 checkout 创建节点；
- 新增统一节点 `paypal-checkout-flow`；
- 所有进入 PayPal 后的支付后续都由 `paypal-checkout-flow` 接管；
- 明确“PayPal 内部重试”和“回退重建 checkout”的边界；
- 保持现有 hosted verification resend、短信池、验证码恢复逻辑可复用。

### 2.2 非目标

- 不重写现有 PayPal 页面自动化能力；
- 不改变 GPC Helper 独立任务创建模式；
- 不在本次拆分中新增新的支付方式；
- 不把 step 6 之外的流程节点一起重排。

## 3. 方案概览

### 3.1 节点职责拆分

#### `plus-checkout-create`

负责：

- 创建 checkout 链接；
- 打开 checkout 页面；
- 在 OpenAI / hosted checkout 侧完成前置推进；
- 等待成功跳转到 PayPal；
- 识别当前 PayPal 阶段；
- 把 PayPal 上下文写入运行时状态；
- 到此结束节点。

不再负责：

- PayPal 登录；
- PayPal guest/card 填写；
- 验证码处理；
- review / approve；
- PayPal 成功页等待。

#### `paypal-checkout-flow`

负责：

- 从已有运行时状态接管 PayPal tab；
- 按当前阶段执行 PayPal 后续自动化；
- 处理登录、guest/card、验证码、review/approve；
- 复用现有验证码失败重发机制；
- 检测成功页并完成节点；
- 在需要时决定是内部重试还是回退到 `plus-checkout-create`。

### 3.2 新节点命名

- 节点 id：`paypal-checkout-flow`
- 语义：统一处理所有进入 PayPal 后的支付后续

## 4. 流程设计

### 4.1 新的执行链路

1. `plus-checkout-create`
2. `paypal-checkout-flow`
3. 后续原有节点继续执行

### 4.2 `plus-checkout-create` 完成条件

节点完成条件改为：

- 已成功跳转到 PayPal；
- 已识别出当前 PayPal 阶段；
- 已把 PayPal 运行时上下文写入状态。

推荐阶段包括：

- `pay_login`
- `guest_checkout`
- `verification`
- `review_consent`
- `approval`

如果已经直接命中支付成功页，则可视为无需进入 `paypal-checkout-flow`，直接沿后续成功链路完成。

### 4.3 `paypal-checkout-flow` 接管逻辑

节点启动时读取：

- `paypalCheckoutTabId`
- `paypalCheckoutUrl`
- `paypalCheckoutStage`
- `paypalCheckoutEntrySource`
- hosted checkout 相关短信池/电话配置

然后根据 `paypalCheckoutStage` 分派动作：

- `pay_login`：填写邮箱/登录推进
- `guest_checkout`：填写卡资料、地址、电话
- `verification`：拉取验证码、提交验证码、失败重发
- `review_consent`：点击继续/确认
- `approval`：点击授权/付款

每轮动作后重新读取页面状态，直到：

- 进入成功页；
- 或进入下一已知 PayPal 阶段；
- 或判定链路失效。

## 5. 运行时状态设计

`plus-checkout-create` 在完成前写入以下字段：

- `paypalCheckoutTabId`
- `paypalCheckoutUrl`
- `paypalCheckoutStage`
- `paypalCheckoutEntrySource`

可选补充字段：

- `paypalCheckoutObservedAt`
- `paypalCheckoutAttemptId`

此外保留已有 hosted checkout 上下文，例如：

- `hostedCheckoutCurrentSmsEntry`
- `hostedCheckoutSmsPoolUsage`
- `hostedCheckoutPhoneNumber`
- `hostedCheckoutVerificationUrl`

`paypal-checkout-flow` 只消费这些状态，不重新承担 checkout 创建职责。

## 6. 失败与重试策略

### 6.1 PayPal 内部可恢复错误

以下错误由 `paypal-checkout-flow` 内部处理：

- 验证码提交失败；
- 需要 `Resend`；
- 拉到空验证码；
- 拉到重复验证码；
- review/continue 短时失败；
- 页面短时加载异常但 PayPal 链路仍在。

策略：

- 保持在 `paypal-checkout-flow` 内部重试；
- 不回退到 `plus-checkout-create`。

### 6.2 PayPal 链路失效错误

以下错误视为链路不可恢复：

- PayPal tab 丢失；
- 页面已不再属于当前支付链路；
- 回到非 PayPal / 非成功页的异常状态；
- checkout session 已失效，无法继续推进；
- 无法重新识别有效 PayPal 阶段。

策略：

- 回退到 `plus-checkout-create` 重新创建 checkout。

### 6.3 分层原则

- “支付链路仍在”则留在 `paypal-checkout-flow` 内重试；
- “支付链路已断”才回退到 `plus-checkout-create`。

## 7. 与现有分支的关系

### 7.1 Hosted checkout 自动化

当前 `plus-checkout-create` 内部的 hosted checkout PayPal 自动化需要迁移到 `paypal-checkout-flow`。

迁移后：

- `runHostedCheckoutOpenAiFlow()` 仍可留在 step 6；
- `runHostedCheckoutPayPalFlow()` 迁入新节点更合理；
- 验证码失败重发逻辑继续复用现有实现。

### 7.2 普通 PayPal 授权流

所有进入 PayPal 的后续流程统一由新节点处理，不再分散在 step 6 内部。

### 7.3 GPC Helper

GPC Helper 不进入 PayPal 页面，因此不进入 `paypal-checkout-flow`，仍由 `plus-checkout-create` 完成任务创建后直接结束。

## 8. UI / 日志 / 可观测性

### 8.1 节点展示

需要在节点定义与步骤展示中新增：

- `paypal-checkout-flow`

### 8.2 日志

日志需要从“步骤 6 大包大揽”改为：

- step 6 只记录 checkout 创建与跳 PayPal 前后的动作；
- 新节点记录 PayPal 内部动作、验证码、重发、review/approve、成功检测。

这样用户能直接看出：

- 是 checkout 没建出来；
- 还是 PayPal 内部链路卡住。

## 9. 测试设计

至少补充或迁移以下测试：

- `plus-checkout-create` 在跳到 PayPal 并识别阶段后即完成；
- `paypal-checkout-flow` 能从已有 `paypalCheckoutStage` 接管；
- 验证码失败重发逻辑在新节点内继续生效；
- PayPal 内部错误不会误回退到 step 6；
- PayPal tab 丢失 / session 失效时会回退到 `plus-checkout-create`；
- GPC Helper 路径不进入 `paypal-checkout-flow`。

## 10. 风险与约束

- 当前 PayPal 自动化逻辑分布在 `create-plus-checkout.js` 与 `content/paypal-flow.js`，迁移时要避免重复状态机；
- 节点拆分后，auto-run 的失败回退逻辑也要同步更新；
- 如果某些成功页直接跳过了典型 PayPal 阶段，需要允许 step 6 直接完成而不硬性进入新节点。

## 11. 结论

采用拆分方案：

- `plus-checkout-create` 只负责 checkout 创建并推进到 PayPal；
- 新增 `paypal-checkout-flow` 统一承接所有进入 PayPal 后的支付后续；
- 内部可恢复错误留在新节点内消化；
- 链路失效再回退重建 checkout。

这能显著降低 step 6 职责复杂度，并为后续 PayPal 自动化迭代提供更清晰的边界。
