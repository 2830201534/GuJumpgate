const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
const plusCheckoutSource = fs.readFileSync('content/plus-checkout.js', 'utf8');
const gopayUtilsSource = fs.readFileSync('gopay-utils.js', 'utf8');
const globalScope = {};
new Function('self', `${gopayUtilsSource};`)(globalScope);
const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)(globalScope);

function createCheckoutContentHarness(options = {}) {
  const checkoutEvents = [];
  const attrs = new Map();
  let listener = null;
  const elements = [];
  const markPaymentSelected = options.markPaymentSelected !== false;

  function createElement({ tagName = 'DIV', text = '', attrs: initialAttrs = {}, id = '', type = '', value = '' } = {}) {
    const attrMap = new Map(Object.entries(initialAttrs));
    if (id) attrMap.set('id', id);
    if (type) attrMap.set('type', type);
    const element = {
      nodeType: 1,
      tagName,
      id,
      type,
      value,
      textContent: text,
      innerText: text,
      className: initialAttrs.class || '',
      checked: initialAttrs.checked === 'true',
      disabled: false,
      hidden: false,
      dataset: {},
      children: [],
      parentElement: null,
      style: { display: 'block', visibility: 'visible' },
      getAttribute(name) {
        if (name === 'class') return this.className;
        if (name === 'id') return this.id || attrMap.get(name) || '';
        if (name === 'type') return this.type || attrMap.get(name) || '';
        return attrMap.has(name) ? attrMap.get(name) : '';
      },
      setAttribute(name, nextValue) {
        attrMap.set(name, String(nextValue));
      },
      closest() {
        return null;
      },
      querySelector() {
        return null;
      },
      scrollIntoView() {},
      focus() {},
      dispatchEvent() {
        return true;
      },
      click() {},
      getBoundingClientRect() {
        return { left: 10, top: 20, width: 180, height: 44 };
      },
    };
    return element;
  }

  const paymentButton = createElement({ tagName: 'BUTTON', text: 'PayPal', attrs: { role: 'tab', 'aria-selected': '' } });
  const fullNameInput = createElement({ tagName: 'INPUT', id: 'name', type: 'text', attrs: { name: 'billingName', placeholder: 'Full name' } });
  const addressInput = createElement({ tagName: 'INPUT', id: 'address', type: 'text', attrs: { name: 'addressLine1', placeholder: 'Address line 1' } });
  const cityInput = createElement({ tagName: 'INPUT', id: 'city', type: 'text', attrs: { name: 'locality', placeholder: 'City' } });
  const postalInput = createElement({ tagName: 'INPUT', id: 'postal', type: 'text', attrs: { name: 'postalCode', placeholder: 'Postal code' } });
  const suggestionOption = createElement({ tagName: 'LI', text: 'Unter den Linden 1, Berlin', attrs: { role: 'option', class: 'pac-item' } });
  const subscribeButton = createElement({ tagName: 'BUTTON', text: 'Subscribe', attrs: { type: 'submit', 'aria-label': 'Subscribe' } });
  subscribeButton.type = 'submit';
  elements.push(paymentButton, fullNameInput, addressInput, cityInput, postalInput, suggestionOption, subscribeButton);

  const context = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    location: { href: 'https://chatgpt.com/checkout/openai_ie/cs_test' },
    window: {},
    CSS: { escape: (value) => String(value) },
    Event: class TestEvent { constructor(type) { this.type = type; } },
    MouseEvent: class TestMouseEvent { constructor(type) { this.type = type; } },
    PointerEvent: class TestPointerEvent { constructor(type) { this.type = type; } },
    document: {
      readyState: 'complete',
      body: {},
      documentElement: {
        getAttribute(name) {
          return attrs.get(name) || null;
        },
        setAttribute(name, nextValue) {
          attrs.set(name, String(nextValue));
        },
      },
      getElementById() {
        return null;
      },
      querySelectorAll(selector) {
        const text = String(selector || '');
        if (text.includes('label[for=')) return [];
        if (text.includes('[role="option"]') || text.includes('.pac-item') || text === 'li') return [suggestionOption];
        if (text === 'input, textarea') return elements.filter((element) => element.tagName === 'INPUT');
        if (text.includes('button[type="submit"]')) return [subscribeButton];
        if (text.includes('button') || text.includes('[role=') || text.includes('[tabindex]') || text.includes('[data-testid]')) {
          return elements.filter((element) => element.tagName === 'BUTTON');
        }
        if (text.includes('select') || text.includes('[aria-haspopup="listbox"]')) return [];
        return [];
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    CodexOperationDelay: {
      async performOperationWithDelay(metadata, operation) {
        checkoutEvents.push({ type: 'operation', label: metadata.label, kind: metadata.kind });
        const result = await operation();
        checkoutEvents.push({ type: 'delay', label: metadata.label, ms: 2000 });
        return result;
      },
    },
    resetStopState() {},
    isStopError() { return false; },
    throwIfStopped() {},
    sleep() { return Promise.resolve(); },
    log() {},
    fillInput(element, nextValue) {
      element.value = nextValue;
    },
    simulateClick(element) {
      if (element === paymentButton && markPaymentSelected) {
        paymentButton.setAttribute('aria-selected', 'true');
      }
    },
  };
  context.window = context;
  context.window.getComputedStyle = (element) => element?.style || { display: 'block', visibility: 'visible' };

  vm.createContext(context);
  vm.runInContext(plusCheckoutSource, context);
  assert.equal(typeof listener, 'function');

  async function send(message) {
    return await new Promise((resolve) => {
      listener(message, {}, resolve);
    });
  }

  return { checkoutEvents, send };
}

function createHostedCheckoutHarness(options = {}) {
  const storageLocalState = { ...(options.storageLocalState || {}) };
  const fetchedCodes = Array.isArray(options.fetchHostedCodes) ? options.fetchHostedCodes.slice() : [];
  const payPalStateSequence = Array.isArray(options.payPalStateSequence) && options.payPalStateSequence.length > 0
    ? options.payPalStateSequence.map((state) => ({ ...state }))
    : [{ hostedStage: 'guest_checkout' }];
  const paypalMessages = [];
  const logs = [];
  const fetchCalls = [];
  let fetchedCodeIndex = 0;
  let payPalStateIndex = 0;
  let activePayPalState = payPalStateSequence[0];
  let currentTabId = 77;
  let currentTabUrl = 'https://chatgpt.com/';
  let failedNodeId = '';

  let completeResolve;
  let completeReject;
  const completionPromise = new Promise((resolve, reject) => {
    completeResolve = resolve;
    completeReject = reject;
  });

  function pushLog(message, level = 'info') {
    logs.push(String(message));
    if (typeof options.onLog === 'function') {
      options.onLog({ message, level });
    }
  }

  function cloneState(state = {}) {
    return { ...state };
  }

  function nextPayPalState() {
    const state = cloneState(payPalStateSequence[Math.min(payPalStateIndex, payPalStateSequence.length - 1)] || {});
    activePayPalState = state;
    if (payPalStateIndex < payPalStateSequence.length - 1) {
      payPalStateIndex += 1;
    }
    return state;
  }

  function getCurrentTab() {
    return { id: currentTabId, url: currentTabUrl };
  }

  function resolveCompletion(payload) {
    if (completeResolve) {
      completeResolve(payload);
      completeResolve = null;
      completeReject = null;
    }
  }

  function rejectCompletion(step, message) {
    failedNodeId = step;
    pushLog(message, 'error');
    if (completeReject) {
      completeReject(Object.assign(new Error(message), { step }));
      completeResolve = null;
      completeReject = null;
    }
  }

  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      pushLog(message, level);
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) {
              return keys.reduce((result, key) => {
                if (Object.prototype.hasOwnProperty.call(storageLocalState, key)) {
                  result[key] = storageLocalState[key];
                }
                return result;
              }, {});
            }
            if (typeof keys === 'string') {
              return {
                [keys]: storageLocalState[keys],
              };
            }
            if (keys && typeof keys === 'object') {
              return Object.keys(keys).reduce((result, key) => {
                result[key] = Object.prototype.hasOwnProperty.call(storageLocalState, key)
                  ? storageLocalState[key]
                  : keys[key];
                return result;
              }, {});
            }
            return { ...storageLocalState };
          },
          async set(nextState) {
            Object.assign(storageLocalState, nextState);
          },
        },
      },
      tabs: {
        async create(payload) {
          currentTabId = 77;
          currentTabUrl = String(payload?.url || currentTabUrl);
          return { id: currentTabId, url: currentTabUrl };
        },
        async update(tabId, payload) {
          if (Number(tabId) === currentTabId && payload?.url) {
            currentTabUrl = String(payload.url);
          }
        },
        async get(tabId) {
          if (Number(tabId) !== currentTabId) {
            return null;
          }
          return getCurrentTab();
        },
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      if (step === 'plus-checkout-create') {
        resolveCompletion({ step, payload });
      }
    },
    enableHostedCheckoutAutomation: true,
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    failNodeFromBackground: async (step, message) => {
      rejectCompletion(step, message);
    },
    fetch: async (url) => {
      fetchCalls.push(String(url || ''));
      if (/meiguodizhi\.com\/api\/v1\/dz/i.test(String(url || ''))) {
        const addressPayload = options.hostedAddressResponse || {
          address: {
            Address: '123 Main St',
            City: 'New York',
            State_Full: 'New York',
            Zip_Code: '10001',
          },
        };
        return {
          ok: true,
          status: 200,
          json: async () => addressPayload,
          text: async () => JSON.stringify(addressPayload),
        };
      }

      const code = fetchedCodeIndex < fetchedCodes.length
        ? fetchedCodes[fetchedCodeIndex]
        : '';
      fetchedCodeIndex += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code }),
        text: async () => String(code),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (_tabId, source, message) => {
      if (source === 'paypal-flow' && message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        paypalMessages.push(message);
        if (typeof options.onPayPalMessage === 'function') {
          options.onPayPalMessage(message);
        }
      }

      if (message.type === 'CREATE_PLUS_CHECKOUT') {
        return {
          checkoutUrl: 'https://chatgpt.com/checkout/openai_ie/cs_hosted_test',
          hostedCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_hosted_test',
          preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_hosted_test',
          country: 'US',
          currency: 'USD',
        };
      }

      if (message.type === 'RUN_HOSTED_OPENAI_CHECKOUT_STEP') {
        currentTabUrl = options.payPalLandingUrl || 'https://www.paypal.com/checkoutweb/signup?token=hosted-test';
        return {
          stage: 'verification',
          submitted: true,
        };
      }

      if (message.type === 'PLUS_CHECKOUT_GET_STATE') {
        return {
          hostedVerificationVisible: false,
        };
      }

      if (source === 'paypal-flow' && message.type === 'PAYPAL_HOSTED_GET_STATE') {
        return nextPayPalState();
      }

      if (source === 'paypal-flow' && message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP') {
        const payload = message.payload || {};

        if (payload.action === 'check-verification-failure') {
          const state = nextPayPalState();
          return {
            stage: state.hostedStage || 'verification',
            verificationFailed: Boolean(state.verificationFailed),
            resendAvailable: Boolean(state.resendAvailable),
            failureMessage: state.failureMessage || '',
          };
        }

        const state = activePayPalState || {};
        if (payload.action === 'click-verification-resend') {
          return {
            stage: state.hostedStage || 'verification',
            clicked: true,
            text: 'Resend',
          };
        }

        if (payload.verificationCode) {
          if (state.hostedStage === 'guest_checkout') {
            currentTabUrl = 'https://chatgpt.com/payments/success';
          }
          return {
            stage: 'verification',
            codeSubmitted: true,
          };
        }

        if (state.hostedStage === 'guest_checkout') {
          currentTabUrl = 'https://chatgpt.com/payments/success';
        }

        return {
          stage: state.hostedStage || 'verification',
          submitted: true,
        };
      }

      return {};
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher) => {
      const tab = getCurrentTab();
      if (typeof matcher === 'function' && matcher(tab.url, tab)) {
        return tab;
      }
      return null;
    },
  });

  async function runHostedCheckoutPayPalFlow(state = {}) {
    const execution = executor.executePlusCheckoutCreate({
      ...state,
      plusPaymentMethod: 'paypal',
    });
    await Promise.all([
      execution,
      completionPromise,
    ]);
  }

  return {
    runHostedCheckoutPayPalFlow,
    get failedNodeId() {
      return failedNodeId;
    },
    logs,
    paypalMessages,
    fetchCalls,
    storageLocalState,
  };
}

