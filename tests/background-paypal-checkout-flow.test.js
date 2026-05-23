const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadExecutor() {
  const source = fs.readFileSync('background/steps/paypal-checkout-flow.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundPayPalCheckoutFlow;`)({});
  return api.createPayPalCheckoutFlowExecutor;
}

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
        get: async () => ({ id: 88, url: 'https://chatgpt.com/' }),
      },
    },
    completeNodeFromBackground: async () => {},
    failNodeFromBackground: async (nodeId, message) => {
      failed.push({ nodeId, message });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    sendTabMessageUntilStopped: async () => ({
      hostedStage: 'outside_paypal',
      currentUrl: 'https://chatgpt.com/',
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
        : { id: 88, url: 'https://www.paypal.com/webapps/hermes' };
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
