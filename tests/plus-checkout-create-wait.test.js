const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadExecutor() {
  const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)({});
  return api.createPlusCheckoutCreateExecutor;
}

test('hosted plus checkout create stops at hosted checkout landing page', async () => {
  const createExecutor = loadExecutor();
  const events = [];
  const completed = [];
  const statePatches = [];
  let fetchCalled = false;

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
    fetch: async () => {
      fetchCalled = true;
      throw new Error('hosted create should not fetch address or verification config');
    },
    getState: async () => ({
      paypalCheckoutTabId: 777,
      paypalCheckoutUrl: 'https://www.paypal.com/old',
      paypalCheckoutStage: 'approval',
      paypalCheckoutGuestProfile: { email: 'old@example.com' },
      hostedCheckoutCurrentSmsEntry: { key: 'old' },
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
  assert.equal(fetchCalled, false);
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutEntrySource === 'hosted-checkout'), true);
  assert.equal(statePatches.some((patch) => patch.plusHostedCheckoutEntryUrl === 'https://pay.openai.com/c/pay/demo'), true);
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutTabId === null), true);
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutUrl === ''), true);
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutStage === ''), true);
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutGuestProfile === null), true);
  assert.equal(statePatches.some((patch) => patch.hostedCheckoutCurrentSmsEntry === null), true);
  assert.equal(
    events.some((entry) => entry.type === 'message' && entry.messageType === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP'),
    false
  );
  assert.equal(
    events.some((entry) => entry.type === 'message' && entry.messageType === 'PAYPAL_HOSTED_GET_STATE'),
    false
  );
  assert.equal(
    events.some((entry) => entry.type === 'message' && entry.messageType === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP'),
    false
  );
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutStage === ''), true);
});

test('non-hosted plus checkout create stays on checkout page and does not persist paypal stage', async () => {
  const createExecutor = loadExecutor();
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
      completed.push({ nodeId, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (_tabId, sourceId, message) => {
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
      statePatches.push(patch);
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => {
      throw new Error('should not wait for paypal redirect in non-hosted create step');
    },
  });

  await executor.executePlusCheckoutCreate({
    plusPaymentMethod: 'paypal',
    plusHostedCheckoutIsFinalStep: false,
  });

  assert.equal(completed.length, 1);
  assert.equal(statePatches.some((patch) => Object.prototype.hasOwnProperty.call(patch, 'paypalCheckoutStage')), false);
});
