const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadModule() {
  const source = fs.readFileSync('shared/cpa-json-builder.js', 'utf8');
  return new Function('self', `${source}; return self.MultiPageCpaJsonBuilder;`)({});
}

test('cpa json builder creates worker-compatible json with synthetic id token when source session has no id_token', () => {
  const api = loadModule();
  const result = api.buildCpaJson({
    session: {
      user: { id: 'user-1', email: 'user@example.com' },
      account: { id: 'acct-1', planType: 'plus' },
      expires: '2026-06-01T00:00:00.000Z',
    },
    accessToken: 'header.eyJleHAiOjE3ODAzNjgwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTEiLCJjaGF0Z3B0X3BsYW5fdHlwZSI6InBsdXMiLCJjaGF0Z3B0X3VzZXJfaWQiOiJ1c2VyLTEiLCJ1c2VyX2lkIjoidXNlci0xIn0sImh0dHBzOi8vYXBpLm9wZW5haS5jb20vcHJvZmlsZSI6eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifX0.sig',
    refreshToken: '',
    sessionToken: 'session-cookie',
    now: new Date('2026-05-21T12:34:56.000Z'),
  });

  assert.equal(result.fileName, 'user@example.com.json');
  assert.equal(result.output.email, 'user@example.com');
  assert.equal(result.output.account_id, 'acct-1');
  assert.equal(result.output.chatgpt_account_id, 'acct-1');
  assert.equal(result.output.plan_type, 'plus');
  assert.equal(result.output.chatgpt_plan_type, 'plus');
  assert.equal(result.output.access_token.includes('.'), true);
  assert.equal(result.output.refresh_token, '');
  assert.equal(result.output.session_token, 'session-cookie');
  assert.equal(result.output.last_refresh, '2026-05-21T12:34:56.000Z');
  assert.equal(result.output.expired, '2026-06-01T00:00:00.000Z');
  assert.equal(result.output.disabled, false);
  assert.equal(result.output.id_token_synthetic, true);
  assert.match(result.output.id_token, /\./);
  assert.ok(result.warnings.some((item) => /缺少 refresh_token/.test(item)));
  assert.ok(result.warnings.some((item) => /缺少真实 id_token/.test(item)));
});

test('cpa json builder keeps real id token and refresh token when provided', () => {
  const api = loadModule();
  const result = api.buildCpaJson({
    session: {
      user: { id: 'user-2', email: 'paid@example.com' },
      account: { id: 'acct-2', planType: 'pro' },
      expires: '2026-07-01T00:00:00.000Z',
      id_token: 'real.id.token',
    },
    accessToken: 'header.eyJleHAiOjE3ODI5NjAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vcHJvZmlsZSI6eyJlbWFpbCI6InBhaWRAZXhhbXBsZS5jb20ifX0.sig',
    refreshToken: 'refresh-123',
    sessionToken: '',
    idToken: 'real.id.token',
    now: new Date('2026-05-21T10:00:00.000Z'),
  });

  assert.equal(result.fileName, 'paid@example.com.json');
  assert.equal(result.output.id_token, 'real.id.token');
  assert.equal(result.output.id_token_synthetic, false);
  assert.equal(result.output.refresh_token, 'refresh-123');
  assert.ok(!result.warnings.some((item) => /缺少 refresh_token/.test(item)));
});
