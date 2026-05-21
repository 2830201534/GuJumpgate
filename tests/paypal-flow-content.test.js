const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/paypal-flow.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (char === '{' && signatureEnded) {
      braceStart = index;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function createElement({
  tag = 'div',
  tagName = '',
  type = '',
  id = '',
  name = '',
  text = '',
  textContent = '',
  value = '',
  placeholder = '',
  disabled = false,
  attrs = {},
  style = {},
  rect = { width: 160, height: 40 },
  parentElement = null,
} = {}) {
  return {
    nodeType: 1,
    tag: tagName || tag,
    type,
    id,
    name,
    textContent: textContent || text,
    value,
    placeholder,
    disabled,
    hidden: Boolean(attrs.hidden),
    attrs,
    style: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      ...style,
    },
    parentElement,
    getAttribute(key) {
      if (key === 'type') return type;
      if (key === 'id') return id;
      if (key === 'name') return name;
      if (key === 'placeholder') return placeholder;
      if (key === 'value') return value;
      if (key === 'aria-disabled') return attrs[key] ?? (disabled ? 'true' : null);
      return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
    },
    getBoundingClientRect() {
      return rect;
    },
  };
}

function loadApi(elements) {
  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === 'input') {
        return elements.filter((el) => el.tag === 'input');
      }
      if (selector === 'input[type="email"]') {
        return elements.filter((el) => el.tag === 'input' && el.type === 'email');
      }
      if (selector === 'input[type="password"]') {
        return elements.filter((el) => el.tag === 'input' && el.type === 'password');
      }
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        return elements.filter((el) => el.tag === 'button' || el.attrs?.role === 'button');
      }
      return [];
    },
  };
  const window = {
    getComputedStyle(el) {
      return el?.style || { display: 'block', visibility: 'visible', opacity: '1' };
    },
  };

  return new Function('document', 'window', `
${extractFunction('isVisibleElement')}
${extractFunction('normalizeText')}
${extractFunction('getActionText')}
${extractFunction('getVisibleControls')}
${extractFunction('isEnabledControl')}
${extractFunction('findClickableByText')}
${extractFunction('findInputByPatterns')}
${extractFunction('findEmailInput')}
${extractFunction('findPasswordInput')}
${extractFunction('findLoginNextButton')}
${extractFunction('findEmailNextButton')}
${extractFunction('findPasswordLoginButton')}
${extractFunction('getPayPalLoginPhase')}
return {
  findEmailInput,
  findPasswordInput,
  findEmailNextButton,
  findPasswordLoginButton,
  getPayPalLoginPhase,
};
`)(document, window);
}

function createSubmitApi(overrides = {}) {
  const bindings = {
    waitForDocumentComplete: async () => {},
    normalizeText: (text = '') => String(text || '').replace(/\s+/g, ' ').trim(),
    findPasswordInput: () => null,
    findEmailInput: () => null,
    findEmailNextButton: () => null,
    isEnabledControl: () => true,
    findPasswordLoginButton: () => null,
    fillInput: () => {},
    simulateClick: () => {},
    waitUntil: async (predicate) => predicate(),
    findLoginNextButton: () => null,
    sleep: async () => {},
    ...overrides,
  };

  return new Function(
    'waitForDocumentComplete',
    'normalizeText',
    'findPasswordInput',
    'findEmailInput',
    'findEmailNextButton',
    'isEnabledControl',
    'findPasswordLoginButton',
    'fillInput',
    'simulateClick',
    'waitUntil',
    'findLoginNextButton',
    'sleep',
    `
${extractFunction('refillPayPalEmailInput')}
${extractFunction('submitPayPalLogin')}
return { refillPayPalEmailInput, submitPayPalLogin };
`
  )(
    bindings.waitForDocumentComplete,
    bindings.normalizeText,
    bindings.findPasswordInput,
    bindings.findEmailInput,
    bindings.findEmailNextButton,
    bindings.isEnabledControl,
    bindings.findPasswordLoginButton,
    bindings.fillInput,
    bindings.simulateClick,
    bindings.waitUntil,
    bindings.findLoginNextButton,
    bindings.sleep
  );
}

