const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadModule() {
  const builderSource = fs.readFileSync('shared/cpa-json-builder.js', 'utf8');
  const localModuleSource = fs.readFileSync('background/local-cli-proxy-api.js', 'utf8');
  return new Function(
    'self',
    `${builderSource}\n${localModuleSource}; return self.MultiPageBackgroundLocalCliProxyApi;`
  )({});
}

function encodeBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createJwt(payload) {
  return `${encodeBase64UrlJson({ alg: 'none', typ: 'JWT' })}.${encodeBase64UrlJson(payload)}.signature`;
}

test('local cli proxy api module exposes factory', () => {
  const backgroundSource = fs.readFileSync('background.js', 'utf8');
  assert.match(backgroundSource, /background\/local-cli-proxy-api\.js/);
  const source = fs.readFileSync('background/local-cli-proxy-api.js', 'utf8');
  const api = new Function('self', `${source}; return self.MultiPageBackgroundLocalCliProxyApi;`)({});
  assert.equal(typeof api?.createLocalCliProxyApi, 'function');
});

test('local cli proxy api generates codex OAuth URL with CLIProxyAPI-compatible params', async () => {
  const api = loadModule();
  const client = api.createLocalCliProxyApi({
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
  });

  const result = await client.createAuthorizationRequest({
    state: 'abc123state',
  });

  const parsed = new URL(result.oauthUrl);
  assert.equal(parsed.origin + parsed.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(parsed.searchParams.get('scope'), 'openid email profile offline_access');
  assert.equal(parsed.searchParams.get('state'), 'abc123state');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('prompt'), 'login');
  assert.equal(parsed.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(parsed.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.ok(result.pkceCodes.codeVerifier.length >= 43);
  assert.ok(result.pkceCodes.codeChallenge.length >= 43);
});

test('local cli proxy api exchanges code for tokens using OpenAI OAuth token endpoint', async () => {
  const api = loadModule();
  const calls = [];
  const client = api.createLocalCliProxyApi({
    crypto: globalThis.crypto,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'access-token-value',
          refresh_token: 'refresh-token-value',
          id_token: 'id-token-value',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };
    },
  });

  const result = await client.exchangeCodeForTokens({
    code: 'oauth-code',
    pkceCodes: {
      codeVerifier: 'verifier-123',
    },
  });

  assert.equal(calls.length, 1);
  const [{ url, options }] = calls;
  assert.equal(url, 'https://auth.openai.com/oauth/token');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(options.headers.Accept, 'application/json');
  const body = new URLSearchParams(options.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(body.get('code'), 'oauth-code');
  assert.equal(body.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(body.get('code_verifier'), 'verifier-123');
  assert.equal(result.accessToken, 'access-token-value');
  assert.equal(result.refreshToken, 'refresh-token-value');
  assert.equal(result.idToken, 'id-token-value');
  assert.equal(result.tokenType, 'Bearer');
  assert.equal(result.expiresIn, 3600);
});

test('local cli proxy api turns exchanged tokens into worker-style CPA json and writes into plugin directory', async () => {
  const api = loadModule();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowpilot-local-cpa-'));
  const pluginDir = path.join(tmpRoot, 'plugin');
  const accessToken = createJwt({
    exp: Math.trunc(Date.parse('2026-06-01T00:00:00.000Z') / 1000),
    email: 'local@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-local-123',
      chatgpt_plan_type: 'plus',
      chatgpt_user_id: 'user-local-1',
    },
    'https://api.openai.com/profile': {
      email: 'local@example.com',
    },
  });
  const idToken = createJwt({
    email: 'local@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-local-123',
      chatgpt_plan_type: 'plus',
      chatgpt_user_id: 'user-local-1',
    },
  });

  const client = api.createLocalCliProxyApi({
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
    sessionToJsonConverter: {
      convertSessionJson() {
        throw new Error('old converter should not be used');
      },
    },
    ensureDirectory: async (dirPath) => {
      await fs.promises.mkdir(dirPath, { recursive: true });
    },
    writeTextFile: async (filePath, text) => {
      await fs.promises.writeFile(filePath, text, 'utf8');
    },
  });

  const artifact = await client.buildAuthJsonArtifact({
    pluginDir,
    relativeAuthDir: '.cli-proxy-api',
    accessToken,
    refreshToken: 'refresh-local-123',
    idToken,
    sourceName: 'CLIProxyAPI Local OAuth',
    now: new Date('2026-05-20T00:00:00.000Z'),
  });

  assert.equal(artifact.fileName, 'local@example.com.json');
  assert.equal(artifact.authJson.type, 'codex');
  assert.equal(artifact.authJson.email, 'local@example.com');
  assert.equal(artifact.authJson.account_id, 'acct-local-123');
  assert.equal(artifact.authJson.chatgpt_account_id, 'acct-local-123');
  assert.equal(artifact.authJson.plan_type, 'plus');
  assert.equal(artifact.authJson.chatgpt_plan_type, 'plus');
  assert.equal(artifact.authJson.refresh_token, 'refresh-local-123');
  assert.equal(artifact.authJson.disabled, false);
  assert.equal(artifact.authJson.last_refresh, '2026-05-20T00:00:00.000Z');
  assert.equal(artifact.authJson.expired, '2026-06-01T00:00:00.000Z');
  assert.deepEqual(artifact.warnings, [
    '缺少 session_token，部分依赖网页会话的工具可能不可用。',
  ]);

  const saved = await client.saveAuthJsonArtifact(artifact);
  assert.equal(saved.saved, true);
  assert.equal(fs.existsSync(saved.filePath), true);

  const savedJson = JSON.parse(fs.readFileSync(saved.filePath, 'utf8'));
  assert.equal(savedJson.email, 'local@example.com');
  assert.equal(savedJson.plan_type, 'plus');
  assert.equal(savedJson.type, 'codex');
  assert.equal(savedJson.disabled, false);
});

