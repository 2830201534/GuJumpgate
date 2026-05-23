const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background auto-run restart logic treats paypal-checkout-flow as checkout restart node', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /'paypal-checkout-flow'/);
  assert.match(source, /\|\| normalizedKey === 'paypal-checkout-flow'/);
  assert.match(source, /'paypal-checkout-flow': 2000/);
});
