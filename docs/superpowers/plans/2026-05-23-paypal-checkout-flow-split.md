# PayPal Checkout Flow Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `plus-checkout-create` 中的 PayPal 后续支付处理拆分为独立的 `paypal-checkout-flow` 节点，让 checkout 创建与 PayPal 执行链路解耦。

**Architecture:** 保留 `plus-checkout-create` 负责创建 checkout、打开支付页并推进到 PayPal；新增 `paypal-checkout-flow` 负责所有进入 PayPal 后的登录、guest/card、验证码、review/approve 与成功检测。两者通过新的运行时状态字段衔接，并按“链路仍在则内部重试、链路已断则回退 step 6”的原则处理失败。

**Tech Stack:** Chrome Extension Manifest V3、background step executor、content script messaging、Node 内置测试框架 `node:test`

---

## File Structure

### Create

- `background/steps/paypal-checkout-flow.js`
  - 新的后台节点执行器，统一承接 PayPal 后续链路。
- `tests/background-paypal-checkout-flow.test.js`
  - 新节点的单元测试，覆盖阶段接管、验证码恢复、回退策略。

### Modify

- `background/steps/create-plus-checkout.js`
  - 缩减 step 6 职责，只推进到 PayPal 并写入上下文状态。
- `background.js`
  - 注册新节点执行器、节点顺序、失败回退和 auto-run 衔接。
- `content/paypal-flow.js`
  - 如需补充阶段识别或幂等消息协议，统一在这里扩展。
- `sidepanel/sidepanel.js`
  - 如步骤元数据来自 sidepanel，本文件需同步节点定义展示。
- `sidepanel/sidepanel.html`
  - 若步骤列表是静态渲染，需补充新节点展示。
- `tests/plus-checkout-create-wait.test.js`
  - 调整 step 6 完成条件，验证“跳到 PayPal 并识别阶段即完成”。
- `tests/paypal-flow-content.test.js`
  - 如 content script 需要增加阶段识别/动作协议，补相应断言。
- `tests/background-message-router-plus-final-step.test.js`
  - 如消息路由或最终步骤注册依赖节点列表，补同步断言。
- `tests/background-step-registry.test.js`
  - 节点注册顺序和 id 变更后的回归。
- `tests/step-definitions-module.test.js`
  - 步骤定义列表新增 `paypal-checkout-flow` 后的回归。

## Task 1: Split Step 6 Completion At PayPal Entry

**Files:**
- Modify: `background/steps/create-plus-checkout.js`
- Test: `tests/plus-checkout-create-wait.test.js`

- [ ] **Step 1: Write the failing test for step 6 completing after PayPal stage detection**

```js
test('plus checkout create completes once paypal stage is detected', async () => {
  const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)({});
  const completed = [];
  const statePatches = [];

  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 99 }),
        update: async () => ({ id: 99, url: 'https://www.paypal.com/pay' }),
      },
    },
    completeNodeFromBackground: async (nodeId, payload) => {
      completed.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (tabId, sourceId, message) => {
      if (sourceId === 'plus-checkout' && message.type === 'CREATE_PLUS_CHECKOUT') {
        return {
          checkoutUrl: 'https://pay.openai.com/c/pay/demo',
          country: 'US',
          currency: 'USD',
        };
      }
      if (sourceId === 'paypal-flow' && message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return {
          hostedStage: 'guest_checkout',
        };
      }
      throw new Error(`unexpected message ${sourceId}:${message.type}`);
    },
    setState: async (patch) => {
      statePatches.push(patch);
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => ({ id: 99, url: 'https://www.paypal.com/pay' }),
  });

  await executor.executePlusCheckoutCreate({
    plusPaymentMethod: 'paypal',
    plusHostedCheckoutIsFinalStep: false,
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeId, 'plus-checkout-create');
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutStage === 'guest_checkout'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/plus-checkout-create-wait.test.js`

