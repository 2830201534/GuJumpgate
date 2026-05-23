# PayPal Checkout Flow Split Design

- 日期：2026-05-23
- 适用范围：`plus-checkout-create`、`paypal-checkout-flow`、`content/plus-checkout.js`、`content/paypal-flow.js`
- 目标：把步骤 6 收缩为“只创建长链并落到 hosted checkout 首页”，把 hosted checkout 页内动作与全部 PayPal 后续统一收口到步骤 7。

## 1. 背景

当前实现虽然已经把一部分 PayPal 后续从步骤 6 挪到了步骤 7，但边界仍然不对：

1. 步骤 6 仍在 hosted checkout 页面内执行 PayPal 切换、地址填写、验证码提交、点击提交；
2. 步骤 7 目前主要从 PayPal 页开始接管，而不是从 hosted checkout 首页开始；
3. 这会让“建链”和“支付执行”继续耦合在一起，日志与失败边界也会混杂。

用户确认后的目标边界更严格：

- 步骤 6 只负责创建 checkout 长链，并在浏览器实际落到 `pay.openai.com` / `checkout.stripe.com` 的 hosted checkout 首页后立即完成；
- 从 hosted checkout 首页开始，到 PayPal guest/card、验证码、review、approval、成功回跳，全部归步骤 7。

## 2. 目标与非目标

### 2.1 目标

- 把步骤 6 收缩为纯“建链并落地入口页”节点；
- 让步骤 7 从 hosted checkout 首页开始统一编排；
- 把 Stripe/OpenAI hosted checkout 页内地址填写也并入步骤 7；
- 让步骤 7 成为 hosted checkout 与 PayPal 的统一支付状态机；
- 保留现有验证码重发、重码检测、localStorage 持久化等增强逻辑；
- 明确“内部重试”“回退重建 checkout”“人工接管”三类失败处理。

### 2.2 非目标

- 不重写 PayPal 与 hosted checkout 的内容脚本基础能力；
- 不改动 GPC Helper 独立任务创建路径；
- 不在本次拆分中引入新的支付方式或新的节点顺序；
- 不把支付成功后的本地 JSON 导出逻辑并入本次设计。

## 3. 新的节点边界

### 3.1 步骤 6：`plus-checkout-create`

负责：

- 创建 checkout 长链；
- 打开 checkout URL；
- 等待页面真实落到 hosted checkout 首页；
- 持久化 hosted checkout 入口上下文；
- 到此立即完成。

不再负责：

- hosted checkout 页面内的 PayPal 方式切换；
- hosted checkout 地址填写；
- hosted checkout 验证码输入；
- hosted checkout 提交；
- 跳转到 PayPal；
- PayPal 登录、guest/card、验证码、review、approval；
- 成功回跳检测。

### 3.2 步骤 7：`paypal-checkout-flow`

负责：

- 从 hosted checkout 首页接管支付链路；
- 识别当前页面属于 hosted checkout、PayPal 或 success；
- 执行 hosted checkout 页面内动作；
- 执行 PayPal 全部后续动作；
- 持续推进直到成功、可恢复重试、不可恢复回退或人工接管。

## 4. 状态机设计

步骤 7 采用统一状态机，不再把“hosted checkout 页内动作”和“PayPal 动作”拆在两个节点。

### 4.1 状态枚举

- `hosted_openai_checkout`
- `hosted_openai_verification`
- `paypal_login`
- `paypal_guest_checkout`
- `paypal_verification`
- `paypal_review_consent`
- `paypal_approval`
- `payments_success`
- `lost_context`

### 4.2 状态语义

#### `hosted_openai_checkout`

表示当前仍位于 `pay.openai.com` / `checkout.stripe.com` 的 hosted checkout 页面。

需要执行：

- 切换 PayPal 支付方式；
- 填 hosted checkout 页内地址；
- 如存在 hosted 验证码弹窗则获取并填写验证码；
- 点击提交；
- 等待跳到 PayPal 或成功页。

#### `hosted_openai_verification`

表示 hosted checkout 页内出现 OpenAI/Stripe 的验证码弹窗。