function loadHostedStageApi({ elements = [], locationOverride = {} } = {}) {
  const document = {
    documentElement: {},
    getElementById(id) {
      return elements.find((el) => el.id === id) || null;
    },
    querySelector(selector) {
      if (selector === 'button[data-testid="consentButton"]') {
        return elements.find((el) => el.tag === 'button' && el.getAttribute?.('data-testid') === 'consentButton') || null;
      }
      if (selector === 'button[data-testid="resend-link"]') {
        return elements.find((el) => el.tag === 'button' && el.getAttribute?.('data-testid') === 'resend-link') || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        return elements.filter((el) => el.tag === 'button' || el.attrs?.role === 'button');
      }
      return [];
    },
  };
  const window = {
    getComputedStyle(el) {
      return el?.style || { display: 'block', visibility: 'visible', opacity: '1' };
    },
  };
  const location = {
    host: 'www.paypal.com',
    pathname: '/checkoutweb/demo',
    href: 'https://www.paypal.com/checkoutweb/demo',
    ...locationOverride,
  };

  return new Function('document', 'window', 'location', `
const PAYPAL_HOSTED_STAGE_OUTSIDE = 'outside_paypal';
const PAYPAL_HOSTED_STAGE_LOGIN = 'pay_login';
const PAYPAL_HOSTED_STAGE_GUEST_CHECKOUT = 'guest_checkout';
const PAYPAL_HOSTED_STAGE_VERIFICATION = 'verification';
const PAYPAL_HOSTED_STAGE_REVIEW = 'review_consent';
const PAYPAL_HOSTED_STAGE_APPROVAL = 'approval';
const PAYPAL_HOSTED_STAGE_UNKNOWN = 'unknown';
${extractFunction('isVisibleElement')}
${extractFunction('normalizeText')}
${extractFunction('getActionText')}
${extractFunction('getVisibleControls')}
${extractFunction('isEnabledControl')}
${extractFunction('findClickableByText')}
${extractFunction('findApproveButton')}
${extractFunction('getPayPalHostedPathname')}
${extractFunction('isPayPalHostedLoginPage')}
${extractFunction('isPayPalHostedGuestCheckoutPage')}
${extractFunction('isPayPalHostedReviewPage')}
${extractFunction('findHostedVerificationInputs')}
${extractFunction('hasHostedVerificationInputs')}
${extractFunction('findHostedReviewConsentButton')}
${extractFunction('detectPayPalHostedCheckoutStage')}
return {
  detectPayPalHostedCheckoutStage,
};
`)(document, window, location);
}