Expected: FAIL because step 6 still completes around checkout readiness instead of explicitly persisting `paypalCheckoutStage`.

- [ ] **Step 3: Implement PayPal entry completion in step 6**

```js
async function detectPayPalStageAfterRedirect(tabId) {
  await ensureContentScriptReadyOnTabUntilStopped(tabId, PAYPAL_SOURCE, {
    inject: PAYPAL_INJECT_FILES,
    injectSource: PAYPAL_SOURCE,
    logMessage: '步骤 6：正在识别 PayPal 当前阶段...',
  });
  const state = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
    type: 'PAYPAL_HOSTED_GET_STATE',
    source: 'background',
    payload: {},
  });
  const stage = String(state?.hostedStage || state?.stage || '').trim();
  if (!stage || stage === 'unknown' || stage === 'outside_paypal') {
    throw new Error('步骤 6：已进入 PayPal，但未识别出有效阶段。');
  }
  return {
    stage,
    state,
  };
}

const paypalStage = await detectPayPalStageAfterRedirect(tabId);
await setState({
  plusCheckoutTabId: tabId,
  plusCheckoutUrl: finalCheckoutUrl,
  paypalCheckoutTabId: tabId,
  paypalCheckoutUrl: String(landedTab?.url || finalCheckoutUrl || '').trim(),
  paypalCheckoutStage: paypalStage.stage,
  paypalCheckoutEntrySource: 'plus-checkout-create',
});
await completeNodeFromBackground('plus-checkout-create', completionPayload);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/plus-checkout-create-wait.test.js`

Expected: PASS with `paypalCheckoutStage` persisted before step 6 completion.

- [ ] **Step 5: Commit**

```bash
git add background/steps/create-plus-checkout.js tests/plus-checkout-create-wait.test.js
git commit -m "refactor: complete plus checkout create at paypal entry"
```

## Task 2: Add The `paypal-checkout-flow` Background Step

**Files:**
- Create: `background/steps/paypal-checkout-flow.js`
- Test: `tests/background-paypal-checkout-flow.test.js`

- [ ] **Step 1: Write the failing tests for PayPal stage takeover and success completion**

