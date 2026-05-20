# PayPal Hosted Verification Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 hosted checkout 的 PayPal 验证码阶段增加旧码预判、错误提示检测、自动 `Resend`、二次取码恢复，以及最终失败时的明确提示与节点失败语义。

**Architecture:** 保持现有“后台编排 + 页面脚本执行 DOM”模式不变。`background/steps/create-plus-checkout.js` 负责取码、存储、重试和失败终止；`content/paypal-flow.js` 只补充验证码失败检测和 `Resend` 点击能力；测试分别落在内容脚本测试与 hosted checkout 后台步骤测试里。

**Tech Stack:** Chrome MV3 extension, plain JavaScript, `chrome.storage.local`, Node built-in test runner (`node --test`)

---

## File Structure

- Modify: `content/paypal-flow.js`
  - 新增 hosted verification 失败检测与 `Resend` DOM 操作
  - 扩展 `runHostedCheckoutStep(payload)` 支持检查失败态与点击 `Resend`
- Modify: `background/steps/create-plus-checkout.js`
  - 新增最近成功验证码的本地存储读写
  - 在 hosted verification 分支增加旧码预判、提交后 5 秒检查、自动 `Resend`、最多两轮重拉
- Modify: `tests/paypal-flow-content.test.js`
  - 为错误块识别、`Resend` 点击、验证码输入能力补单测
- Modify: `tests/plus-checkout-create-wait.test.js`
  - 增加 hosted verification 恢复链路的后台编排测试
- Modify: `docs/superpowers/plans/2026-05-20-paypal-hosted-verification-retry.md`
  - 本文件，仅在实现过程中更新勾选状态时改动

### Task 1: 为 PayPal 页面脚本补齐失败检测与 Resend 能力

**Files:**
- Modify: `content/paypal-flow.js`
- Test: `tests/paypal-flow-content.test.js`

- [ ] **Step 1: 在 `tests/paypal-flow-content.test.js` 里写失败检测与 Resend 的失败用例**

```js
test('PayPal hosted checkout verification failure detection matches target message block', () => {
  const errorBlock = createElement({
    textContent: 'Sorry, something went wrong. Get a new code.',
  });
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
  });

  setDomState({
    hostedVerificationErrorBlock: errorBlock,
    hostedVerificationResendButton: resendButton,
  });

  const result = api.detectHostedVerificationFailure();

  assert.equal(result.visible, true);
  assert.equal(result.messageMatched, true);
  assert.equal(result.resendAvailable, true);
});

test('PayPal hosted checkout resend clicks target button', async () => {
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
  });
  let clicked = 0;
  resendButton.click = () => {
    clicked += 1;
  };

  setDomState({
    hostedVerificationResendButton: resendButton,
  });

  const result = await api.clickHostedVerificationResend();

  assert.equal(result.clicked, true);
  assert.equal(clicked, 1);
});

test('PayPal hosted checkout runHostedCheckoutStep can return verification failure state without submitting code', async () => {
  const errorBlock = createElement({
    textContent: 'Sorry, something went wrong. Get a new code.',
  });
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
  });
  const verificationInputs = Array.from({ length: 6 }, () => createElement({
    tagName: 'input',
    value: '',
  }));

  setDomState({
    hostedStage: 'verification',
    hostedVerificationErrorBlock: errorBlock,
    hostedVerificationResendButton: resendButton,
    hostedVerificationInputs: verificationInputs,
  });

  const result = await api.runHostedCheckoutStep({
    action: 'check-verification-failure',
  });

  assert.equal(result.stage, 'verification');
  assert.equal(result.verificationFailed, true);
  assert.equal(result.resendAvailable, true);
});
```

- [ ] **Step 2: 运行内容脚本测试，确认新用例先失败**

Run:

```bash
node --test tests/paypal-flow-content.test.js
```

Expected:

```text
not ok ... detectHostedVerificationFailure is not a function
not ok ... clickHostedVerificationResend is not a function
```

- [ ] **Step 3: 在 `content/paypal-flow.js` 增加最小实现**