需要执行：

- 按现有配置轮询验证码；
- 填写 6 位验证码；
- 返回 `hosted_openai_checkout` 的提交流程。

#### `paypal_login`

表示已进入 PayPal 登录页。

需要执行：

- 填写 PayPal 账号密码；
- 处理登录后的过渡页识别。

#### `paypal_guest_checkout`

表示已进入 PayPal guest/card 页面。

需要执行：

- 填卡资料；
- 填电话；
- 填 PayPal 账单地址；
- 提交到下一步。

#### `paypal_verification`

表示已进入 PayPal hosted 验证码弹窗。

需要执行：

- 拉取验证码；
- 如与浏览器 localStorage 中上次成功验证码一致，则先点 `Resend` 再拉新码；
- 提交验证码；
- 若提交后出现错误 xpath，则执行 `Resend -> 等 3 秒拉新码 -> 重码/空码再等 3 秒 -> 仍异常则报人工接管错误`。

#### `paypal_review_consent`

表示 PayPal 账单确认 / review 页面。

需要执行：

- 点击继续 / 同意。

#### `paypal_approval`

表示最终授权页。

需要执行：

- 点击最终授权按钮；
- 等待回跳成功页。

#### `payments_success`

表示已到 OpenAI/ChatGPT 支付成功页。

需要执行：

- 完成步骤 7。

#### `lost_context`

表示既不在 hosted checkout，也不在 PayPal，也不在 success。

需要执行：

- 判定当前支付链路失效；
- 回退到步骤 6 重建 checkout。

## 5. 页面脚本职责

不建议把内容脚本硬合并。背景统一编排，页面脚本继续按页面域分工。

### 5.1 `content/plus-checkout.js`

负责：

- hosted checkout 页面状态识别；
- PayPal 支付方式切换；
- hosted checkout 地址填写；
- hosted checkout 验证码填写；
- hosted checkout 提交。

### 5.2 `content/paypal-flow.js`

负责：

- PayPal 页面阶段识别；
- PayPal 登录；
- guest/card 填写；
- 验证码输入、Resend、错误 xpath 检测；
- review / approval 点击；
- localStorage 中上次成功验证码读写。

### 5.3 `background/steps/paypal-checkout-flow.js`

负责：

- 识别当前标签页是在 hosted checkout、PayPal 还是 success；
- 调用合适的内容脚本消息；
- 在 hosted checkout 与 PayPal 阶段之间切换；
- 管理超时、失败、回退与日志。

## 6. 运行时状态设计

### 6.1 步骤 6 完成时必须写入

- `plusCheckoutTabId`
- `plusCheckoutUrl`
- `plusHostedCheckoutEntryUrl`
- `plusCheckoutCountry`
- `plusCheckoutCurrency`
- `paypalCheckoutEntrySource = hosted-checkout`
- `paypalCheckoutGuestProfile`
- `hostedCheckoutCurrentSmsEntry`
- `hostedCheckoutPhoneNumber`
- `hostedCheckoutVerificationUrl`
- `hostedCheckoutVerificationPopupDelaySeconds`

注意：

- 步骤 6 不再写 `paypalCheckoutStage`；
- 因为此时还未进入 PayPal，也不应伪造 PayPal 阶段。

### 6.2 步骤 7 运行中持续更新

- `paypalCheckoutTabId`
- `paypalCheckoutUrl`
- `paypalCheckoutStage`
- `plusPaypalApprovedAt`
- hosted / PayPal 识别出的当前阶段诊断信息

### 6.3 本地存储

继续沿用浏览器 localStorage 记录上次成功的 PayPal hosted 验证码，用于：

- 第七步在验证码阶段判断是否与上次成功验证码重复；
- 提交成功后写入最新成功验证码；
- 页面报错或重发场景下避免重复提交旧码。

## 7. 失败处理策略

### 7.1 内部可恢复重试

以下问题不回退步骤 6，由步骤 7 内部消化：

