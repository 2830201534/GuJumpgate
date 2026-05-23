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
    paypalCheckoutEntrySource: 'plus-checkout-create',
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
      paypalCheckoutEntrySource: 'plus-checkout-create',
    }),
    /回退到节点 plus-checkout-create/
  );

  assert.equal(failed.length, 1);
  assert.equal(failed[0].nodeId, 'paypal-checkout-flow');
});