test('local cli proxy api uses registration email as artifact file name', async () => {
  const api = loadModule();
  const accessToken = createJwt({
    exp: Math.trunc(Date.now() / 1000) + 3600,
    email: 'team@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-team-xyz',
      chatgpt_plan_type: 'team',
    },
  });
  const idToken = createJwt({
    email: 'team@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-team-xyz',
      chatgpt_plan_type: 'team',
    },
  });

  const client = api.createLocalCliProxyApi({
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
  });

  const artifact = await client.buildAuthJsonArtifact({
    pluginDir: 'C:\\plugin',
    accessToken,
    refreshToken: 'refresh-team',
    idToken,
  });

  assert.equal(artifact.fileName, 'team@example.com.json');
  assert.equal(artifact.filePath, 'C:\\plugin\\.cli-proxy-api\\team@example.com.json');
});

test('local cli proxy api converts ChatGPT session directly without refresh token', async () => {
  const api = loadModule();
  const client = api.createLocalCliProxyApi({
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
  });

  const artifact = await client.buildAuthJsonArtifact({
    pluginDir: 'C:\\plugin',
    relativeAuthDir: '.cli-proxy-api',
    session: {
      accessToken: 'session-access-token',
      sessionToken: 'session-cookie-token',
      expires: '2026-05-20T12:00:00.000Z',
      user: {
        id: 'user-session-1',
        email: 'session@example.com',
      },
      account: {
        id: 'acct-session-1',
        planType: 'free',
      },
    },
    accessToken: 'session-access-token',
    now: new Date('2026-05-21T00:00:00.000Z'),
    sourceName: 'SessionToJson Local No RT',
  });

  assert.equal(artifact.fileName, 'session@example.com.json');
  assert.equal(artifact.authJson.email, 'session@example.com');
  assert.equal(artifact.authJson.account_id, 'acct-session-1');
  assert.equal(artifact.authJson.chatgpt_account_id, 'acct-session-1');
  assert.equal(artifact.authJson.plan_type, 'free');
  assert.equal(artifact.authJson.chatgpt_plan_type, 'free');
  assert.equal(artifact.authJson.session_token, 'session-cookie-token');
  assert.equal(artifact.authJson.refresh_token, '');
  assert.equal(artifact.authJson.last_refresh, '2026-05-21T00:00:00.000Z');
  assert.equal(artifact.authJson.expired, '2026-05-20T12:00:00.000Z');
  assert.equal(artifact.authJson.id_token_synthetic, true);
  assert.match(artifact.authJson.id_token, /^[^.]+\.[^.]+\.$/);
  assert.ok(artifact.warnings.some((warning) => /缺少 refresh_token/.test(warning)));
  assert.ok(artifact.warnings.some((warning) => /缺少真实 id_token/.test(warning)));
});

test('local cli proxy api rejects mismatched OAuth callback state', () => {
  const api = loadModule();
  assert.throws(
    () => api.parseOAuthCallback('http://localhost:1455/auth/callback?code=ok&state=wrong-state', 'expected-state'),
    /OAuth state 不匹配/
  );
});

test('local cli proxy api blocks relative auth dir traversal', async () => {
  const api = loadModule();
  const client = api.createLocalCliProxyApi({
    crypto: globalThis.crypto,
    fetch: async () => {
      throw new Error('fetch should not be called');
    },
  });
  const accessToken = createJwt({
    exp: Math.trunc(Date.now() / 1000) + 3600,
    email: 'safe@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-safe',
      chatgpt_plan_type: 'plus',
    },
  });

  await assert.rejects(
    () => client.buildAuthJsonArtifact({
      pluginDir: 'C:\\plugin',
      relativeAuthDir: '../escape',
      accessToken,
      refreshToken: 'refresh-safe',
      idToken: accessToken,
    }),
    /relativeAuthDir 不能包含/
  );
});
