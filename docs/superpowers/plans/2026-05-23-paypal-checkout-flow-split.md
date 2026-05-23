# PayPal Checkout Flow Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把步骤 6 收缩为“只创建 checkout 长链并落到 hosted checkout 首页”，并让步骤 7 从 hosted checkout 首页开始统一完成 hosted checkout 页内动作与全部 PayPal 后续流程。

**Architecture:** `background/steps/create-plus-checkout.js` 只负责建链、打开 hosted checkout、写入入口上下文并结束。`background/steps/paypal-checkout-flow.js` 变成统一支付状态机，先识别当前页面在 hosted checkout、PayPal 还是 success，再分别调用 `content/plus-checkout.js` 或 `content/paypal-flow.js` 推进下一步。失败按“内部可恢复重试 / 人工接管 / 回退 step 6 重建 checkout”三层处理。

**Tech Stack:** Chrome Extension Manifest V3、background step executor、content script messaging、Node 内置测试框架 `node:test`

---

## File Structure

### Modify

- `background/steps/create-plus-checkout.js`
  - 删除 hosted checkout 页内推进逻辑，只保留建链与入口状态持久化。
- `background/steps/paypal-checkout-flow.js`
  - 扩展为统一支付编排器，新增 hosted checkout 页面识别与驱动。
- `content/plus-checkout.js`
  - 复用 hosted checkout 页面能力，必要时补充“识别当前 hosted 状态”和幂等动作返回。
- `content/paypal-flow.js`
  - 保持 PayPal 阶段处理，继续承载验证码 resend / xpath / localStorage 逻辑。
- `tests/plus-checkout-create-wait.test.js`
  - 改成验证步骤 6 只落 hosted checkout 首页，不触发任何 hosted/PayPal 动作。
- `tests/background-paypal-checkout-flow.test.js`
  - 改成验证步骤 7 从 hosted checkout 首页起步，进入 PayPal 并完成后续流程。
- `tests/paypal-flow-content.test.js`
  - 保留验证码重发、xpath-only、localStorage 相关回归。
- `tests/background-step-registry.test.js`
  - 确认步骤定义仍包含 `paypal-checkout-flow`。
- `tests/step-definitions-module.test.js`
  - 确认顺序仍是 step 6 后接 step 7。
- `tests/background-message-router-plus-final-step.test.js`
  - 确认失败回退逻辑仍把 `paypal-checkout-flow` 视为 checkout restart 节点。

## Task 1: 收缩步骤 6 到 Hosted Checkout 首页

**Files:**
- Modify: `background/steps/create-plus-checkout.js`
- Test: `tests/plus-checkout-create-wait.test.js`

- [ ] **Step 1: 写失败测试，锁定步骤 6 只允许落地 hosted checkout 首页**

```js
test('hosted plus checkout create stops at hosted checkout landing page', async () => {
  const createExecutor = loadExecutor();
  const events = [];
  const completed = [];
  const statePatches = [];

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 99 }),
        update: async () => ({ id: 99, url: 'https://pay.openai.com/c/pay/demo' }),
      },
    },
    completeNodeFromBackground: async (nodeId, payload) => {
      events.push({ type: 'complete', nodeId });
      completed.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async (_sourceId, tabId) => {
      events.push({ type: 'content-ready', tabId });
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ street: '1 Test St', city: 'Austin', state: 'Texas', zip: '78701' }),
    }),
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (_tabId, sourceId, message) => {
      events.push({ type: 'message', sourceId, messageType: message.type });
      if (sourceId === 'plus-checkout' && message.type === 'CREATE_PLUS_CHECKOUT') {
        return {
          checkoutUrl: 'https://pay.openai.com/c/pay/demo',
          country: 'US',
          currency: 'USD',
        };
      }
      throw new Error(`unexpected message ${sourceId}:${message.type}`);
    },
    setState: async (patch) => {
      events.push({ type: 'set-state', patch });
      statePatches.push(patch);
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({
    plusPaymentMethod: 'paypal',
    plusHostedCheckoutIsFinalStep: true,
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeId, 'plus-checkout-create');
  assert.equal(events.some((entry) => entry.messageType === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP'), false);
  assert.equal(events.some((entry) => entry.messageType === 'PAYPAL_HOSTED_GET_STATE'), false);
  assert.equal(events.some((entry) => entry.messageType === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP'), false);
  assert.equal(statePatches.some((patch) => patch.plusHostedCheckoutEntryUrl === 'https://pay.openai.com/c/pay/demo'), true);
  assert.equal(statePatches.some((patch) => Object.prototype.hasOwnProperty.call(patch, 'paypalCheckoutStage')), false);
});
```