- hosted checkout 页面短时加载慢；
- hosted checkout / PayPal 验证码接口短时无码；
- PayPal 页面短时切换；
- review / approval 按钮短时未出现；
- 第一次获取到的验证码为空；
- 获取到的验证码与上次成功验证码相同，但可通过 `Resend` 获取新码。

### 7.2 需要人工接管

以下问题直接停止并提示人工处理：

- `Resend` 按钮不存在；
- `Resend` 后 3 秒与 6 秒两次拉码仍为空；
- `Resend` 后两次拉码仍与上次成功验证码相同；
- 出现未知新验证页且当前自动化没有对应处理分支。

错误提示必须明确为：

- 需要手动输入验证码后再继续；
- 或需要人工处理当前 PayPal 页面。

### 7.3 需要回退到步骤 6

以下问题视为链路失效：

- 第七步启动后既不在 hosted checkout，也不在 PayPal，也不在 success；
- hosted checkout / PayPal 标签页丢失；
- 从 hosted checkout 离开后进入未知站点，且不是 OpenAI success；
- checkout session 已失效，无法继续推进；
- 页面结构变化导致当前阶段完全不可识别。

策略：

- 失败 `paypal-checkout-flow`；
- 将流程回退到 `plus-checkout-create` 重新建链。

## 8. 日志与可观测性

### 8.1 步骤 6 日志

只允许出现以下类别日志：

- 正在创建 checkout
- 正在打开 hosted checkout
- hosted checkout 首页已就绪
- 已持久化 hosted checkout 入口上下文

不应再出现：

- 切 PayPal
- 填地址
- 填验证码
- 提交支付
- 进入 PayPal 阶段

### 8.2 步骤 7 日志

需要覆盖：

- 当前识别到的页面阶段；
- hosted checkout 页内动作；
- PayPal 当前阶段与动作；
- 验证码获取、重发、重码判断；
- 回退步骤 6 或人工接管原因。

## 9. 测试设计

### 9.1 步骤 6 边界测试

必须验证 hosted 模式下步骤 6 只会：

- 创建 checkout；
- 打开 hosted checkout URL；
- 持久化 hosted checkout 入口状态；
- 完成节点。

必须禁止：

- `RUN_HOSTED_OPENAI_CHECKOUT_STEP`
- `PAYPAL_HOSTED_GET_STATE`
- `PAYPAL_RUN_HOSTED_CHECKOUT_STEP`

### 9.2 步骤 7 hosted 入口测试

必须新增：

- 第七步从 hosted checkout 首页启动；
- 第一个动作是识别并驱动 hosted checkout 页面；
- 然后才进入 PayPal。

### 9.3 步骤 7 PayPal 阶段测试

继续覆盖：

- `paypal_guest_checkout`
- `paypal_verification`
- `paypal_review_consent`
- `paypal_approval`

### 9.4 链路失效回退测试

必须覆盖：

- 第七步启动时上下文丢失；
- 从 hosted checkout / PayPal 跳到未知页；
- 应失败并回退到步骤 6。

### 9.5 验证码回归测试

保留并继续验证：

- xpath-only 错误判断；
- xpath-only `Resend` 点击；
- localStorage 成功验证码读写；
- 重码 / 空码两轮判定后报人工接管错误。

## 10. 风险与约束

- 当前 `create-plus-checkout.js` 仍残留一部分 hosted checkout 页内推进逻辑，必须整体后移到步骤 7；
- 现有测试大量假设“步骤 6 至少会推进到 PayPal”，这些断言都要同步改写；
- 第七步将变成统一支付编排器，必须控制好状态机分支，避免 hosted checkout 与 PayPal 阶段互相串线；
- 如果 OpenAI/Stripe 页面结构有变化，第七步 hosted 分支的识别需要有明确失败输出，而不是静默卡死。

## 11. 结论

采用统一编排方案：

- 步骤 6 只负责创建 checkout 长链，并在落到 hosted checkout 首页后立即完成；
- 步骤 7 从 hosted checkout 首页开始，统一处理 hosted checkout 页内动作与全部 PayPal 后续；
- 通过统一状态机、分层失败策略和现有验证码增强逻辑，实现更清晰、可恢复、可维护的支付链路。