function loadHostedVerificationFailureApi({ elements = [], locationOverride = {} } = {}) {
  const document = {
    documentElement: {},
    body: {
      innerText: '',
    },
    getElementById(id) {
      return elements.find((el) => el.id === id) || null;
    },
    querySelector(selector) {
      if (selector === 'button[data-testid="consentButton"]') {
        return elements.find((el) => el.tag === 'button' && el.attrs?.['data-testid'] === 'consentButton') || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        return elements.filter((el) => el.tag === 'button' || el.attrs?.role === 'button');
      }
      if (selector === 'input') {
        return elements.filter((el) => el.tag === 'input');
      }
      if (!selector.includes('input')) {
        return elements.filter((el) => ['div', 'section', 'p', 'span'].includes(el.tag));
      }
      return [];
    },
  };
  const window = {
    getComputedStyle(el) {
      return el?.style || { display: 'block', visibility: 'visible', opacity: '1' };
    },
  };
  const location = {
    host: 'www.paypal.com',
    pathname: '/checkoutweb/demo',
    href: 'https://www.paypal.com/checkoutweb/demo',
    ...locationOverride,
  };

  return new Function('document', 'window', 'location', `
const PAYPAL_HOSTED_STAGE_VERIFICATION = 'verification';
const PAYPAL_HOSTED_VERIFICATION_ERROR_TEXT = 'Sorry, something went wrong. Get a new code.';
const waitForDocumentComplete = async () => {};
const PointerEvent = function PointerEvent(type, init = {}) { return { type, ...init }; };
const MouseEvent = function MouseEvent(type, init = {}) { return { type, ...init }; };
${extractFunction('isVisibleElement')}
${extractFunction('normalizeText')}
${extractFunction('getActionText')}
${extractFunction('getVisibleControls')}
${extractFunction('isEnabledControl')}
${extractFunction('findClickableByText')}
${extractFunction('findHostedVerificationErrorBlock')}
${extractFunction('findHostedVerificationResendButton')}
${extractFunction('detectHostedVerificationFailure')}
${extractFunction('dispatchHostedGenericClick')}
${extractFunction('clickHostedVerificationResend')}
return {
  detectHostedVerificationFailure,
  clickHostedVerificationResend,
};
`)(document, window, location);
}

function createHostedVerificationApi(overrides = {}) {
  const bindings = {
    PAYPAL_HOSTED_STAGE_VERIFICATION: 'verification',
    findHostedVerificationInputs: () => [],
    normalizeHostedVerificationCode: (value = '') => String(value || '').replace(/\\D+/g, '').slice(0, 6),
    waitForDocumentComplete: async () => {},
    performPayPalOperationWithDelay: async (_metadata, operation) => operation(),
    fillInput: () => {},
    ...overrides,
  };

  return new Function(
    'PAYPAL_HOSTED_STAGE_VERIFICATION',
    'findHostedVerificationInputs',
    'normalizeHostedVerificationCode',
    'waitForDocumentComplete',
    'performPayPalOperationWithDelay',
    'fillInput',
    `
${extractFunction('fillHostedVerificationCode')}
return { fillHostedVerificationCode };
`
  )(
    bindings.PAYPAL_HOSTED_STAGE_VERIFICATION,
    bindings.findHostedVerificationInputs,
    bindings.normalizeHostedVerificationCode,
    bindings.waitForDocumentComplete,
    bindings.performPayPalOperationWithDelay,
    bindings.fillInput
  );
}

function createHostedVerificationFailureActionApi(overrides = {}) {
  const bindings = {
    PAYPAL_HOSTED_STAGE_VERIFICATION: 'verification',
    waitForDocumentComplete: async () => {},
    detectPayPalHostedCheckoutStage: () => 'verification',
    detectHostedVerificationFailure: () => ({
      visible: false,
      messageMatched: false,
      verificationFailureDetected: false,
      resendAvailable: false,
      messageText: '',
    }),
    clickHostedVerificationResend: async () => ({ clicked: false }),
    fillHostedVerificationCode: async () => ({ stage: 'verification', codeSubmitted: true }),
    isPayPalHostedReviewPage: () => false,
    clickHostedReviewConsent: async () => ({ stage: 'review_consent', submitted: true }),
    findApproveButton: () => null,
    ...overrides,
  };

  return new Function(
    'PAYPAL_HOSTED_STAGE_VERIFICATION',
    'waitForDocumentComplete',
    'detectPayPalHostedCheckoutStage',
    'detectHostedVerificationFailure',
    'clickHostedVerificationResend',
    'fillHostedVerificationCode',
    'isPayPalHostedReviewPage',
    'clickHostedReviewConsent',
    'findApproveButton',
    `
${extractFunction('runHostedCheckoutStep')}
return { runHostedCheckoutStep };
`
  )(
    bindings.PAYPAL_HOSTED_STAGE_VERIFICATION,
    bindings.waitForDocumentComplete,
    bindings.detectPayPalHostedCheckoutStage,
    bindings.detectHostedVerificationFailure,
    bindings.clickHostedVerificationResend,
    bindings.fillHostedVerificationCode,
    bindings.isPayPalHostedReviewPage,
    bindings.clickHostedReviewConsent,
    bindings.findApproveButton
  );
}