```js
const PAYPAL_HOSTED_VERIFICATION_ERROR_TEXT = 'Sorry, something went wrong. Get a new code.';

function findHostedVerificationErrorBlock() {
  const candidates = Array.from(document.querySelectorAll('div, section, p, span'))
    .filter((el) => isVisibleElement(el));
  return candidates.find((el) => normalizeText(el.textContent || '').includes(PAYPAL_HOSTED_VERIFICATION_ERROR_TEXT)) || null;
}

function findHostedVerificationResendButton() {
  return findClickableByText([
    /^resend$/i,
    /resend/i,
  ]);
}

function detectHostedVerificationFailure() {
  const errorBlock = findHostedVerificationErrorBlock();
  const resendButton = findHostedVerificationResendButton();
  const messageText = normalizeText(errorBlock?.textContent || '');
  return {
    visible: Boolean(errorBlock),
    messageMatched: messageText.includes(PAYPAL_HOSTED_VERIFICATION_ERROR_TEXT),
    resendAvailable: Boolean(resendButton && isEnabledControl(resendButton)),
    messageText,
  };
}

async function clickHostedVerificationResend() {
  await waitForDocumentComplete();
  const resendButton = findHostedVerificationResendButton();
  if (!resendButton) {
    throw new Error('PayPal hosted checkout 当前页面未找到 Resend 按钮。');
  }
  dispatchHostedGenericClick(resendButton);
  return {
    clicked: true,
    text: normalizeText(resendButton.textContent || ''),
  };
}
```

- [ ] **Step 4: 扩展 `runHostedCheckoutStep(payload)` 支持两个子动作**

```js
async function runHostedCheckoutStep(payload = {}) {
  if (isPayPalHostedReviewPage()) {
    return clickHostedReviewConsent();
  }
  const stage = detectPayPalHostedCheckoutStage();
  if (stage === PAYPAL_HOSTED_STAGE_VERIFICATION) {
    if (payload.action === 'check-verification-failure') {
      const failure = detectHostedVerificationFailure();
      return {
        stage,
        verificationFailed: Boolean(failure.visible && failure.messageMatched),
        resendAvailable: Boolean(failure.resendAvailable),
        failureMessage: failure.messageText,
      };
    }
    if (payload.action === 'click-verification-resend') {
      const resendResult = await clickHostedVerificationResend();
      return {
        stage,
        ...resendResult,
      };
    }
    if (!payload.verificationCode && !payload.code) {
      return {
        stage,
        requiresVerificationCode: true,
      };
    }
    return fillHostedVerificationCode(payload);
  }
  // 保持现有其它分支不变
}
```

- [ ] **Step 5: 运行内容脚本测试，确认通过**

Run:

```bash
node --test tests/paypal-flow-content.test.js
```

Expected:

```text
# tests ... passed
# fail 0
```

- [ ] **Step 6: 提交页面脚本改动**

```bash
git add content/paypal-flow.js tests/paypal-flow-content.test.js
git commit -m "feat: add paypal hosted verification resend controls"
```

### Task 2: 为后台 hosted verification 恢复链路补失败用例

**Files:**
- Modify: `tests/plus-checkout-create-wait.test.js`
- Test: `tests/plus-checkout-create-wait.test.js`

- [ ] **Step 1: 在 `tests/plus-checkout-create-wait.test.js` 为旧码预判与提交后恢复写失败用例**