function createGpcBalanceResponse(overrides = {}) {
  return {
    code: 200,
    message: 'ok',
    data: {
      api_key: 'gpc_test',
      status: 'active',
      auto_mode_enabled: false,
      total_uses: 1000,
      remaining_uses: 998,
      used_uses: 2,
      ...overrides,
    },
  };
}

function createGpcTaskResponse(overrides = {}) {
  return {
    code: 200,
    message: 'ok',
    data: {
      task_id: 'task_123',
      status: 'active',
      status_text: '处理中',
      phone_mode: 'manual',
      remote_stage: 'checkout_start',
      ...overrides,
    },
  };
}

test('Plus checkout create uses internal PayPal checkout generation and waits for the hosted success page instead of finishing immediately', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome: {
      tabs: {
        create: async (payload) => {
          events.push({ type: 'tab-create', payload });
          return { id: 42 };
        },
        update: async (tabId, payload) => {
          events.push({ type: 'tab-update', tabId, payload });
        },
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {
      events.push({ type: 'ready' });
    },
    registerTab: async (source, tabId) => {
      events.push({ type: 'register', source, tabId });
    },
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      events.push({ type: 'tab-message', tabId, source, message });
      return {
        checkoutUrl: 'https://chatgpt.com/checkout/openai_ie/cs_live_session',
        chatgptCheckoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_live_session',
        hostedCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_session',
        preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_session',
        country: 'US',
        currency: 'USD',
      };
    },
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async (ms) => {
      events.push({ type: 'sleep', ms });
    },
    waitForTabCompleteUntilStopped: async () => {
      events.push({ type: 'tab-complete' });
    },
  });

  await executor.executePlusCheckoutCreate();

  assert.deepEqual(
    events.find((event) => event.type === 'tab-create'),
    { type: 'tab-create', payload: { url: 'https://chatgpt.com/', active: true } }
  );
  assert.deepEqual(
    events.find((event) => event.type === 'register'),
    { type: 'register', source: 'plus-checkout', tabId: 42 }
  );

  const sleepEvents = events.filter((event) => event.type === 'sleep');
  assert.deepStrictEqual(sleepEvents.map((event) => event.ms), [1000, 1000]);
  assert.deepStrictEqual(
    events.find((event) => event.type === 'tab-message')?.message?.payload,
    { paymentMethod: 'paypal' }
  );
  assert.equal(events.some((event) => event.type === 'fetch'), false);

  const readyLogIndex = events.findIndex((event) => event.type === 'log' && /已就绪/.test(event.message));
  assert.ok(readyLogIndex > -1);
  assert.equal(events.some((event) => event.type === 'complete'), false);
  assert.equal(events.some((event) => event.type === 'log' && /等待支付成功页出现后，再继续 OAuth 流程/.test(event.message)), true);
  assert.equal(events.some((event) => event.type === 'sleep' && event.ms === 20000), false);
});

