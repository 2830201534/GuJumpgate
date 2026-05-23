const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createVisibleElement(overrides = {}) {
  const attributes = new Map(Object.entries(overrides.attributes || {}));
  const element = {
    nodeType: 1,
    hidden: false,
    disabled: false,
    parentElement: null,
    textContent: overrides.textContent || '',
    value: overrides.value || '',
    id: overrides.id || '',
    style: {},
    clickCount: 0,
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getBoundingClientRect() {
      return { width: 24, height: 24, left: 0, top: 0 };
    },
    dispatchEvent() {
      return true;
    },
    click() {
      this.clickCount += 1;
    },
    remove() {},
  };
  return element;
}

function loadHooks({ errorVisible = false } = {}) {
  const source = fs.readFileSync('content/paypal-flow.js', 'utf8');
  const inputs = Array.from({ length: 6 }, (_, index) => createVisibleElement({ id: `ci-ciBasic-${index}` }));
  const errorElement = createVisibleElement({ textContent: 'error' });
  const resendButton = createVisibleElement({ textContent: 'Resend' });
  const storage = new Map();
  const documentElement = {
    attrs: new Map(),
    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null;
    },
    setAttribute(name, value) {
      this.attrs.set(name, String(value));
    },
  };
  const context = {
    console,
    location: { href: 'https://www.paypal.com/webapps/hermes', host: 'www.paypal.com', pathname: '/webapps/hermes' },
    chrome: {
      runtime: {
        onMessage: {
          addListener() {},
        },
      },
    },
    document: {
      readyState: 'complete',
      body: { innerText: '' },
      documentElement,
      evaluate(xpath) {
        if (xpath === '/html/body/div[3]/div/section/div[2]/div[1]') {
          return { singleNodeValue: errorVisible ? errorElement : null };
        }
        if (xpath === '/html/body/div[3]/div/section/div[2]/p/button') {
          return { singleNodeValue: resendButton };
        }
        return { singleNodeValue: null };
      },
      getElementById(id) {
        return inputs.find((input) => input.id === id) || null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    window: {
      getComputedStyle() {
        return {
          display: 'block',
          visibility: 'visible',
          opacity: '1',
        };
      },
      localStorage: {
        getItem(key) {
          return storage.has(key) ? storage.get(key) : null;
        },
        setItem(key, value) {
          storage.set(key, String(value));
        },
      },
      CodexOperationDelay: {
        performOperationWithDelay: async (_metadata, operation) => operation(),
      },
    },
    XPathResult: {
      FIRST_ORDERED_NODE_TYPE: 9,
    },
    Event: function Event() {},
    PointerEvent: function PointerEvent() {},
    MouseEvent: function MouseEvent() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    sleep: async () => {},
    log: () => {},
    simulateClick(target) {
      target.click();
    },
    refillPayPalEmailInput() {},
    fillInput(target, value) {
      target.value = String(value);
    },
    resetStopState() {},
    throwIfStopped() {},
    isStopError() {
      return false;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'content/paypal-flow.js' });
  return {
    hooks: context.MultiPagePayPalFlowTestHooks,
    inputs,
    resendButton,
  };
}

test('paypal flow content stores successful hosted verification code in browser localStorage', async () => {
  const { hooks, inputs } = loadHooks({ errorVisible: false });
  const result = await hooks.fillHostedVerificationCode({ verificationCode: '123456' });
  assert.equal(result.verificationFailed, false);
  assert.equal(hooks.readHostedVerificationStoredCode(), '123456');
  assert.deepEqual(inputs.map((input) => input.value).join(''), '123456');
});

test('paypal flow content flags hosted verification error without overwriting stored code', async () => {
  const { hooks } = loadHooks({ errorVisible: true });
  hooks.writeHostedVerificationStoredCode('654321');
  const result = await hooks.fillHostedVerificationCode({ verificationCode: '123456' });
  assert.equal(result.verificationFailed, true);
  assert.equal(result.resendAvailable, true);
  assert.equal(hooks.readHostedVerificationStoredCode(), '654321');
});

test('paypal flow content clicks xpath based resend button', async () => {
  const { hooks, resendButton } = loadHooks({ errorVisible: true });
  const result = await hooks.resendHostedVerificationCode();
  assert.equal(result.resent, true);
  assert.equal(resendButton.clickCount > 0, true);
});