- [ ] **Step 2: 跑测试确认先失败**

Run: `node --test tests/plus-checkout-create-wait.test.js`

Expected: FAIL，因为当前 step 6 还会发送 `RUN_HOSTED_OPENAI_CHECKOUT_STEP` 或尝试继续推进后续链路。

- [ ] **Step 3: 实现步骤 6 只落 hosted checkout 首页并写入口状态**

```js
const finalCheckoutUrl = String((landedTab?.url || targetCheckoutUrl || '')).trim();
const hostedEntryUrl = finalCheckoutUrl || targetCheckoutUrl;

await setState({
  plusCheckoutTabId: tabId,
  plusCheckoutUrl: finalCheckoutUrl,
  plusHostedCheckoutEntryUrl: hostedEntryUrl,
  plusCheckoutCountry: result.country || 'DE',
  plusCheckoutCurrency: result.currency || 'EUR',
  plusReturnUrl: '',
  plusCheckoutSource: targetCheckoutUrl === String(result?.convertedCheckoutUrl || '').trim()
    ? 'converted-chatgpt-checkout'
    : '',
  paypalCheckoutEntrySource: 'hosted-checkout',
  paypalCheckoutGuestProfile: buildHostedCheckoutGuestProfile(
    await fetchHostedCheckoutAddress(),
    await getHostedCheckoutRuntimeConfig({ ensureCurrentSmsEntry: true })
  ),
});

await addLog('步骤 6：hosted checkout 首页已就绪，后续支付动作将交给步骤 7。', 'ok');
await completeNodeFromBackground('plus-checkout-create', {
  plusCheckoutCountry: result.country || 'DE',
  plusCheckoutCurrency: result.currency || 'EUR',
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/plus-checkout-create-wait.test.js`

Expected: PASS，且不再有 hosted/PayPal 动作消息。

- [ ] **Step 5: 提交**

```bash
git add background/steps/create-plus-checkout.js tests/plus-checkout-create-wait.test.js
git commit -m "refactor: stop checkout creation at hosted entry"
```

## Task 2: 让步骤 7 从 Hosted Checkout 首页启动

