const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadExecutor() {
  const source = fs.readFileSync('background/steps/paypal-checkout-flow.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundPayPalCheckoutFlow;`)({});
  return api.createPayPalCheckoutFlowExecutor;
}

test('paypal checkout flow starts from hosted checkout landing page before entering paypal', async () => {
  const createExecutor = loadExecutor();
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
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        address: { Address: '1 Test St', City: 'Austin', State_Full: 'Texas', Zip_Code: '78701' },
      }),
    }),
    getState: async () => ({
      hostedCheckoutVerificationPopupDelaySeconds: 0,
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
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher, timeoutMs = 0) => {
      const candidate = timeoutMs > 0
        ? { id: 88, url: currentUrl }
        : { id: 88, url: currentUrl };
      if (!matcher(candidate.url)) {
        throw new Error('no match');
      }
      return candidate;
    },
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

test('paypal checkout flow auto-detects hosted checkout url even without hosted entry state', async () => {
  const createExecutor = loadExecutor();
  const calls = [];
  let currentUrl = 'https://pay.openai.com/c/pay/demo';

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => ({ id: 88, url: currentUrl, status: 'complete' }),
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        address: { Address: '1 Test St', City: 'Austin', State_Full: 'Texas', Zip_Code: '78701' },
      }),
    }),
    getState: async () => ({
      hostedCheckoutVerificationPopupDelaySeconds: 0,
    }),
    sendTabMessageUntilStopped: async (_tabId, sourceId, message) => {
      calls.push({ sourceId, message });
      if (sourceId === 'plus-checkout' && message.type === 'PLUS_CHECKOUT_GET_STATE') {
        return { hostedVerificationVisible: false };
      }
      if (sourceId === 'plus-checkout' && message.type === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP') {
        currentUrl = 'https://chatgpt.com/payments/success';
        return { submitted: true };
      }
      throw new Error(`unexpected ${sourceId}:${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePayPalCheckoutFlow({
    plusCheckoutTabId: 88,
  });

  assert.equal(calls[0].sourceId, 'plus-checkout');
  assert.equal(calls[0].message.type, 'PLUS_CHECKOUT_GET_STATE');
});

test('paypal checkout flow prefers hosted checkout tab over stale paypal tab state', async () => {
  const createExecutor = loadExecutor();
  const calls = [];
  let currentUrl = 'https://pay.openai.com/c/pay/demo';

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async (tabId) => {
          assert.equal(tabId, 88);
          return { id: 88, url: currentUrl, status: 'complete' };
        },
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        address: { Address: '1 Test St', City: 'Austin', State_Full: 'Texas', Zip_Code: '78701' },
      }),
    }),
    getState: async () => ({
      hostedCheckoutVerificationPopupDelaySeconds: 0,
    }),
    sendTabMessageUntilStopped: async (_tabId, sourceId, message) => {
      calls.push({ sourceId, message });
      if (sourceId === 'plus-checkout' && message.type === 'PLUS_CHECKOUT_GET_STATE') {
        return { hostedVerificationVisible: false };
      }
      if (sourceId === 'plus-checkout' && message.type === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP') {
        currentUrl = 'https://chatgpt.com/payments/success';
        return { submitted: true };
      }
      throw new Error(`unexpected ${sourceId}:${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePayPalCheckoutFlow({
    plusCheckoutTabId: 88,
    paypalCheckoutTabId: 777,
    plusHostedCheckoutEntryUrl: 'https://pay.openai.com/c/pay/demo',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(calls[0].sourceId, 'plus-checkout');
});

test('paypal checkout flow resumes from stored paypal stage and completes on success url', async () => {
  const createExecutor = loadExecutor();
  const completed = [];
  const calls = [];

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => ({ id: 88, url: 'https://www.paypal.com/webapps/hermes' }),
      },
    },
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
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher, timeoutMs = 0) => {
      const candidate = timeoutMs > 0
        ? { id: 88, url: 'https://chatgpt.com/payments/success' }
        : { id: 88, url: 'https://www.paypal.com/webapps/hermes' };
      if (!matcher(candidate.url)) {
        throw new Error('no match');
      }
      return candidate;
    },
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'review_consent',
    paypalCheckoutEntrySource: 'hosted-checkout',
    plusCheckoutCountry: 'US',
    plusCheckoutCurrency: 'USD',
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeId, 'paypal-checkout-flow');
  assert.equal(calls.some((entry) => entry.message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP'), true);
});

test('paypal checkout flow requests step 6 restart when paypal context is lost', async () => {
  const createExecutor = loadExecutor();
  const failed = [];

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => ({ id: 88, url: 'https://example.com/aborted' }),
      },
    },
    completeNodeFromBackground: async () => {},
    failNodeFromBackground: async (nodeId, message) => {
      failed.push({ nodeId, message });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    sendTabMessageUntilStopped: async () => ({
      hostedStage: 'outside_paypal',
      currentUrl: 'https://example.com/aborted',
    }),
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePayPalCheckoutFlow({
      paypalCheckoutTabId: 88,
      paypalCheckoutStage: 'guest_checkout',
      paypalCheckoutEntrySource: 'hosted-checkout',
    }),
    /回退到节点 plus-checkout-create/
  );

  assert.equal(failed.length, 1);
  assert.equal(failed[0].nodeId, 'paypal-checkout-flow');
});