function createHostedReviewApi(overrides = {}) {
  const bindings = {
    PAYPAL_HOSTED_STAGE_REVIEW: 'review_consent',
    waitForDocumentComplete: async () => {},
    isPayPalHostedReviewPage: () => true,
    detectPayPalHostedCheckoutStage: () => 'unknown',
    clickHostedReviewConsent: async () => ({ stage: 'review_consent', submitted: true }),
    ...overrides,
  };

  return new Function(
    'PAYPAL_HOSTED_STAGE_REVIEW',
    'waitForDocumentComplete',
    'isPayPalHostedReviewPage',
    'detectPayPalHostedCheckoutStage',
    'clickHostedReviewConsent',
    `
${extractFunction('runHostedCheckoutStep')}
return { runHostedCheckoutStep };
`
  )(
    bindings.PAYPAL_HOSTED_STAGE_REVIEW,
    bindings.waitForDocumentComplete,
    bindings.isPayPalHostedReviewPage,
    bindings.detectPayPalHostedCheckoutStage,
    bindings.clickHostedReviewConsent
  );
}

test('PayPal email page ignores hidden pre-rendered password input', () => {
  const hiddenPanel = createElement({ attrs: { 'aria-hidden': 'true' } });
  const emailInput = createElement({
    tag: 'input',
    type: 'text',
    id: 'login_email',
    name: 'login_email',
    value: 'user@example.com',
    placeholder: 'Email',
  });
  const hiddenPasswordInput = createElement({
    tag: 'input',
    type: 'password',
    id: 'login_password',
    name: 'login_password',
    parentElement: hiddenPanel,
  });
  const nextButton = createElement({
    tag: 'button',
    id: 'btnNext',
    text: 'Next',
  });

  const api = loadApi([emailInput, hiddenPasswordInput, nextButton]);

  assert.equal(api.findEmailInput(), emailInput);
  assert.equal(api.findPasswordInput(), null);
  assert.equal(api.findEmailNextButton(), nextButton);
  assert.equal(api.findPasswordLoginButton(), null);
  assert.equal(api.getPayPalLoginPhase(emailInput, api.findPasswordInput()), 'email');
});

test('PayPal combined login page still sees visible password input', () => {
  const emailInput = createElement({
    tag: 'input',
    type: 'text',
    id: 'login_email',
    name: 'login_email',
  });
  const passwordInput = createElement({
    tag: 'input',
    type: 'password',
    id: 'login_password',
    name: 'login_password',
  });
  const loginButton = createElement({
    tag: 'button',
    id: 'btnLogin',
    text: 'Log In',
  });

  const api = loadApi([emailInput, passwordInput, loginButton]);

  assert.equal(api.findEmailInput(), emailInput);
  assert.equal(api.findPasswordInput(), passwordInput);
  assert.equal(api.findPasswordLoginButton(), loginButton);
  assert.equal(api.getPayPalLoginPhase(emailInput, passwordInput), 'login_combined');
});