**Files:**
- Modify: `background/steps/paypal-checkout-flow.js`
- Test: `tests/background-paypal-checkout-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定步骤 7 的第一个动作是驱动 hosted checkout 页面**

```js
test('paypal checkout flow starts from hosted checkout landing page before entering paypal', async () => {
  const createExecutor = loadPayPalExecutor();
  const calls = [];
  const completed = [];
  let currentUrl = 'https://pay.openai.com/c/pay/demo';

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => ({ id: 88, url: currentUrl, status: 'complete' }),
      },
    },
    completeNodeFromBackground: async (nodeId, payload) => {
      completed.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    getState: async () => ({
      paypalCheckoutGuestProfile: {
        address: { street: '1 Test St', city: 'Austin', state: 'Texas', zip: '78701' },
      },
    }),
    sendTabMessageUntilStopped: async (_tabId, sourceId, message) => {
      calls.push({ sourceId, message });
      if (sourceId === 'plus-checkout' && message.type === 'PLUS_CHECKOUT_GET_STATE') {
        return { hostedVerificationVisible: false };
      }
      if (sourceId === 'plus-checkout' && message.type === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP') {
        currentUrl = 'https://www.paypal.com/webapps/hermes?token=demo';
        return { submitted: true };
      }
      if (sourceId === 'paypal-flow' && message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return { hostedStage: 'review_consent', currentUrl };
      }
      if (sourceId === 'paypal-flow' && message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        currentUrl = 'https://chatgpt.com/payments/success';
        return { ok: true };
      }
      throw new Error(`unexpected ${sourceId}:${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher) => (
      matcher(currentUrl) ? { id: 88, url: currentUrl } : null
    ),
  });

  await executor.executePayPalCheckoutFlow({
    plusCheckoutTabId: 88,
    plusHostedCheckoutEntryUrl: 'https://pay.openai.com/c/pay/demo',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(calls[0].sourceId, 'plus-checkout');
  assert.equal(calls[0].message.type, 'PLUS_CHECKOUT_GET_STATE');
  assert.equal(calls.some((entry) => entry.message.type === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP'), true);
  assert.equal(calls.some((entry) => entry.message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP'), true);
});
```

- [ ] **Step 2: 跑测试确认先失败**

Run: `node --test tests/background-paypal-checkout-flow.test.js`

Expected: FAIL，因为当前步骤 7 还默认从 PayPal 阶段起步。

- [ ] **Step 3: 为步骤 7 增加 hosted checkout 页面识别与派发**

```js
function isHostedOpenAiCheckoutUrl(url = '') {
  return /^https:\/\/(?:pay\.openai\.com|checkout\.stripe\.com)\//i.test(String(url || ''));
}

async function readHostedCheckoutState(tabId) {
  const result = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
    type: 'PLUS_CHECKOUT_GET_STATE',
    source: 'background',
    payload: {},
  });
  if (result?.error) {
    throw new Error(result.error);
  }
  return result || {};
}

async function executeHostedCheckoutFlow(tabId, state = {}) {
  await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
    inject: ['content/utils.js', 'content/operation-delay.js', 'content/plus-checkout.js'],
    injectSource: PLUS_CHECKOUT_SOURCE,
    logMessage: '步骤 7：hosted checkout 页面仍在加载，等待脚本就绪...',
  });
  const pageState = await readHostedCheckoutState(tabId);
  const result = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
    type: 'RUN_HOSTED_OPENAI_CHECKOUT_STEP',
    source: 'background',
    payload: {
      address: state?.paypalCheckoutGuestProfile?.address || {},
      verificationCode: '',
      hostedVerificationVisible: pageState?.hostedVerificationVisible || false,
    },
  });
  if (result?.error) {
    throw new Error(result.error);
  }
}
```

- [ ] **Step 4: 在步骤 7 主循环中先判断 hosted checkout / PayPal / success**

```js
const currentTab = await chrome?.tabs?.get?.(tabId).catch(() => null);
const currentUrl = String(currentTab?.url || '').trim();
if (isPaymentsSuccessUrl(currentUrl)) {
  return;
}
if (isHostedOpenAiCheckoutUrl(currentUrl)) {
  await executeHostedCheckoutFlow(tabId, state);
  await sleepWithStop(1000);
  continue;
}
if (isPayPalUrl(currentUrl)) {
  await executeHostedPayPalFlow(tabId, state);
  return;
}
throw new Error('步骤 7：当前既不在 hosted checkout，也不在 PayPal 或 success 页面。');
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/background-paypal-checkout-flow.test.js`

Expected: PASS，且第一个动作来自 `plus-checkout`。

- [ ] **Step 6: 提交**

```bash
git add background/steps/paypal-checkout-flow.js tests/background-paypal-checkout-flow.test.js
git commit -m "feat: start paypal flow from hosted checkout"
```

## Task 3: 把 Hosted Checkout 验证码逻辑整体后移到步骤 7

**Files:**
- Modify: `background/steps/create-plus-checkout.js`
- Modify: `background/steps/paypal-checkout-flow.js`
- Test: `tests/background-paypal-checkout-flow.test.js`

- [ ] **Step 1: 写失败测试，锁定 hosted checkout 验证码只允许在步骤 7 处理**

```js
test('hosted checkout verification is handled by step 7 instead of step 6', async () => {
  const createExecutor = loadExecutor();
  const createMessages = [];

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 99 }),
        update: async () => ({ id: 99, url: 'https://pay.openai.com/c/pay/demo' }),
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ street: '1 Test St', city: 'Austin', state: 'Texas', zip: '78701' }),
    }),
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (_tabId, sourceId, message) => {
      createMessages.push({ sourceId, message });
      if (sourceId === 'plus-checkout' && message.type === 'CREATE_PLUS_CHECKOUT') {
        return {
          checkoutUrl: 'https://pay.openai.com/c/pay/demo',
          country: 'US',
          currency: 'USD',
        };
      }
      throw new Error(`unexpected message ${sourceId}:${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({
    plusPaymentMethod: 'paypal',
    plusHostedCheckoutIsFinalStep: true,
  });

  assert.equal(createMessages.some((entry) => entry.message.type === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP'), false);
});
```

- [ ] **Step 2: 从步骤 6 删除 `runHostedCheckoutOpenAiFlow()` 的实际调用**

```js
if (shouldWaitForHostedCheckoutSuccess(state, paymentMethod)) {
  await addLog('步骤 6：hosted checkout 首页已就绪，已将页内动作移交步骤 7。', 'info');
  await completeNodeFromBackground('plus-checkout-create', {
    plusCheckoutCountry: result.country || 'DE',
    plusCheckoutCurrency: result.currency || 'EUR',
  });
  return;
}
```

- [ ] **Step 3: 在步骤 7 hosted 分支补 hosted 验证码处理**

```js
if (pageState?.hostedVerificationVisible) {
  const verificationCode = await pollHostedVerificationCode(mergedState);
  const verifyResult = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
    type: 'RUN_HOSTED_OPENAI_CHECKOUT_STEP',
    source: 'background',
    payload: {
      address: mergedState?.paypalCheckoutGuestProfile?.address || {},
      verificationCode,
    },
  });
  if (verifyResult?.error) {
    throw new Error(verifyResult.error);
  }
}
```

- [ ] **Step 4: 跑相关测试**

Run: `node --test tests/plus-checkout-create-wait.test.js tests/background-paypal-checkout-flow.test.js`

Expected: PASS，且 hosted 验证码不再由步骤 6 处理。

- [ ] **Step 5: 提交**

```bash
git add background/steps/create-plus-checkout.js background/steps/paypal-checkout-flow.js tests/plus-checkout-create-wait.test.js tests/background-paypal-checkout-flow.test.js
git commit -m "refactor: move hosted verification into paypal flow"
```

## Task 4: 保持 PayPal 后续状态机与验证码增强逻辑可用

**Files:**
- Modify: `background/steps/paypal-checkout-flow.js`
- Modify: `content/paypal-flow.js`
- Test: `tests/background-paypal-checkout-flow.test.js`
- Test: `tests/paypal-flow-content.test.js`

- [ ] **Step 1: 保留并补足 PayPal 阶段测试**

```js
test('paypal checkout flow resends verification code when fetched code matches stored browser code', async () => {
  // 保留现有 duplicate-code -> resend -> fresh-code 断言
});

test('paypal checkout flow stops with manual input error when resend still returns duplicate code', async () => {
  // 保留现有 duplicate-code double-failure 断言
});

test('hosted paypal checkout flow clicks approve during approval stage', async () => {
  // 保留现有 approval 点击断言
});
```

- [ ] **Step 2: 跑测试确认现状**

Run: `node --test tests/background-paypal-checkout-flow.test.js tests/paypal-flow-content.test.js`

Expected: 如果 hosted 分支改动引入回归，这里会先暴露出来。

- [ ] **Step 3: 收敛步骤 7 的页面切换逻辑，避免 hosted / paypal 串线**

```js
if (isHostedOpenAiCheckoutUrl(currentUrl)) {
  await setState({ paypalCheckoutStage: 'hosted_openai_checkout' });
  await executeHostedCheckoutFlow(tabId, mergedState);
  continue;
}

if (isPayPalUrl(currentUrl)) {
  await executeHostedPayPalFlow(tabId, mergedState);
  return;
}

if (isOpenAiReturnUrl(currentUrl) && !isPayPalUrl(currentUrl)) {
  return;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/background-paypal-checkout-flow.test.js tests/paypal-flow-content.test.js`

Expected: PASS，原有 resend/xpath/localStorage 行为不变。

- [ ] **Step 5: 提交**

```bash
git add background/steps/paypal-checkout-flow.js content/paypal-flow.js tests/background-paypal-checkout-flow.test.js tests/paypal-flow-content.test.js
git commit -m "refactor: preserve paypal retry flow after hosted split"
```

## Task 5: 同步步骤定义、回退逻辑与最终回归

**Files:**
- Modify: `tests/background-step-registry.test.js`
- Modify: `tests/step-definitions-module.test.js`
- Modify: `tests/background-message-router-plus-final-step.test.js`

- [ ] **Step 1: 写/改断言，锁定步骤顺序与回退关系**

```js
test('step definitions expose paypal checkout flow after plus checkout create', () => {
  const defs = loadStepDefinitions();
  const createIndex = defs.findIndex((step) => step.key === 'plus-checkout-create');
  const flowIndex = defs.findIndex((step) => step.key === 'paypal-checkout-flow');
  assert.ok(createIndex !== -1);
  assert.ok(flowIndex !== -1);
  assert.equal(flowIndex, createIndex + 1);
});

test('background auto-run restart logic treats paypal-checkout-flow as checkout restart node', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /'paypal-checkout-flow'/);
});
```

- [ ] **Step 2: 跑轻量注册测试**

Run: `node --test tests/background-step-registry.test.js tests/step-definitions-module.test.js tests/background-message-router-plus-final-step.test.js`

Expected: PASS，若节点注册或回退配置不一致会直接失败。

- [ ] **Step 3: 跑完整回归**

Run: `node --test tests/plus-checkout-create-wait.test.js tests/background-paypal-checkout-flow.test.js tests/paypal-flow-content.test.js tests/background-step-registry.test.js tests/step-definitions-module.test.js tests/background-plus-checkout-billing-paypal-state.test.js tests/background-message-router-plus-final-step.test.js`

Expected: PASS，所有核心路径、失败路径、验证码增强与节点编排全部通过。

- [ ] **Step 4: 提交**

```bash
git add tests/background-step-registry.test.js tests/step-definitions-module.test.js tests/background-message-router-plus-final-step.test.js
git commit -m "test: align checkout step sequencing with hosted split"
```

## Self-Review

- Spec coverage:
  - 步骤 6 只落 hosted checkout 首页：Task 1、Task 3
  - 步骤 7 从 hosted checkout 首页统一接管：Task 2
  - hosted checkout 地址/验证码并入步骤 7：Task 2、Task 3
  - PayPal 后续与验证码增强保留：Task 4
  - 节点顺序、回退和回归：Task 5
- Placeholder scan:
  - 已检查，无 `TODO/TBD/implement later` 类占位。
- Type consistency:
  - 统一使用 `plusHostedCheckoutEntryUrl`、`paypalCheckoutEntrySource`、`RUN_HOSTED_OPENAI_CHECKOUT_STEP`、`PAYPAL_RUN_HOSTED_CHECKOUT_STEP`。