```js
test('hosted PayPal verification resends before submit when fetched code matches last successful code', async () => {
  const storageLocalState = {
    paypalHostedLastSuccessfulVerificationCode: '123456',
  };
  const fetchedCodes = ['123456', '654321'];
  const paypalMessages = [];

  const harness = createHostedCheckoutHarness({
    storageLocalState,
    fetchHostedCodes: fetchedCodes,
    onPayPalMessage(message) {
      paypalMessages.push(message);
    },
    payPalStateSequence: [
      { hostedStage: 'verification', verificationInputsVisible: true },
      { hostedStage: 'verification', verificationInputsVisible: true },
      { hostedStage: 'guest_checkout' },
    ],
  });

  await harness.runHostedCheckoutPayPalFlow();

  assert.deepEqual(paypalMessages.map((item) => item.payload?.action || 'submit'), [
    'click-verification-resend',
    'submit',
  ]);
  assert.equal(paypalMessages.at(-1).payload.verificationCode, '654321');
});

test('hosted PayPal verification retries with resend after failure banner appears', async () => {
  const storageLocalState = {};
  const fetchedCodes = ['111111', '222222'];
  const payPalStepPayloads = [];

  const harness = createHostedCheckoutHarness({
    storageLocalState,
    fetchHostedCodes: fetchedCodes,
    onPayPalMessage(message) {
      payPalStepPayloads.push(message.payload || {});
    },
    payPalStateSequence: [
      { hostedStage: 'verification', verificationInputsVisible: true },
      { hostedStage: 'verification', verificationInputsVisible: true, verificationFailed: true, resendAvailable: true },
      { hostedStage: 'verification', verificationInputsVisible: true },
      { hostedStage: 'guest_checkout' },
    ],
  });

  await harness.runHostedCheckoutPayPalFlow();

  assert.equal(payPalStepPayloads[0].verificationCode, '111111');
  assert.equal(payPalStepPayloads[1].action, 'check-verification-failure');
  assert.equal(payPalStepPayloads[2].action, 'click-verification-resend');
  assert.equal(payPalStepPayloads[3].verificationCode, '222222');
});

test('hosted PayPal verification fails after duplicate or empty resend codes and asks for manual input', async () => {
  const storageLocalState = {
    paypalHostedLastSuccessfulVerificationCode: '123456',
  };
  const fetchedCodes = ['123456', '123456', ''];

  const harness = createHostedCheckoutHarness({
    storageLocalState,
    fetchHostedCodes: fetchedCodes,
    payPalStateSequence: [
      { hostedStage: 'verification', verificationInputsVisible: true },
    ],
  });

  await assert.rejects(
    harness.runHostedCheckoutPayPalFlow(),
    /需要手动输入验证码/
  );

  assert.equal(harness.failedNodeId, 'plus-checkout-create');
  assert.match(harness.logs.join('\n'), /需要手动输入验证码/);
});
```

- [ ] **Step 2: 运行后台 hosted checkout 测试，确认先失败**

Run:

```bash
node --test tests/plus-checkout-create-wait.test.js
```

Expected:

```text
not ok ... runHostedCheckoutPayPalFlow
not ok ... paypalHostedLastSuccessfulVerificationCode
```

- [ ] **Step 3: 给测试 harness 补上 `chrome.storage.local`、PayPal 状态序列和消息记录能力**

```js
function createHostedCheckoutHarness(options = {}) {
  const storageLocalState = { ...(options.storageLocalState || {}) };
  const logs = [];
  const payPalMessages = [];
  let failedNodeId = '';

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageLocalState[key]]));
          }
          return { [keys]: storageLocalState[keys] };
        },
        async set(payload) {
          Object.assign(storageLocalState, payload);
        },
      },
    },
    tabs: {
      async get() {
        return { id: 9001, url: currentUrl, status: 'complete' };
      },
    },
  };

  return {
    chrome,
    logs,
    payPalMessages,
    get storageLocalState() {
      return storageLocalState;
    },
    get failedNodeId() {
      return failedNodeId;
    },
  };
}
```

- [ ] **Step 4: 再次运行后台 hosted checkout 测试，确认现在失败点只剩实现缺失**

Run:

```bash
node --test tests/plus-checkout-create-wait.test.js
```

Expected:

```text
not ok ... click-verification-resend was not sent
not ok ... manual input message not found
```

- [ ] **Step 5: 提交测试支架改动**

```bash
git add tests/plus-checkout-create-wait.test.js
git commit -m "test: cover paypal hosted verification recovery flow"
```

### Task 3: 在后台实现旧码预判、自动 Resend 和成功持久化

**Files:**
- Modify: `background/steps/create-plus-checkout.js`
- Test: `tests/plus-checkout-create-wait.test.js`

- [ ] **Step 1: 在 `create-plus-checkout.js` 增加常量和存储 helper**

```js
const PAYPAL_HOSTED_LAST_SUCCESSFUL_VERIFICATION_CODE_KEY = 'paypalHostedLastSuccessfulVerificationCode';
const PAYPAL_HOSTED_VERIFICATION_FAILURE_WAIT_MS = 5000;
const PAYPAL_HOSTED_VERIFICATION_RESEND_WAIT_MS = 3000;

async function getLastSuccessfulPayPalHostedVerificationCode() {
  const stored = await chrome.storage.local.get([
    PAYPAL_HOSTED_LAST_SUCCESSFUL_VERIFICATION_CODE_KEY,
  ]);
  return String(stored?.[PAYPAL_HOSTED_LAST_SUCCESSFUL_VERIFICATION_CODE_KEY] || '').trim();
}

async function setLastSuccessfulPayPalHostedVerificationCode(code) {
  await chrome.storage.local.set({
    [PAYPAL_HOSTED_LAST_SUCCESSFUL_VERIFICATION_CODE_KEY]: String(code || '').trim(),
  });
}
```

