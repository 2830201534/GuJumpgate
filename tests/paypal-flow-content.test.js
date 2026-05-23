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
    name: overrides.name || '',
    tagName: String(overrides.tagName || 'INPUT').toUpperCase(),
    options: overrides.options || [],
    labels: overrides.labels || [],
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

function loadHooks({
  errorVisible = false,
  includeVerificationInputs = true,
  locationOverrides = {},
  extraElements = [],
  querySelectorMap = new Map(),
} = {}) {
  const source = fs.readFileSync('content/paypal-flow.js', 'utf8');
  const inputs = includeVerificationInputs
    ? Array.from({ length: 6 }, (_, index) => createVisibleElement({ id: `ci-ciBasic-${index}` }))
    : [];
  const errorElement = createVisibleElement({ textContent: 'error' });
  const resendButton = createVisibleElement({ textContent: 'Resend' });
  const allElements = [...inputs, ...extraElements];
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
    location: {
      href: 'https://www.paypal.com/webapps/hermes',
      host: 'www.paypal.com',
      pathname: '/webapps/hermes',
      ...locationOverrides,
    },
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
        return allElements.find((input) => input.id === id) || null;
      },
      querySelector(selector) {
        return querySelectorMap.get(selector) || null;
      },
      querySelectorAll(selector) {
        if (selector === 'input') {
          return allElements.filter((element) => element.tagName === 'INPUT');
        }
        if (selector === 'select') {
          return allElements.filter((element) => element.tagName === 'SELECT');
        }
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
    extraElements,
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

test('paypal flow content treats checkoutweb signup page as guest checkout instead of login', () => {
  const emailInput = createVisibleElement({ id: 'email', name: 'email' });
  const cardNumberInput = createVisibleElement({ id: 'card-number-field', name: 'cardNumber' });
  const { hooks } = loadHooks({
    includeVerificationInputs: false,
    locationOverrides: {
      href: 'https://www.paypal.com/checkoutweb/signup?token=abc',
      pathname: '/checkoutweb/signup',
    },
    extraElements: [emailInput, cardNumberInput],
  });
  assert.equal(hooks.isPayPalHostedGuestCheckoutPage(), true);
  assert.equal(hooks.isPayPalHostedLoginPage(), false);
  assert.equal(hooks.detectPayPalHostedCheckoutStage(), 'guest_checkout');
});

test('paypal flow content fills hosted guest checkout fields via alias candidates', async () => {
  const emailInput = createVisibleElement({ id: 'guestEmail', name: 'emailAddress' });
  const phoneInput = createVisibleElement({ id: 'guestPhone', name: 'phoneNumber' });
  const cardNumberInput = createVisibleElement({ id: 'guestCard', name: 'cardNumber' });
  const expiryInput = createVisibleElement({ id: 'guestExpiry', name: 'expirationDate' });
  const cvvInput = createVisibleElement({ id: 'guestCvv', name: 'securityCode' });
  const passwordInput = createVisibleElement({ id: 'guestPassword', name: 'password' });
  const firstNameInput = createVisibleElement({ id: 'guestFirstName', name: 'givenName' });
  const lastNameInput = createVisibleElement({ id: 'guestLastName', name: 'surname' });
  const addressInput = createVisibleElement({ id: 'guestAddress1', name: 'billingAddressLine1' });
  const cityInput = createVisibleElement({ id: 'guestCity', name: 'billingLocality' });
  const zipInput = createVisibleElement({ id: 'guestZip', name: 'postalCode' });
  const stateSelect = createVisibleElement({
    id: 'guestState',
    name: 'region',
    tagName: 'SELECT',
    options: [
      { value: 'CA', textContent: 'California' },
      { value: 'NY', textContent: 'New York' },
    ],
  });
  const submitButton = createVisibleElement({ tagName: 'BUTTON', textContent: 'Pay' });
  const querySelectorMap = new Map([
    ['button[data-testid="submit-button"]', submitButton],
  ]);
  const { hooks } = loadHooks({
    includeVerificationInputs: false,
    locationOverrides: {
      href: 'https://www.paypal.com/checkoutweb/signup?token=abc',
      pathname: '/checkoutweb/signup',
    },
    extraElements: [
      emailInput,
      phoneInput,
      cardNumberInput,
      expiryInput,
      cvvInput,
      passwordInput,
      firstNameInput,
      lastNameInput,
      addressInput,
      cityInput,
      zipInput,
      stateSelect,
    ],
    querySelectorMap,
  });
  const result = await hooks.fillHostedGuestCheckout({
    email: 'test@example.com',
    phone: '1234567890',
    password: 'Aa1234567890!!',
    firstName: 'James',
    lastName: 'Smith',
    cardNumber: '4111111111111111',
    cardExpiry: '08 / 30',
    cardCvv: '123',
    address: {
      street: '123 Main St',
      city: 'Los Angeles',
      state: 'California',
      zip: '90001',
    },
  });
  assert.equal(result.stage, 'guest_checkout');
  assert.equal(emailInput.value, 'test@example.com');
  assert.equal(phoneInput.value, '1234567890');
  assert.equal(cardNumberInput.value, '4111111111111111');
  assert.equal(expiryInput.value, '08 / 30');
  assert.equal(cvvInput.value, '123');
  assert.equal(addressInput.value, '123 Main St');
  assert.equal(cityInput.value, 'Los Angeles');
  assert.equal(zipInput.value, '90001');
  assert.equal(stateSelect.value, 'CA');
});
