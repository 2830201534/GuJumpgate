const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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
