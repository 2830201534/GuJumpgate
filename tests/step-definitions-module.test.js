const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadStepDefinitions() {
  const source = fs.readFileSync('data/step-definitions.js', 'utf8');
  return new Function('self', `${source}; return self.MultiPageStepDefinitions;`)({});
}

test('step definitions expose paypal checkout flow in plus paypal sequence', () => {
  const api = loadStepDefinitions();
  const steps = api.getSteps({
    activeFlowId: 'openai',
    plusModeEnabled: true,
    plusPaymentMethod: 'paypal',
  });
  const keys = steps.map((step) => step.key);
  assert.equal(keys.includes('paypal-checkout-flow'), true);
  assert.equal(keys.includes('paypal-approve'), false);
});

test('local cpa json no rt inserts paypal checkout flow before local export', () => {
  const api = loadStepDefinitions();
  const steps = api.getSteps({
    activeFlowId: 'openai',
    panelMode: 'local-cpa-json-no-rt',
    plusModeEnabled: true,
    plusPaymentMethod: 'paypal',
  });
  const flowIndex = steps.findIndex((step) => step.key === 'paypal-checkout-flow');
  const exportIndex = steps.findIndex((step) => step.key === 'local-cpa-json-export');
  assert.ok(flowIndex >= 0);
  assert.ok(exportIndex > flowIndex);
});