test('paypal checkout flow resends verification code when fetched code matches stored browser code', async () => {
  const createExecutor = loadExecutor();
  const calls = [];
  const completed = [];
  let fetchCount = 0;
  let stateReads = 0;
  let currentUrl = 'https://www.paypal.com/webapps/hermes';

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
    fetch: async () => ({
      text: async () => {
        fetchCount += 1;
        return fetchCount === 1 ? '111111' : '222222';
      },
    }),
    getState: async () => ({
      hostedCheckoutVerificationUrl: 'https://mail.test/code',
      hostedCheckoutVerificationPopupDelaySeconds: 0,
    }),
    sendTabMessageUntilStopped: async (tabId, sourceId, message) => {
      calls.push({ tabId, sourceId, message });
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        stateReads += 1;
        if (stateReads >= 2) {
          currentUrl = 'https://www.paypal.com/webapps/hermes?review=1';
          return {
            hostedStage: 'review_consent',
            currentUrl,
          };
        }
        return {
          hostedStage: 'verification',
          currentUrl,
          hostedVerificationStoredCode: '111111',
          hostedVerificationResendAvailable: true,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.action === 'resend') {
        return {
          resent: true,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        return {
          codeSubmitted: true,
          verificationFailed: false,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher, timeoutMs = 0) => {
      const candidate = timeoutMs > 0
        ? { id: 88, url: 'https://chatgpt.com/payments/success' }
        : { id: 88, url: currentUrl };
      if (!matcher(candidate.url)) {
        throw new Error('no match');
      }
      return candidate;
    },
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'verification',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(calls.some((entry) => entry.message.payload?.action === 'resend'), true);
  assert.equal(calls.some((entry) => entry.message.payload?.verificationCode === '222222'), true);
});

test('paypal checkout flow stops with manual input error when resend still returns duplicate code', async () => {
  const createExecutor = loadExecutor();
  let fetchCount = 0;

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => ({ id: 88, url: 'https://www.paypal.com/webapps/hermes' }),
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => ({
      text: async () => {
        fetchCount += 1;
        return fetchCount <= 2 ? '111111' : '';
      },
    }),
    getState: async () => ({
      hostedCheckoutVerificationUrl: 'https://mail.test/code',
      hostedCheckoutVerificationPopupDelaySeconds: 0,
    }),
    sendTabMessageUntilStopped: async (_tabId, _sourceId, message) => {
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return {
          hostedStage: 'verification',
          currentUrl: 'https://www.paypal.com/webapps/hermes',
          hostedVerificationStoredCode: '111111',
          hostedVerificationResendAvailable: true,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.action === 'resend') {
        return {
          resent: true,
        };
      }
      return {
        codeSubmitted: true,
        verificationFailed: false,
      };
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher) => {
      const candidate = { id: 88, url: 'https://www.paypal.com/webapps/hermes' };
      if (!matcher(candidate.url)) {
        throw new Error('no match');
      }
      return candidate;
    },
  });

  await assert.rejects(
    () => executor.executePayPalCheckoutFlow({
      paypalCheckoutTabId: 88,
      paypalCheckoutStage: 'verification',
      paypalCheckoutEntrySource: 'hosted-checkout',
    }),
    /请手动输入验证码/
  );
});

test('hosted paypal checkout flow waits to leave verification after successful code submit', async () => {
  const createExecutor = loadExecutor();
  const calls = [];
  const completed = [];
  let stateReads = 0;
  let currentUrl = 'https://www.paypal.com/webapps/hermes?token=demo';

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
    fetch: async () => ({
      text: async () => '111111',
    }),
    getState: async () => ({
      hostedCheckoutVerificationUrl: 'https://mail.test/code',
      hostedCheckoutVerificationPopupDelaySeconds: 0,
    }),
    sendTabMessageUntilStopped: async (_tabId, _sourceId, message) => {
      calls.push(message);
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        stateReads += 1;
        if (stateReads <= 2) {
          return {
            hostedStage: 'verification',
            currentUrl,
            hostedVerificationStoredCode: '',
            hostedVerificationResendAvailable: true,
          };
        }
        currentUrl = 'https://www.paypal.com/webapps/hermes?review=1';
        return {
          hostedStage: 'review_consent',
          currentUrl,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        return {
          codeSubmitted: true,
          verificationFailed: false,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher, timeoutMs = 0) => {
      const candidate = timeoutMs > 0
        ? { id: 88, url: 'https://chatgpt.com/payments/success' }
        : { id: 88, url: currentUrl };
      if (!matcher(candidate.url)) {
        throw new Error('no match');
      }
      return candidate;
    },
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'verification',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(calls.filter((message) => message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP').length, 2);
  assert.equal(calls.some((message) => message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.verificationCode === '111111'), true);
});

test('hosted paypal checkout flow hands off to return confirmation after leaving paypal to openai', async () => {
  const createExecutor = loadExecutor();
  const completed = [];
  const failed = [];
  let tabReads = 0;

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => {
          tabReads += 1;
          return tabReads === 1
            ? { id: 88, url: 'https://www.paypal.com/webapps/hermes' }
            : { id: 88, url: 'https://chatgpt.com/' };
        },
      },
    },
    completeNodeFromBackground: async (nodeId, payload) => {
      completed.push({ nodeId, payload });
    },
    failNodeFromBackground: async (nodeId, message) => {
      failed.push({ nodeId, message });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    sendTabMessageUntilStopped: async (_tabId, _sourceId, message) => {
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return {
          hostedStage: 'review_consent',
          currentUrl: 'https://www.paypal.com/webapps/hermes',
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        return {
          submitted: true,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => null,
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'review_consent',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(failed.length, 0);
});

test('hosted paypal checkout flow completes when stage probe observes outside_paypal on openai return url', async () => {
  const createExecutor = loadExecutor();
  const completed = [];
  const failed = [];
  let currentUrl = 'https://www.paypal.com/webapps/hermes?review=1';
  let stateReads = 0;

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
    failNodeFromBackground: async (nodeId, message) => {
      failed.push({ nodeId, message });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    sendTabMessageUntilStopped: async (_tabId, _sourceId, message) => {
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        stateReads += 1;
        if (stateReads === 1) {
          currentUrl = 'https://chatgpt.com/';
          return {
            hostedStage: 'outside_paypal',
            currentUrl,
          };
        }
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        return {
          submitted: true,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => null,
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'review_consent',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(failed.length, 0);
});

test('hosted paypal checkout flow clicks approve during approval stage', async () => {
  const createExecutor = loadExecutor();
  const calls = [];
  const completed = [];
  let successChecks = 0;

  const executor = createExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        get: async () => ({ id: 88, url: 'https://www.paypal.com/checkoutnow?token=demo' }),
      },
    },
    completeNodeFromBackground: async (nodeId, payload) => {
      completed.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    sendTabMessageUntilStopped: async (_tabId, _sourceId, message) => {
      calls.push(message);
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return {
          hostedStage: 'approval',
          currentUrl: 'https://www.paypal.com/checkoutnow?token=demo',
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        return {
          stage: 'approval',
          submitted: false,
          approveReady: true,
        };
      }
      if (message.type === 'PAYPAL_CLICK_APPROVE') {
        return {
          clicked: true,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher, timeoutMs = 0) => {
      successChecks += 1;
      if (timeoutMs > 0 && successChecks > 1) {
        const candidate = { id: 88, url: 'https://chatgpt.com/payments/success' };
        if (matcher(candidate.url)) {
          return candidate;
        }
      }
      const candidate = { id: 88, url: 'https://www.paypal.com/checkoutnow?token=demo' };
      if (matcher(candidate.url)) {
        return candidate;
      }
      throw new Error('no match');
    },
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'approval',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(calls.some((message) => message.type === 'PAYPAL_CLICK_APPROVE'), true);
});

test('hosted paypal checkout flow waits for guest checkout stage after submitting login email', async () => {
  const createExecutor = loadExecutor();
  const calls = [];
  const completed = [];
  let stateReads = 0;
  let currentUrl = 'https://www.paypal.com/pay?token=demo';
  let fetchCount = 0;

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
    fetch: async () => ({
      ok: true,
      text: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return JSON.stringify({
            address: { Address: '1 Test St', City: 'Austin', State_Full: 'Texas', Zip_Code: '78701' },
          });
        }
        return '123456';
      },
    }),
    getState: async () => ({
      hostedCheckoutVerificationUrl: 'https://mail.test/code',
      hostedCheckoutVerificationPopupDelaySeconds: 0,
      hostedCheckoutPhoneNumber: '1234567890',
    }),
    sendTabMessageUntilStopped: async (_tabId, _sourceId, message) => {
      calls.push(message);
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        stateReads += 1;
        if (stateReads === 1) {
          return { hostedStage: 'pay_login', currentUrl };
        }
        if (stateReads === 2) {
          currentUrl = 'https://www.paypal.com/checkoutweb/signup?token=demo';
          return { hostedStage: 'unknown', currentUrl };
        }
        if (stateReads === 3) {
          return { hostedStage: 'guest_checkout', currentUrl };
        }
        if (stateReads === 4) {
          return {
            hostedStage: 'verification',
            currentUrl,
            hostedVerificationStoredCode: '',
            hostedVerificationResendAvailable: true,
          };
        }
        currentUrl = 'https://www.paypal.com/webapps/hermes?review=1';
        return {
          hostedStage: 'review_consent',
          currentUrl,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'pay_login') {
        return {
          submitted: true,
          nextExpected: 'guest_checkout_or_verification',
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'guest_checkout') {
        return {
          submitted: true,
          submitScheduled: true,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'verification') {
        return {
          codeSubmitted: true,
          verificationFailed: false,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'review_consent') {
        currentUrl = 'https://chatgpt.com/payments/success';
        return {
          submitted: true,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher, timeoutMs = 0) => {
      const candidate = timeoutMs > 0
        ? { id: 88, url: 'https://chatgpt.com/payments/success' }
        : { id: 88, url: currentUrl };
      if (!matcher(candidate.url)) {
        throw new Error('no match');
      }
      return candidate;
    },
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'pay_login',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(calls.some((message) => message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'pay_login'), true);
  assert.equal(stateReads >= 4, true);
  assert.equal(fetchCount >= 2, true);
});

test('hosted paypal checkout flow waits for verification stage after submitting guest checkout', async () => {
  const createExecutor = loadExecutor();
  const calls = [];
  const completed = [];
  let stateReads = 0;
  let currentUrl = 'https://www.paypal.com/checkoutweb/signup?token=demo';
  let fetchCount = 0;

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
    fetch: async () => ({
      text: async () => {
        fetchCount += 1;
        return fetchCount === 1 ? '123456' : '654321';
      },
    }),
    getState: async () => ({
      hostedCheckoutVerificationUrl: 'https://mail.test/code',
      hostedCheckoutVerificationPopupDelaySeconds: 0,
      hostedCheckoutPhoneNumber: '1234567890',
      paypalCheckoutGuestProfile: {
        email: 'guest@example.com',
        password: 'Aa1234567890!!',
        phone: '1234567890',
        cardNumber: '4111111111111111',
        cardExpiry: '08 / 30',
        cardCvv: '123',
        address: {
          street: '123 Main St',
          city: 'Austin',
          state: 'Texas',
          zip: '78701',
        },
      },
    }),
    sendTabMessageUntilStopped: async (_tabId, _sourceId, message) => {
      calls.push(message);
      if (message.type === 'PAYPAL_HOSTED_GET_STATE') {
        stateReads += 1;
        if (stateReads === 1) {
          return { hostedStage: 'guest_checkout', currentUrl };
        }
        if (stateReads === 2) {
          return {
            hostedStage: 'verification',
            currentUrl,
            hostedVerificationStoredCode: '',
            hostedVerificationResendAvailable: true,
          };
        }
        currentUrl = 'https://www.paypal.com/webapps/hermes?review=1';
        return {
          hostedStage: 'review_consent',
          currentUrl,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'guest_checkout') {
        return {
          submitted: true,
          submitScheduled: true,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'verification') {
        return {
          codeSubmitted: true,
          verificationFailed: false,
        };
      }
      if (message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP' && message.payload?.stage === 'review_consent') {
        currentUrl = 'https://chatgpt.com/payments/success';
        return {
          submitted: true,
        };
      }
      throw new Error(`unexpected ${message.type}`);
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher, timeoutMs = 0) => {
      const candidate = timeoutMs > 0
        ? { id: 88, url: 'https://chatgpt.com/payments/success' }
        : { id: 88, url: currentUrl };
      if (!matcher(candidate.url)) {
        throw new Error('no match');
      }
      return candidate;
    },
  });

  await executor.executePayPalCheckoutFlow({
    paypalCheckoutTabId: 88,
    paypalCheckoutStage: 'guest_checkout',
    paypalCheckoutEntrySource: 'hosted-checkout',
  });

  assert.equal(completed.length, 1);
  assert.equal(stateReads >= 2, true);
});

test('paypal checkout flow fails instead of looping forever when hosted checkout never leaves landing page', async () => {
  const createExecutor = loadExecutor();
  const failed = [];
  let now = 0;

  const realNow = Date.now;
  Date.now = () => now;
  try {
    const executor = createExecutor({
      addLog: async () => {},
      chrome: {
        tabs: {
          get: async () => ({ id: 88, url: 'https://pay.openai.com/c/pay/demo', status: 'complete' }),
        },
      },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    failNodeFromBackground: async (nodeId, message) => {
      failed.push({ nodeId, message });
    },
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        address: { Address: '1 Test St', City: 'Austin', State_Full: 'Texas', Zip_Code: '78701' },
      }),
    }),
    getState: async () => ({
      hostedCheckoutVerificationPopupDelaySeconds: 0,
    }),
      sendTabMessageUntilStopped: async (_tabId, sourceId, message) => {
        if (sourceId === 'plus-checkout' && message.type === 'PLUS_CHECKOUT_GET_STATE') {
          return { hostedVerificationVisible: false };
        }
        if (sourceId === 'plus-checkout' && message.type === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP') {
          return { submitted: true };
        }
        throw new Error(`unexpected ${sourceId}:${message.type}`);
      },
      setState: async () => {},
      sleepWithStop: async () => {
        now += 61000;
      },
      waitForTabCompleteUntilStopped: async () => {},
    });

    await assert.rejects(
      () => executor.executePayPalCheckoutFlow({
        plusCheckoutTabId: 88,
        plusHostedCheckoutEntryUrl: 'https://pay.openai.com/c/pay/demo',
        paypalCheckoutEntrySource: 'hosted-checkout',
      }),
      /长时间未跳转到 PayPal 或成功页/
    );
  } finally {
    Date.now = realNow;
  }

  assert.equal(failed.length, 1);
  assert.equal(failed[0].nodeId, 'paypal-checkout-flow');
});
