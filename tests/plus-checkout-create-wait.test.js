const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadExecutor() {
  const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)({});
  return api.createPlusCheckoutCreateExecutor;
}

test('plus checkout create completes only after paypal redirect and valid stage detection', async () => {
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
      if (sourceId === 'paypal-flow' && message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return {
          hostedStage: 'guest_checkout',
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
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher) => {
      const paypalTab = { id: 99, url: 'https://www.paypal.com/webapps/hermes?token=demo' };
      assert.equal(typeof matcher, 'function');
      assert.equal(matcher(paypalTab.url), true);
      events.push({ type: 'paypal-redirect', url: paypalTab.url });
      return paypalTab;
    },
  });

  await executor.executePlusCheckoutCreate({
    plusPaymentMethod: 'paypal',
    plusHostedCheckoutIsFinalStep: false,
  });

  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeId, 'plus-checkout-create');
  assert.equal(statePatches.some((patch) => patch.paypalCheckoutStage === 'guest_checkout'), true);

  const redirectIndex = events.findIndex((entry) => entry.type === 'paypal-redirect');
  const getStateIndex = events.findIndex((entry) => entry.type === 'message' && entry.messageType === 'PAYPAL_HOSTED_GET_STATE');
  const setStateIndex = events.findIndex((entry) => entry.type === 'set-state' && entry.patch.paypalCheckoutStage === 'guest_checkout');
  const completeIndex = events.findIndex((entry) => entry.type === 'complete');

  assert.notEqual(redirectIndex, -1);
  assert.notEqual(getStateIndex, -1);
  assert.notEqual(setStateIndex, -1);
  assert.notEqual(completeIndex, -1);
  assert.ok(redirectIndex < getStateIndex, '应先跳转到 PayPal，再读取 PayPal stage');
  assert.ok(getStateIndex < setStateIndex, '应先识别有效 PayPal stage，再写入运行时状态');
  assert.ok(setStateIndex < completeIndex, '应先持久化 PayPal stage，再完成 step 6');
});

for (const invalidStage of ['', 'unknown', 'outside_paypal']) {
  test(`plus checkout create fails without completing when paypal stage is invalid: ${invalidStage || 'empty'}`, async () => {
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
        if (sourceId === 'paypal-flow' && message.type === 'PAYPAL_HOSTED_GET_STATE') {
          return {
            hostedStage: invalidStage,
          };
        }
        throw new Error(`unexpected message ${sourceId}:${message.type}`);
      },
      setState: async (patch) => {
        statePatches.push(patch);
      },
      sleepWithStop: async () => {},
      waitForTabCompleteUntilStopped: async () => {},
      waitForTabUrlMatchUntilStopped: async () => ({ id: 99, url: 'https://www.paypal.com/webapps/hermes?token=demo' }),
    });

    await assert.rejects(
      executor.executePlusCheckoutCreate({
        plusPaymentMethod: 'paypal',
        plusHostedCheckoutIsFinalStep: false,
      }),
      /未识别出有效阶段/
    );

    assert.equal(completed.length, 0);
    assert.equal(statePatches.some((patch) => Object.prototype.hasOwnProperty.call(patch, 'paypalCheckoutStage')), false);
  });
}