test('PayPal email submit refills a prefilled email before clicking next', async () => {
  const emailInput = createElement({
    tag: 'input',
    type: 'text',
    id: 'login_email',
    name: 'login_email',
    value: 'user@example.com',
    placeholder: 'Email',
  });
  const nextButton = createElement({
    tag: 'button',
    id: 'btnNext',
    text: 'Next',
  });
  const fillValues = [];
  const clicked = [];
  let focusCount = 0;
  let blurCount = 0;

  emailInput.focus = () => {
    focusCount += 1;
  };
  emailInput.blur = () => {
    blurCount += 1;
  };

  const api = createSubmitApi({
    findEmailInput: () => emailInput,
    findEmailNextButton: () => nextButton,
    fillInput: (element, value) => {
      fillValues.push(value);
      element.value = value;
    },
    simulateClick: (element) => {
      clicked.push(element);
    },
  });

  const result = await api.submitPayPalLogin({
    email: 'user@example.com',
    password: 'secret',
  });

  assert.deepEqual(fillValues, ['', 'user@example.com']);
  assert.equal(focusCount, 1);
  assert.equal(blurCount, 1);
  assert.deepEqual(clicked, [nextButton]);
  assert.deepEqual(result, {
    submitted: false,
    phase: 'email_submitted',
    awaiting: 'password_page',
  });
});

test('PayPal hosted checkout stage detection prioritizes verification popup over checkout path', () => {
  const verificationInputs = Array.from({ length: 6 }, (_, index) => createElement({
    tag: 'input',
    type: 'text',
    id: `ci-ciBasic-${index}`,
  }));
  const api = loadHostedStageApi({
    elements: verificationInputs,
    locationOverride: {
      pathname: '/checkoutweb/demo',
      href: 'https://www.paypal.com/checkoutweb/demo',
    },
  });

  assert.equal(api.detectPayPalHostedCheckoutStage(), 'verification');
});

test('PayPal checkoutweb signup stays in guest checkout stage even when consent text is visible', () => {
  const consentButton = createElement({
    tag: 'button',
    text: '同意并继续',
    attrs: { 'data-testid': 'consentButton' },
  });
  const cardNumberInput = createElement({
    tag: 'input',
    type: 'text',
    id: 'cardNumber',
  });
  const api = loadHostedStageApi({
    elements: [consentButton, cardNumberInput],
    locationOverride: {
      pathname: '/checkoutweb/signup',
      href: 'https://www.paypal.com/checkoutweb/signup?token=demo',
    },
  });

  assert.equal(api.detectPayPalHostedCheckoutStage(), 'guest_checkout');
});

test('PayPal hosted checkout verification filler writes six digits into split inputs', async () => {
  const inputs = Array.from({ length: 6 }, (_, index) => createElement({
    tag: 'input',
    type: 'text',
    id: `ci-ciBasic-${index}`,
    value: '',
  }));
  const writes = [];
  const api = createHostedVerificationApi({
    findHostedVerificationInputs: () => inputs,
    fillInput: (element, value) => {
      writes.push({ id: element.id, value });
      element.value = value;
    },
  });

  const result = await api.fillHostedVerificationCode({
    verificationCode: '123456',
  });

  assert.deepEqual(writes, [
    { id: 'ci-ciBasic-0', value: '1' },
    { id: 'ci-ciBasic-1', value: '2' },
    { id: 'ci-ciBasic-2', value: '3' },
    { id: 'ci-ciBasic-3', value: '4' },
    { id: 'ci-ciBasic-4', value: '5' },
    { id: 'ci-ciBasic-5', value: '6' },
  ]);
  assert.deepEqual(result, {
    stage: 'verification',
    codeSubmitted: true,
  });
});

test('PayPal hosted checkout verification failure detection matches target message block', () => {
  const errorBlock = createElement({
    attrs: {
      role: 'alert',
      class: 'css-ltr-fmonlv css-ltr-invj57-alert_base-text_body-error-no_close_btn',
    },
    textContent: 'Sorry, something went wrong. Get a new code.',
  });
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
    attrs: {
      'data-testid': 'resend-link',
    },
  });

  const api = loadHostedVerificationFailureApi({
    elements: [errorBlock, resendButton],
  });

  const result = api.detectHostedVerificationFailure();

  assert.equal(result.visible, true);
  assert.equal(result.messageMatched, true);
  assert.equal(result.verificationFailureDetected, true);
  assert.equal(result.resendAvailable, true);
});

