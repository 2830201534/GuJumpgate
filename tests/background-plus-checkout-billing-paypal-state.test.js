const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('plus checkout billing persists paypal stage after redirect for non-hosted paypal flow', () => {
  const source = fs.readFileSync('background/steps/fill-plus-checkout.js', 'utf8');
  assert.match(source, /const PAYPAL_SOURCE = 'paypal-flow'/);
  assert.match(source, /async function detectPayPalStageAfterRedirect\(tabId\)/);
  assert.match(source, /paypalCheckoutStage: paypalStage\.stage/);
  assert.match(source, /paypalCheckoutEntrySource: 'plus-checkout-billing'/);
});