- [ ] **Step 2: 增加 PayPal hosted verification 状态操作 helper**

```js
async function checkHostedCheckoutPayPalVerificationFailure(tabId) {
  return runHostedCheckoutPayPalStep(tabId, {
    action: 'check-verification-failure',
  });
}

async function clickHostedCheckoutPayPalVerificationResend(tabId) {
  return runHostedCheckoutPayPalStep(tabId, {
    action: 'click-verification-resend',
  });
}

function isVerificationCodeUsable(code, disallowedCodes = []) {
  const normalized = String(code || '').trim();
  if (!/^\d{6}$/.test(normalized)) {
    return false;
  }
  return !disallowedCodes.includes(normalized);
}
```

- [ ] **Step 3: 增加“最多两轮重拉”的验证码恢复 helper**

```js
async function refetchHostedCheckoutVerificationCodeWithResend(tabId, disallowedCodes = [], reasonLabel = '重发后取码') {
  let firstAttemptCode = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await addLog(`步骤 6：${reasonLabel}，等待 ${PAYPAL_HOSTED_VERIFICATION_RESEND_WAIT_MS / 1000} 秒后重新拉取验证码（${attempt}/2）。`, 'info');
    await sleepWithStop(PAYPAL_HOSTED_VERIFICATION_RESEND_WAIT_MS);
    const nextCode = await pollHostedCheckoutVerificationCode().catch(() => '');
    if (attempt === 1) {
      firstAttemptCode = String(nextCode || '').trim();
    }
    const nextDisallowed = attempt === 1
      ? disallowedCodes
      : [...disallowedCodes, firstAttemptCode].filter(Boolean);
    if (isVerificationCodeUsable(nextCode, nextDisallowed)) {
      return String(nextCode).trim();
    }
  }
  throw new Error('步骤 6：自动重发后仍未拿到新验证码，需要手动输入验证码。');
}
```

- [ ] **Step 4: 改写 verification 分支，加入输入前旧码预判**

```js
if (pageState.hostedStage === 'verification' && pageState.verificationInputsVisible) {
  await addLog('步骤 6：检测到 PayPal hosted checkout 验证码弹窗，正在获取并填写验证码...', 'info');
  const lastSuccessfulCode = await getLastSuccessfulPayPalHostedVerificationCode();
  let verificationCode = await pollHostedCheckoutVerificationCode();

  if (lastSuccessfulCode && verificationCode === lastSuccessfulCode) {
    await addLog('步骤 6：当前验证码与最近一次成功验证码一致，先执行 Resend 再重新取码。', 'warn');
    await clickHostedCheckoutPayPalVerificationResend(tabId);
    verificationCode = await refetchHostedCheckoutVerificationCodeWithResend(tabId, [lastSuccessfulCode], '旧码预检重发');
  }

  await runHostedCheckoutPayPalStep(tabId, {
    verificationCode,
  });
```

- [ ] **Step 5: 在提交后加入 5 秒检测、失败自动 Resend、成功持久化**

```js
  await sleepWithStop(PAYPAL_HOSTED_VERIFICATION_FAILURE_WAIT_MS);
  const failureState = await checkHostedCheckoutPayPalVerificationFailure(tabId);
  if (failureState?.verificationFailed) {
    await addLog('步骤 6：PayPal 验证码提交后出现错误提示，准备点击 Resend 并重新取码。', 'warn');
    await clickHostedCheckoutPayPalVerificationResend(tabId);
    const replacementCode = await refetchHostedCheckoutVerificationCodeWithResend(
      tabId,
      [verificationCode],
      '验证码失败后重发'
    );
    await runHostedCheckoutPayPalStep(tabId, {
      verificationCode: replacementCode,
    });
    await sleepWithStop(PAYPAL_HOSTED_VERIFICATION_FAILURE_WAIT_MS);
    const replacementFailureState = await checkHostedCheckoutPayPalVerificationFailure(tabId);
    if (replacementFailureState?.verificationFailed) {
      throw new Error('步骤 6：自动重发后验证码仍然失败，需要手动输入验证码。');
    }
    await setLastSuccessfulPayPalHostedVerificationCode(replacementCode);
  } else {
    await setLastSuccessfulPayPalHostedVerificationCode(verificationCode);
  }
  await addLog('步骤 6：已记录最近一次成功的 PayPal hosted verification 验证码。', 'info');
```