```js
test('paypal checkout flow resumes from stored paypal stage and completes on success url', async () => {
  const source = fs.readFileSync('background/steps/paypal-checkout-flow.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundPayPalCheckoutFlow;`)({});
  const completed = [];
  const calls = [];

  const executor = api.createPayPalCheckoutFlowExecutor({
    addLog: async () => {},
    completeNodeFromBackground: async (nodeId, payload) => {
      completed.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    sendTabMessageUntilStopped: async (tabId, sourceId, message) => {
      calls.push({ tabId, sourceId, message });
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return {
          hostedStage: 'review_consent',
          currentUrl: 'https://www.paypal.com/webapps/hermes',
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        return {
          ok: true,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    waitForTabUrlMatchUntilStopped: async () => ({
      id: 88,
      url: 'https://chatgpt.com/payments/success',
    }),
    sleepWithStop: async () => {},
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'review_consent',
    plusCheckoutCountry: 'US',
    plusCheckoutCurrency: 'USD',
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeId, 'paypal-checkout-flow');
  assert.equal(calls.some((entry) => entry.message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP'), true);
});

test('paypal checkout flow requests step 6 restart when paypal context is lost', async () => {
  const source = fs.readFileSync('background/steps/paypal-checkout-flow.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundPayPalCheckoutFlow;`)({});
  const failed = [];

  const executor = api.createPayPalCheckoutFlowExecutor({
    addLog: async () => {},
    failNodeFromBackground: async (nodeId, message) => {
      failed.push({ nodeId, message });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    sendTabMessageUntilStopped: async () => ({
      hostedStage: 'outside_paypal',
      currentUrl: 'https://chatgpt.com/',
    }),
    sleepWithStop: async () => {},
  });

  await assert.rejects(
    () => executor.executePayPalCheckoutFlow({
      paypalCheckoutTabId: 88,
      paypalCheckoutStage: 'guest_checkout',
    }),
    /回退到节点 plus-checkout-create/
  );

  assert.equal(failed.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/background-paypal-checkout-flow.test.js`

Expected: FAIL because the new module and executor do not exist yet.

- [ ] **Step 3: Implement the new background executor**

```js
(function attachBackgroundPayPalCheckoutFlow(root, factory) {
  root.MultiPageBackgroundPayPalCheckoutFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPayPalCheckoutFlowModule() {
  const PAYPAL_SOURCE = 'paypal-flow';
  const PAYPAL_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/paypal-flow.js'];
  const PAYPAL_SUCCESS_URL_PATTERN = /^https:\/\/(?:chatgpt\.com|www\.chatgpt\.com|chat\.openai\.com)\/(?:backend-api\/)?payments\/success(?:[/?#]|$)/i;

  function createPayPalCheckoutFlowExecutor(deps = {}) {
    const {
      addLog = async () => {},
      completeNodeFromBackground,
      ensureContentScriptReadyOnTabUntilStopped = async () => {},
      failNodeFromBackground = async () => {},
      sendTabMessageUntilStopped = async () => ({}),
      sleepWithStop = async () => {},
      waitForTabUrlMatchUntilStopped = null,
    } = deps;

    async function readPayPalState(tabId) {
      await ensureContentScriptReadyOnTabUntilStopped(tabId, PAYPAL_SOURCE, {
        inject: PAYPAL_INJECT_FILES,
        injectSource: PAYPAL_SOURCE,
        logMessage: '步骤 7：正在识别 PayPal 当前阶段...',
      });
      return sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_HOSTED_GET_STATE',
        source: 'background',
        payload: {},
      });
    }

    async function executePayPalCheckoutFlow(state = {}) {
      const tabId = Number(state?.paypalCheckoutTabId);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        throw new Error('步骤 7：缺少 PayPal 标签页上下文，无法继续支付流程。');
      }

      while (true) {
        const paypalState = await readPayPalState(tabId);
        const stage = String(paypalState?.hostedStage || '').trim();
        if (!stage || stage === 'outside_paypal' || stage === 'unknown') {
          const message = '步骤 7：PayPal 支付链路已失效，准备回退到节点 plus-checkout-create 重新创建 Checkout。';
          await failNodeFromBackground('paypal-checkout-flow', message);
          throw new Error(message);
        }

        await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
          type: 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP',
          source: 'background',
          payload: {
            stage,
          },
        });

        const successTab = typeof waitForTabUrlMatchUntilStopped === 'function'
          ? await waitForTabUrlMatchUntilStopped(tabId, (url) => PAYPAL_SUCCESS_URL_PATTERN.test(String(url || '')), 2000, 200)
              .catch(() => null)
          : null;
        if (successTab?.url) {
          await completeNodeFromBackground('paypal-checkout-flow', {
            plusCheckoutCountry: state?.plusCheckoutCountry || '',
            plusCheckoutCurrency: state?.plusCheckoutCurrency || '',
          });
          return;
        }

        await sleepWithStop(1000);
      }
    }

    return { executePayPalCheckoutFlow };
  }

  return { createPayPalCheckoutFlowExecutor };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/background-paypal-checkout-flow.test.js`

Expected: PASS with takeover and lost-context fallback covered.

- [ ] **Step 5: Commit**

```bash
git add background/steps/paypal-checkout-flow.js tests/background-paypal-checkout-flow.test.js
git commit -m "feat: add paypal checkout flow step"
```

## Task 3: Register The New Step In Background And Step Definitions

**Files:**
- Modify: `background.js`
- Modify: `sidepanel/sidepanel.js`
- Test: `tests/background-step-registry.test.js`
- Test: `tests/step-definitions-module.test.js`

- [ ] **Step 1: Write the failing tests for node registration and ordering**

```js
test('background step registry includes paypal-checkout-flow after plus-checkout-create', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /'plus-checkout-create': .*executePlusCheckoutCreate/);
  assert.match(source, /'paypal-checkout-flow': .*executePayPalCheckoutFlow/);
});

test('step definitions expose paypal checkout flow in plus mode sequence', () => {
  const source = fs.readFileSync('shared/step-definitions.js', 'utf8');
  assert.match(source, /paypal-checkout-flow/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/background-step-registry.test.js tests/step-definitions-module.test.js`

Expected: FAIL because `paypal-checkout-flow` is not registered or exposed yet.

- [ ] **Step 3: Register the node and step definition**

```js
const payPalCheckoutFlowExecutor = globalThis.MultiPageBackgroundPayPalCheckoutFlow?.createPayPalCheckoutFlowExecutor?.({
  addLog,
  completeNodeFromBackground,
  ensureContentScriptReadyOnTabUntilStopped,
  failNodeFromBackground,
  sendTabMessageUntilStopped,
  sleepWithStop,
  waitForTabUrlMatchUntilStopped,
});

const nodeExecutors = {
  // ...
  'plus-checkout-create': (state) => plusCheckoutCreateExecutor.executePlusCheckoutCreate(state),
  'paypal-checkout-flow': (state) => payPalCheckoutFlowExecutor.executePayPalCheckoutFlow(state),
};
```

```js
{
  step: 7,
  nodeId: 'paypal-checkout-flow',
  label: 'PayPal 支付后续',
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/background-step-registry.test.js tests/step-definitions-module.test.js`

Expected: PASS with the new node visible in registry and step definitions.

- [ ] **Step 5: Commit**

```bash
git add background.js sidepanel/sidepanel.js tests/background-step-registry.test.js tests/step-definitions-module.test.js
git commit -m "feat: register paypal checkout flow step"
```

## Task 4: Move PayPal Automation Ownership From Step 6 To The New Step

**Files:**
- Modify: `background/steps/create-plus-checkout.js`
- Modify: `background/steps/paypal-checkout-flow.js`
- Modify: `content/paypal-flow.js`
- Test: `tests/paypal-flow-content.test.js`
- Test: `tests/plus-checkout-create-wait.test.js`
- Test: `tests/background-paypal-checkout-flow.test.js`

- [ ] **Step 1: Write failing tests for stage-based dispatch**

```js
test('paypal checkout flow dispatches login stage through paypal content script', async () => {
  // assert PAYPAL_RUN_HOSTED_CHECKOUT_STEP payload carries stage-specific state
});

test('plus checkout create no longer runs paypal hosted automation inline', async () => {
  // assert startHostedCheckoutAutomation is not used to finish the node
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/background-paypal-checkout-flow.test.js tests/plus-checkout-create-wait.test.js tests/paypal-flow-content.test.js`

Expected: FAIL because stage ownership is still partly in step 6.

- [ ] **Step 3: Move PayPal flow control to the new step**

```js
// create-plus-checkout.js
if (isPaymentsSuccessUrl(transitionUrl)) {
  await completeNodeFromBackground('plus-checkout-create', completionPayload);
  return;
}

const paypalStage = await detectPayPalStageAfterRedirect(tabId);
await setState({
  paypalCheckoutTabId: tabId,
  paypalCheckoutUrl: transitionUrl,
  paypalCheckoutStage: paypalStage.stage,
  paypalCheckoutEntrySource: 'hosted-checkout',
  hostedCheckoutCurrentSmsEntry: runtimeConfig.hostedCheckoutCurrentSmsEntry || null,
});
await completeNodeFromBackground('plus-checkout-create', completionPayload);
```

```js
// paypal-checkout-flow.js
await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
  type: 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP',
  source: 'background',
  payload: {
    stage,
    phone: state?.hostedCheckoutPhoneNumber || '',
    verificationUrl: state?.hostedCheckoutVerificationUrl || '',
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/background-paypal-checkout-flow.test.js tests/plus-checkout-create-wait.test.js tests/paypal-flow-content.test.js`

Expected: PASS with PayPal stage ownership fully moved to the new node.

- [ ] **Step 5: Commit**

```bash
git add background/steps/create-plus-checkout.js background/steps/paypal-checkout-flow.js content/paypal-flow.js tests/background-paypal-checkout-flow.test.js tests/plus-checkout-create-wait.test.js tests/paypal-flow-content.test.js
git commit -m "refactor: move paypal automation into dedicated step"
```

## Task 5: Wire Failure Recovery Back To `plus-checkout-create`

**Files:**
- Modify: `background.js`
- Modify: `background/steps/paypal-checkout-flow.js`
- Test: `tests/background-paypal-checkout-flow.test.js`
- Test: `tests/background-message-router-plus-final-step.test.js`

- [ ] **Step 1: Write failing tests for rollback on lost PayPal context**

```js
test('auto run resets downstream nodes and returns to plus-checkout-create when paypal context is lost', async () => {
  // assert nodeIndex jumps back to plus-checkout-create on paypal-checkout-flow failure
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/background-paypal-checkout-flow.test.js tests/background-message-router-plus-final-step.test.js`

Expected: FAIL because auto-run restart logic does not yet know about `paypal-checkout-flow`.

- [ ] **Step 3: Add restart mapping for the new node**

```js
if ((executionKey || nodeId) === 'paypal-checkout-flow') {
  const checkoutRestartCount = incrementCheckoutRestartCount();
  await invalidateDownstreamAfterAutoRunNodeRestart('plus-checkout-create', {
    logLabel: `节点 ${nodeId} PayPal 链路失效后准备回到 plus-checkout-create 重试（第 ${checkoutRestartCount} 次）`,
  });
  nodeIndex = Math.max(0, getNodeIndex(await getState(), 'plus-checkout-create'));
  continue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/background-paypal-checkout-flow.test.js tests/background-message-router-plus-final-step.test.js`

Expected: PASS with rollback behavior covered.

- [ ] **Step 5: Commit**

```bash
git add background.js background/steps/paypal-checkout-flow.js tests/background-paypal-checkout-flow.test.js tests/background-message-router-plus-final-step.test.js
git commit -m "fix: restart checkout create when paypal flow context is lost"
```

## Task 6: Final Regression Pass

**Files:**
- Modify as needed based on failures in previous tasks

- [ ] **Step 1: Run the focused PayPal + checkout regression suite**

Run:

```bash
node --test tests/plus-checkout-create-wait.test.js tests/background-paypal-checkout-flow.test.js tests/paypal-flow-content.test.js tests/background-step-registry.test.js tests/step-definitions-module.test.js tests/background-message-router-plus-final-step.test.js
```

Expected: PASS

- [ ] **Step 2: Run the broader Plus / PayPal regression suite**

Run:

```bash
node --test tests/plus-checkout-create-wait.test.js tests/paypal-flow-content.test.js tests/background-paypal-checkout-flow.test.js tests/background-message-router-plus-final-step.test.js tests/background-step-registry.test.js tests/step-definitions-module.test.js tests/hosted-checkout-timeout.test.js tests/background-contribution-mode.test.js tests/sidepanel-contribution-mode.test.js
```

Expected: PASS

- [ ] **Step 3: Commit any final fixes**

```bash
git add background.js background/steps/create-plus-checkout.js background/steps/paypal-checkout-flow.js content/paypal-flow.js sidepanel/sidepanel.js tests/plus-checkout-create-wait.test.js tests/background-paypal-checkout-flow.test.js tests/paypal-flow-content.test.js tests/background-message-router-plus-final-step.test.js tests/background-step-registry.test.js tests/step-definitions-module.test.js
git commit -m "test: finalize paypal checkout flow split regression coverage"
```