test('GoPay plus checkout create forwards gopay payment method to the checkout content script', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 99 }),
        update: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (_tabId, _source, message) => {
      events.push(message);
      return {
        checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/test-session',
        country: 'ID',
        currency: 'IDR',
      };
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({ plusPaymentMethod: 'gopay' });

  assert.deepStrictEqual(events[0]?.payload, { paymentMethod: 'gopay' });
});

test('Plus checkout create opens hosted external checkout url before billing step continues', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 77 }),
        update: async (tabId, payload) => {
          events.push({ type: 'tab-update', tabId, payload });
        },
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({
      checkoutUrl: 'https://chatgpt.com/checkout/openai_ie/cs_live_converted',
      chatgptCheckoutUrl: 'https://chatgpt.com/checkout/openai_llc/cs_live_converted',
      hostedCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_converted',
      preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_converted',
      country: 'US',
      currency: 'USD',
    }),
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => ({ id: 77, url: 'https://pay.openai.com/c/pay/hosted_cs_live_converted' }),
  });

  await executor.executePlusCheckoutCreate({ plusPaymentMethod: 'paypal' });

  assert.deepStrictEqual(events.find((event) => event.type === 'tab-update'), {
    type: 'tab-update',
    tabId: 77,
    payload: {
      url: 'https://pay.openai.com/c/pay/hosted_cs_live_converted',
      active: true,
    },
  });
  assert.deepStrictEqual(events.find((event) => event.type === 'set-state')?.payload, {
    plusCheckoutTabId: 77,
    plusCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_converted',
    plusCheckoutCountry: 'US',
    plusCheckoutCurrency: 'USD',
    plusReturnUrl: '',
    plusCheckoutSource: '',
  });
});

