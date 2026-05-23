const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background step registry includes paypal-checkout-flow executor', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /createPayPalCheckoutFlowExecutor/);
  assert.match(source, /'paypal-checkout-flow': \(state\) => payPalCheckoutFlowExecutor\.executePayPalCheckoutFlow\(state\)/);
});