test('PayPal hosted checkout verification failure detection prefers alert element even when text changes', () => {
  const errorBlock = createElement({
    attrs: {
      role: 'alert',
      class: 'css-ltr-fmonlv css-ltr-invj57-alert_base-text_body-error-no_close_btn',
    },
    textContent: 'Temporary verification issue.',
  });
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
    attrs: {
      'data-testid': 'resend-link',
    },
  });

  const api = loadHostedVerificationFailureApi({
    elements: [errorBlock, resendButton],
  });

  const result = api.detectHostedVerificationFailure();

  assert.equal(result.visible, true);
  assert.equal(result.messageMatched, false);
  assert.equal(result.verificationFailureDetected, true);
  assert.equal(result.resendAvailable, true);
});

test('PayPal hosted checkout resend clicks target button', async () => {
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
    attrs: {
      'data-testid': 'resend-link',
    },
  });
  let clicked = 0;
  resendButton.dispatchEvent = (event) => {
    if (event?.type === 'click') {
      clicked += 1;
    }
    return true;
  };

  const api = loadHostedVerificationFailureApi({
    elements: [resendButton],
  });

  const result = await api.clickHostedVerificationResend();

  assert.equal(result.clicked, true);
  assert.equal(clicked, 1);
});

test('PayPal hosted checkout resend rejects disabled button', async () => {
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
    disabled: true,
    attrs: {
      'data-testid': 'resend-link',
    },
  });
  let clicked = 0;
  resendButton.dispatchEvent = () => {
    clicked += 1;
    return true;
  };

  const api = loadHostedVerificationFailureApi({
    elements: [resendButton],
  });

  await assert.rejects(
    api.clickHostedVerificationResend(),
    /Resend 按钮不可用或已禁用/,
  );
  assert.equal(clicked, 0);
});

test('PayPal hosted checkout runHostedCheckoutStep can return verification failure state without submitting code', async () => {
  const errorBlock = createElement({
    attrs: {
      role: 'alert',
      class: 'css-ltr-fmonlv css-ltr-invj57-alert_base-text_body-error-no_close_btn',
    },
    textContent: 'Sorry, something went wrong. Get a new code.',
  });
  const resendButton = createElement({
    tagName: 'button',
    textContent: 'Resend',
    attrs: {
      'data-testid': 'resend-link',
    },
  });
  const verificationInputs = Array.from({ length: 6 }, () => createElement({
    tagName: 'input',
    value: '',
  }));

  const api = createHostedVerificationFailureActionApi({
    detectPayPalHostedCheckoutStage: () => 'verification',
    detectHostedVerificationFailure: () => ({
      visible: true,
      messageMatched: true,
      verificationFailureDetected: true,
      resendAvailable: true,
      messageText: errorBlock.textContent,
    }),
    clickHostedVerificationResend: async () => {
      resendButton.click?.();
      return { clicked: true, text: 'Resend' };
    },
    fillHostedVerificationCode: async () => {
      throw new Error('should not fill verification code');
    },
  });

  const result = await api.runHostedCheckoutStep({
    action: 'check-verification-failure',
  });

  assert.equal(result.stage, 'verification');
  assert.equal(result.verificationFailed, true);
  assert.equal(result.resendAvailable, true);
});

test('PayPal hosted review path bypasses generic stage detection and directly runs review handler', async () => {
  const calls = [];
  const api = createHostedReviewApi({
    isPayPalHostedReviewPage: () => true,
    detectPayPalHostedCheckoutStage: () => {
      calls.push('detect');
      return 'guest_checkout';
    },
    clickHostedReviewConsent: async () => {
      calls.push('review');
      return { stage: 'review_consent', submitted: true };
    },
  });

  const result = await api.runHostedCheckoutStep({});

  assert.deepEqual(calls, ['review']);
  assert.deepEqual(result, { stage: 'review_consent', submitted: true });
});