test('Plus checkout create waits for hosted checkout success page before continuing to OAuth', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome: {
      tabs: {
        create: async () => ({ id: 78 }),
        update: async (tabId, payload) => {
          events.push({ type: 'tab-update', tabId, payload });
        },
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({
      checkoutUrl: 'https://chatgpt.com/checkout/openai_ie/cs_live_converted',
      hostedCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_final',
      preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_final',
      country: 'US',
      currency: 'USD',
    }),
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async () => ({ id: 78, url: 'https://pay.openai.com/c/pay/hosted_cs_live_final' }),
  });

  await executor.executePlusCheckoutCreate({
    plusModeEnabled: true,
    plusPaymentMethod: 'paypal',
  });

  assert.equal(events.some((event) => event.type === 'complete'), false);
  assert.deepStrictEqual(events.find((event) => event.type === 'set-state')?.payload, {
    plusCheckoutTabId: 78,
    plusCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_final',
    plusCheckoutCountry: 'US',
    plusCheckoutCurrency: 'USD',
    plusReturnUrl: '',
    plusCheckoutSource: '',
  });
  assert.equal(events.some((event) => event.type === 'log' && /等待支付成功页出现后，再继续 OAuth 流程/.test(event.message)), true);
});

test('hosted checkout automation completes plus-checkout-create after success page', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome: {
      tabs: {
        create: async () => ({ id: 79 }),
        update: async () => {},
        get: async () => ({ id: 79, url: 'https://chatgpt.com/payments/success' }),
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    enableHostedCheckoutAutomation: true,
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => ({
      ok: true,
      json: async () => ({
        address: {
          Address: '123 Main St',
          City: 'New York',
          State_Full: 'New York',
          Zip_Code: '10001',
        },
      }),
    }),
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (_tabId, _source, message) => {
      if (message.type === 'CREATE_PLUS_CHECKOUT') {
        return {
          checkoutUrl: 'https://chatgpt.com/checkout/openai_ie/cs_live_final',
          hostedCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_final',
          preferredCheckoutUrl: 'https://pay.openai.com/c/pay/hosted_cs_live_final',
          country: 'US',
          currency: 'USD',
        };
      }
      return {};
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (_tabId, matcher) => {
      const successTab = { id: 79, url: 'https://chatgpt.com/payments/success' };
      if (matcher(successTab.url, successTab)) {
        return successTab;
      }
      return { id: 79, url: 'https://pay.openai.com/c/pay/hosted_cs_live_final' };
    },
  });

  await executor.executePlusCheckoutCreate({
    plusModeEnabled: true,
    plusPaymentMethod: 'paypal',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(events.find((event) => event.type === 'complete'), {
    type: 'complete',
    step: 'plus-checkout-create',
    payload: {
      plusCheckoutCountry: 'US',
      plusCheckoutCurrency: 'USD',
    },
  });
});

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
      { hostedStage: 'guest_checkout' },
    ],
  });

  await harness.runHostedCheckoutPayPalFlow();

  const verificationActions = paypalMessages
    .map((item) => item.payload?.action || (item.payload?.verificationCode ? 'submit-code' : ''))
    .filter(Boolean);
  const submittedCodes = paypalMessages
    .map((item) => item.payload?.verificationCode || '')
    .filter(Boolean);

  assert.deepEqual(verificationActions, [
    'click-verification-resend',
    'submit-code',
  ]);
  assert.deepEqual(submittedCodes, ['654321']);
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
      { hostedStage: 'guest_checkout' },
    ],
  });

  await harness.runHostedCheckoutPayPalFlow();

  const verificationActions = payPalStepPayloads
    .map((payload) => payload.action || (payload.verificationCode ? `submit:${payload.verificationCode}` : ''))
    .filter(Boolean);

  assert.deepEqual(verificationActions, [
    'submit:111111',
    'check-verification-failure',
    'click-verification-resend',
    'submit:222222',
  ]);
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