- [ ] **Step 6: 为最终失败接入节点失败与侧边栏提示语义**

```js
void runHostedCheckoutAutomation(tabId, completionPayload).catch(async (error) => {
  const message = error?.message || String(error || 'hosted checkout automation failed');
  await addLog(`步骤 6：hosted checkout 自动化失败：${message}`, 'error');
  if (/需要手动输入验证码/.test(message)) {
    await addLog('步骤 6：PayPal hosted verification 自动恢复已放弃，请手动输入验证码后再继续。', 'error');
  }
  if (typeof failNodeFromBackground === 'function') {
    await failNodeFromBackground('plus-checkout-create', message);
  }
});
```

- [ ] **Step 7: 运行后台 hosted checkout 测试，确认通过**

Run:

```bash
node --test tests/plus-checkout-create-wait.test.js
```

Expected:

```text
# tests ... passed
# fail 0
```

- [ ] **Step 8: 提交后台恢复逻辑**

```bash
git add background/steps/create-plus-checkout.js tests/plus-checkout-create-wait.test.js
git commit -m "feat: retry paypal hosted verification codes"
```

### Task 4: 全量回归并收尾

**Files:**
- Modify: `tests/paypal-flow-content.test.js`
- Modify: `tests/plus-checkout-create-wait.test.js`
- Modify: `background/steps/create-plus-checkout.js`
- Modify: `content/paypal-flow.js`

- [ ] **Step 1: 运行内容脚本与 hosted checkout 相关回归**

Run:

```bash
node --test tests/paypal-flow-content.test.js tests/plus-checkout-create-wait.test.js tests/hosted-checkout-timeout.test.js tests/plus-checkout-billing-tab-resolution.test.js
```

Expected:

```text
# tests ... passed
# fail 0
```

- [ ] **Step 2: 运行完整测试套件，确认没有破坏现有支付链路**

Run:

```bash
npm test
```

Expected:

```text
> test
> node --test tests/*.test.js
...
# fail 0
```

- [ ] **Step 3: 做一次代码检查，确认没有把失败验证码写入本地存储**

```js
// create-plus-checkout.js
// 只允许在 verificationFailed === false 的路径调用：
await setLastSuccessfulPayPalHostedVerificationCode(successCode);
```

Manual check:

```bash
rg -n "setLastSuccessfulPayPalHostedVerificationCode" background/steps/create-plus-checkout.js
```

Expected:

```text
仅出现在成功路径；失败路径没有调用
```

- [ ] **Step 4: 提交回归和收尾改动**

```bash
git add content/paypal-flow.js background/steps/create-plus-checkout.js tests/paypal-flow-content.test.js tests/plus-checkout-create-wait.test.js
git commit -m "test: verify paypal hosted verification recovery"
```

- [ ] **Step 5: 推送分支**

```bash
git push -u origin feature/paypal-hosted-verification-retry
```

- [ ] **Step 6: 准备 PR 摘要**

```md
## Summary
- add PayPal hosted verification failure detection and resend controls
- retry stale or rejected hosted verification codes before stopping
- persist the last successful hosted verification code in chrome.storage.local

## Testing
- node --test tests/paypal-flow-content.test.js tests/plus-checkout-create-wait.test.js tests/hosted-checkout-timeout.test.js tests/plus-checkout-billing-tab-resolution.test.js
- npm test
```

## Self-Review

### Spec coverage

- 全局单值存储：Task 3 Step 1, Step 5
- 输入前旧码预检：Task 3 Step 4
- 提交后 5 秒检查错误块：Task 3 Step 5
- 自动 `Resend` 后最多两轮重拉：Task 3 Step 3, Step 5
- 失败时日志、提示、节点失败：Task 3 Step 6
- 内容脚本只负责 DOM 能力：Task 1
- 回归测试：Task 4

### Placeholder scan

- 未使用 `TBD`、`TODO`、`implement later`
- 每个任务都给了具体文件、代码片段、命令和预期结果

### Type consistency

- 存储键统一为 `paypalHostedLastSuccessfulVerificationCode`
- 页面动作统一为 `check-verification-failure` 与 `click-verification-resend`
- 成功写入函数统一为 `setLastSuccessfulPayPalHostedVerificationCode`