test('Plus checkout content routes billing operations through the operation delay gate', async () => {
  const { checkoutEvents, send } = createCheckoutContentHarness();

  const result = await send({
    type: 'FILL_PLUS_BILLING_AND_SUBMIT',
    source: 'test',
    payload: {
      fullName: 'Ada Lovelace',
      addressSeed: {
        skipAutocomplete: true,
        fallback: {
          address1: 'Unter den Linden',
          city: 'Berlin',
          region: 'Berlin',
          postalCode: '10117',
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepStrictEqual(checkoutEvents.filter((event) => event.type === 'operation').map((event) => event.label), [
    'select-payment-method',
    'fill-billing-address',
    'click-subscribe',
  ]);
  assert.deepStrictEqual(checkoutEvents.filter((event) => event.type === 'delay').map((event) => event.ms), [2000, 2000, 2000]);
});

test('Plus checkout content routes same-frame autocomplete query and suggestion through separate operation delays', async () => {
  const { checkoutEvents, send } = createCheckoutContentHarness();

  const result = await send({
    type: 'FILL_PLUS_BILLING_AND_SUBMIT',
    source: 'test',
    payload: {
      fullName: 'Ada Lovelace',
      addressSeed: {
        query: 'Unter den Linden',
        suggestionIndex: 0,
        fallback: {
          address1: 'Unter den Linden',
          city: 'Berlin',
          region: 'Berlin',
          postalCode: '10117',
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepStrictEqual(checkoutEvents.filter((event) => event.type === 'operation').map((event) => event.label), [
    'select-payment-method',
    'fill-address-query',
    'select-address-suggestion',
    'fill-billing-address',
    'click-subscribe',
  ]);
  assert.deepStrictEqual(checkoutEvents.filter((event) => event.type === 'delay').map((event) => event.label), [
    'select-payment-method',
    'fill-address-query',
    'select-address-suggestion',
    'fill-billing-address',
    'click-subscribe',
  ]);
  assert.equal(checkoutEvents.some((event) => event.type === 'delay' && event.ms !== 2000), false);
});

test('Plus checkout content allows hosted PayPal mode to continue without standard selected marker', async () => {
  const { send } = createCheckoutContentHarness({ markPaymentSelected: false });

  const result = await send({
    type: 'FILL_PLUS_BILLING_AND_SUBMIT',
    source: 'test',
    payload: {
      hostedCheckoutMode: true,
      paymentMethod: 'paypal',
      fullName: 'Ada Lovelace',
      addressSeed: {
        skipAutocomplete: true,
        fallback: {
          address1: 'Unter den Linden',
          city: 'Berlin',
          region: 'Berlin',
          postalCode: '10117',
        },
      },
    },
  });

  assert.equal(result.ok, true);
});

test('GPC manual checkout injects Plus script before reading ChatGPT session token and sends X-API-Key', async () => {
  const events = [];
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => events.push({ type: 'log', message, level }),
    chrome: {
      tabs: {
        create: async (payload) => {
          events.push({ type: 'tab-create', payload });
          return { id: 77 };
        },
        remove: async (tabId) => events.push({ type: 'tab-remove', tabId }),
      },
    },
    completeNodeFromBackground: async (step, payload) => events.push({ type: 'complete', step, payload }),
    ensureContentScriptReadyOnTabUntilStopped: async (source, tabId, options) => events.push({ type: 'ready', source, tabId, options }),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => url.endsWith('/api/gp/balance')
          ? createGpcBalanceResponse({ auto_mode_enabled: false, remaining_uses: 998 })
          : createGpcTaskResponse({ otp_channel: 'whatsapp' }),
      };
    },
    registerTab: async (source, tabId) => events.push({ type: 'register', source, tabId }),
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      events.push({ type: 'tab-message', tabId, source, message });
      return { accessToken: 'session-access-token' };
    },
    setState: async (payload) => events.push({ type: 'set-state', payload }),
    sleepWithStop: async (ms) => events.push({ type: 'sleep', ms }),
    waitForTabCompleteUntilStopped: async () => events.push({ type: 'tab-complete' }),
  });

  await executor.executePlusCheckoutCreate({
    email: 'Current.Round+GPC@Example.COM',
    plusPaymentMethod: 'gpc-helper',
    gopayHelperPhoneMode: 'manual',
    gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
    gopayHelperPhoneNumber: '+8613800138000',
    gopayPhone: '',
    gopayHelperCountryCode: '+86',
    gopayHelperPin: '123456',
    gopayHelperApiKey: 'gpc_test_123',
  });

  const readyIndex = events.findIndex((event) => event.type === 'ready');
  const messageIndex = events.findIndex((event) => event.type === 'tab-message');
  assert.ok(readyIndex >= 0);
  assert.ok(messageIndex > readyIndex);
  assert.equal(events[messageIndex].message.type, 'PLUS_CHECKOUT_GET_STATE');
  assert.deepEqual(events[messageIndex].message.payload, {
    includeSession: true,
    includeAccessToken: true,
  });
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://your-gpc-helper-domain.example/api/gp/balance');
  assert.equal(fetchCalls[0].options.headers['X-API-Key'], 'gpc_test_123');
  assert.equal(fetchCalls[1].url, 'https://your-gpc-helper-domain.example/api/gp/tasks');
  const helperPayload = JSON.parse(fetchCalls[1].options.body);
  assert.deepEqual(helperPayload, {
    access_token: 'session-access-token',
    phone_mode: 'manual',
    country_code: '86',
    phone_number: '13800138000',
    otp_channel: 'whatsapp',
  });
  assert.equal(fetchCalls[1].options.headers['X-API-Key'], 'gpc_test_123');
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'card_key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'customer_email'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'checkout_ui_mode'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'gopay_link'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'plan_name'), false);
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.plusCheckoutSource, 'gpc-helper');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperTaskId, 'task_123');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperTaskStatus, 'active');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperStatusText, '处理中');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperRemoteStage, 'checkout_start');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperReferenceId, '');
  assert.ok(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperOrderCreatedAt > 0);
  assert.equal(events.find((event) => event.type === 'complete')?.step, 'plus-checkout-create');
  assert.equal(events.find((event) => event.type === 'complete')?.payload?.plusCheckoutSource, 'gpc-helper');
});


test('GPC auto checkout only sends access token and API Key', async () => {
  const events = [];
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => events.push({ type: 'log', message, level }),
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async (step, payload) => events.push({ type: 'complete', step, payload }),
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => url.endsWith('/api/gp/balance')
          ? createGpcBalanceResponse({ auto_mode_enabled: true, remaining_uses: 998 })
          : createGpcTaskResponse({
              task_id: 'task_auto',
              status: 'queued',
              status_text: '排队中',
              phone_mode: 'auto',
              api_waiting_for: '',
            }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({}),
    setState: async (payload) => events.push({ type: 'set-state', payload }),
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({
    plusPaymentMethod: 'gpc-helper',
    gopayHelperPhoneMode: 'auto',
    gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
    chatgptAccessToken: 'state-access-token',
    gopayHelperApiKey: 'gpc_auto_123',
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://your-gpc-helper-domain.example/api/gp/balance');
  assert.equal(fetchCalls[0].options.headers['X-API-Key'], 'gpc_auto_123');
  assert.equal(fetchCalls[1].url, 'https://your-gpc-helper-domain.example/api/gp/tasks');
  const helperPayload = JSON.parse(fetchCalls[1].options.body);
  assert.deepEqual(helperPayload, {
    access_token: 'state-access-token',
    phone_mode: 'auto',
  });
  assert.equal(fetchCalls[1].options.headers['X-API-Key'], 'gpc_auto_123');
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'country_code'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'phone_number'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'otp_channel'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'pin'), false);
  const statePayload = events.find((event) => event.type === 'set-state')?.payload || {};
  assert.equal(statePayload.gopayHelperTaskId, 'task_auto');
  assert.equal(Object.prototype.hasOwnProperty.call(statePayload, 'gopayHelperPhoneMode'), false);
  assert.equal(statePayload.gopayHelperTaskStatus, 'queued');
  assert.equal(events.find((event) => event.type === 'complete')?.step, 'plus-checkout-create');
});

test('GPC auto checkout keeps running when balance payload omits auto mode permission', async () => {
  const events = [];
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async (step, payload) => events.push({ type: 'complete', step, payload }),
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => url.endsWith('/api/gp/balance')
          ? createGpcBalanceResponse({ auto_mode_enabled: undefined, remaining_uses: 998 })
          : createGpcTaskResponse({
              task_id: 'task_auto_unknown_permission',
              status: 'queued',
              status_text: '排队中',
              phone_mode: 'auto',
              api_waiting_for: '',
            }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({}),
    setState: async (payload) => events.push({ type: 'set-state', payload }),
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({
    plusPaymentMethod: 'gpc-helper',
    gopayHelperPhoneMode: 'auto',
    gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
    chatgptAccessToken: 'state-access-token',
    gopayHelperApiKey: 'gpc_auto_123',
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://your-gpc-helper-domain.example/api/gp/balance');
  assert.equal(fetchCalls[1].url, 'https://your-gpc-helper-domain.example/api/gp/tasks');
  const helperPayload = JSON.parse(fetchCalls[1].options.body);
  assert.equal(helperPayload.phone_mode, 'auto');
  const statePayload = events.find((event) => event.type === 'set-state')?.payload || {};
  assert.equal(statePayload.gopayHelperTaskId, 'task_auto_unknown_permission');
  assert.equal(Object.prototype.hasOwnProperty.call(statePayload, 'gopayHelperPhoneMode'), false);
  assert.equal(events.find((event) => event.type === 'complete')?.step, 'plus-checkout-create');
});

test('GPC auto checkout blocks API Keys without auto mode permission', async () => {
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => createGpcBalanceResponse({ auto_mode_enabled: false, remaining_uses: 998 }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({}),
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      plusPaymentMethod: 'gpc-helper',
      gopayHelperPhoneMode: 'auto',
      gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
      chatgptAccessToken: 'state-access-token',
      gopayHelperApiKey: 'gpc_auto_disabled',
    }),
    /未开通自动模式/
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://your-gpc-helper-domain.example/api/gp/balance');
});

test('GPC checkout blocks exhausted API Keys before creating task', async () => {
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => createGpcBalanceResponse({ auto_mode_enabled: false, remaining_uses: 0 }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({}),
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      plusPaymentMethod: 'gpc-helper',
      gopayHelperPhoneMode: 'manual',
      gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
      chatgptAccessToken: 'state-access-token',
      gopayHelperPhoneNumber: '+8613800138000',
      gopayHelperCountryCode: '+86',
      gopayHelperPin: '123456',
      gopayHelperApiKey: 'gpc_exhausted',
    }),
    /剩余次数不足/
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://your-gpc-helper-domain.example/api/gp/balance');
});

test('GPC checkout forwards selected SMS OTP channel', async () => {
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 88 }),
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => url.endsWith('/api/gp/balance')
          ? createGpcBalanceResponse({ auto_mode_enabled: false, remaining_uses: 998 })
          : createGpcTaskResponse({ task_id: 'task_sms', status: 'active', phone_mode: 'manual', remote_stage: 'checkout_start' }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({ accessToken: 'session-access-token' }),
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({
    email: 'sms@example.com',
    plusPaymentMethod: 'gpc-helper',
    gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
    gopayHelperPhoneNumber: '+8613800138000',
    gopayHelperCountryCode: '+86',
    gopayHelperPin: '123456',
    gopayHelperApiKey: 'gpc_sms',
    gopayHelperOtpChannel: 'sms',
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://your-gpc-helper-domain.example/api/gp/balance');
  assert.equal(fetchCalls[0].options.headers['X-API-Key'], 'gpc_sms');
  const helperPayload = JSON.parse(fetchCalls[1].options.body);
  assert.equal(helperPayload.phone_mode, 'manual');
  assert.equal(helperPayload.otp_channel, 'sms');
  assert.equal(fetchCalls[1].options.headers['X-API-Key'], 'gpc_sms');
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'card_key'), false);
});

test('GPC checkout surfaces unified queue API errors', async () => {
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url.endsWith('/api/gp/balance')) {
        return {
          ok: true,
          status: 200,
          json: async () => createGpcBalanceResponse({ auto_mode_enabled: false, remaining_uses: 998 }),
        };
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({
          code: 400,
          message: 'invalid_param',
          data: { detail: 'access_token 无效' },
        }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => {},
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      email: 'paid@example.com',
      plusPaymentMethod: 'gpc-helper',
      gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
      chatgptAccessToken: 'state-access-token',
      gopayHelperPhoneNumber: '+8613800138000',
      gopayHelperCountryCode: '+86',
      gopayHelperPin: '123456',
      gopayHelperApiKey: 'gpc_paid_456',
    }),
    /创建 GPC 订单失败：access_token 无效/
  );

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://your-gpc-helper-domain.example/api/gp/balance');
  assert.equal(fetchCalls[1].url, 'https://your-gpc-helper-domain.example/api/gp/tasks');
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(fetchCalls[1].options.body), 'card_key'), false);
  assert.equal(fetchCalls[1].options.headers['X-API-Key'], 'gpc_paid_456');
});

test('GPC checkout does not fall back to browser GoPay phone fields', async () => {
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => {
      throw new Error('should not call helper API without helper phone');
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => {},
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      plusPaymentMethod: 'gpc-helper',
      gopayHelperPhoneMode: 'manual',
      gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
      chatgptAccessToken: 'state-access-token',
      email: 'helper-phone-test@example.com',
      gopayPhone: '+8613800138000',
      gopayCountryCode: '+86',
      gopayPin: '123456',
      gopayHelperPhoneNumber: '',
      gopayHelperPin: '123456',
      gopayHelperApiKey: 'gpc_phone_test',
    }),
    /缺少手机号/
  );
});

test('GPC checkout rejects missing API Key before calling helper API', async () => {
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeNodeFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => {
      throw new Error('should not call helper API without API Key');
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => {},
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      plusPaymentMethod: 'gpc-helper',
      gopayHelperApiUrl: 'https://your-gpc-helper-domain.example/',
      chatgptAccessToken: 'state-access-token',
      email: 'missing-card@example.com',
      gopayHelperPhoneNumber: '+8613800138000',
      gopayHelperCountryCode: '+86',
      gopayHelperPin: '123456',
      gopayHelperApiKey: '',
    }),
    /缺少 API Key/
  );
});
