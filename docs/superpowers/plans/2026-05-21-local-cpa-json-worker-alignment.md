# Local CPA JSON Worker Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `local-cpa-json` 与 `local-cpa-json-no-rt` 两种模式导出的 `CPA JSON` 全部严格对齐 `/Users/yzpd/Desktop/auto_tools/worker.js` 的 `cpa` 结构，并统一输出为“本次注册邮箱 + .json”。

**Architecture:** 新增一个统一的 `CPA JSON` 构建模块，吸收 `worker.js` 的 `cpa` 生成规则，负责字段提取、synthetic `id_token` 构建、warning 生成和文件命名。有 RT 的 `platform-verify` 导出与无 RT 的 `wait-registration-success` 导出都改为调用这一个构建器，再继续使用现有 `/save-auth-json` helper 落盘。

**Tech Stack:** Chrome MV3 extension、plain JavaScript、Node built-in test runner (`node --test`)

---

## File Structure

- Create: `shared/cpa-json-builder.js`
  - 统一 `CPA JSON` 构建器
  - 吸收 `worker.js` 的 `cpa` 字段提取、synthetic `id_token`、warning、文件名规则
- Modify: `background/local-cli-proxy-api.js`
  - 保留 OAuth / PKCE / token exchange
  - `buildAuthJsonArtifact()` 改为走新构建器
- Modify: `background/steps/wait-registration-success.js`
  - 无 RT 导出继续读 session，但最终 JSON 必须由新构建器产出
- Modify: `background/steps/platform-verify.js`
  - 有 RT 导出改为使用新构建器产出最终 `CPA JSON`
- Modify: `background.js`
  - 如有需要，补挂载新模块依赖
- Test: `tests/background-local-cli-proxy-api.test.js`
  - 断言最终 artifact 对齐 `worker.js`
- Test: `tests/background-step6-retry-limit.test.js`
  - 断言无 RT step 7 导出写入内容和文件名
- Test: `tests/background-platform-verify-cpa-api.test.js`
  - 断言有 RT 导出写入内容和文件名
- Create: `tests/cpa-json-builder.test.js`
  - 直接覆盖统一构建器规则

### Task 1: 建立统一的 CPA JSON 构建器

**Files:**
- Create: `shared/cpa-json-builder.js`
- Test: `tests/cpa-json-builder.test.js`

- [ ] **Step 1: 写统一构建器的失败用例，直接对齐 worker.js 规则**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('shared/cpa-json-builder.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageCpaJsonBuilder;`)(globalScope);

test('cpa json builder creates worker-compatible CPA payload with synthetic id token', () => {
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
```

- [ ] **Step 2: 运行测试，确认先失败**

Run:

```bash
node --test tests/cpa-json-builder.test.js
```

Expected:

```text
not ok ... ENOENT: no such file or directory, open 'shared/cpa-json-builder.js'
```

- [ ] **Step 3: 新建统一构建器，实现 worker.js 兼容规则**

```js
(function attachCpaJsonBuilder(root, factory) {
  root.MultiPageCpaJsonBuilder = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createCpaJsonBuilderModule() {
  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const normalized = normalizeString(value);
      if (normalized) return normalized;
    }
    return '';
  }

  function decodeBase64Url(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function encodeBase64UrlJson(value) {
    const json = JSON.stringify(value);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function parseJwtPayload(token) {
    const normalized = normalizeString(token);
    if (!normalized) return {};
    const parts = normalized.split('.');
    if (parts.length < 2 || !parts[1]) return {};
    try {
      return JSON.parse(decodeBase64Url(parts[1]));
    } catch {
      return {};
    }
  }

  function createUnsignedJwt(payload) {
    return `${encodeBase64UrlJson({ alg: 'none', typ: 'JWT', cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.`;
  }

  function toIso(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    const normalized = normalizeString(value);
    if (!normalized) return '';
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }

  function unixSecondsToIso(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return new Date(numeric * 1000).toISOString();
  }

  function buildSyntheticIdToken({ email, accountId, planType, userId, expiresAt }) {
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.floor((Date.parse(expiresAt || '') || (Date.now() + 90 * 24 * 60 * 60 * 1000)) / 1000);
    return createUnsignedJwt({
      iat: now,
      exp,
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: planType,
        chatgpt_user_id: userId,
        user_id: userId,
      },
      email,
    });
  }

  function buildCpaJson(input = {}) {
    const session = input.session && typeof input.session === 'object' && !Array.isArray(input.session) ? input.session : {};
    const accessToken = firstNonEmpty(input.accessToken, input.access_token, session.accessToken, session.access_token);
    if (!accessToken) {
      throw new Error('缺少 accessToken / access_token。');
    }

    const accessPayload = parseJwtPayload(accessToken);
    const authClaims = accessPayload['https://api.openai.com/auth'] || {};
    const profile = accessPayload['https://api.openai.com/profile'] || {};
    const email = firstNonEmpty(session.user?.email, session.email, input.email, profile.email);
    const accountId = firstNonEmpty(session.account?.id, input.accountId, input.account_id, session.account_id, authClaims.chatgpt_account_id);
    const planType = firstNonEmpty(session.account?.planType, session.account?.plan_type, input.planType, input.plan_type, authClaims.chatgpt_plan_type) || 'unknown';
    const userId = firstNonEmpty(session.user?.id, input.userId, input.user_id, authClaims.chatgpt_user_id, authClaims.user_id);
    const refreshToken = firstNonEmpty(input.refreshToken, input.refresh_token, session.refreshToken, session.refresh_token);
    const sessionToken = firstNonEmpty(input.sessionToken, input.session_token, session.sessionToken, session.session_token);
    const realIdToken = firstNonEmpty(input.idToken, input.id_token, session.idToken, session.id_token);
    const expired = firstNonEmpty(toIso(session.expires), toIso(session.expired), toIso(input.expiresAt), toIso(input.expires_at), unixSecondsToIso(accessPayload.exp));

    if (!email) {
      throw new Error('无法识别邮箱字段：需要 user.email 或 access_token profile.email。');
    }
    if (!accountId) {
      throw new Error('无法识别账号 ID：需要 account.id 或 access_token claims。');
    }

    const idToken = realIdToken || buildSyntheticIdToken({
      email,
      accountId,
      planType,
      userId,
      expiresAt: expired,
    });
    const lastRefresh = toIso(input.now || new Date());
    const output = {
      type: 'codex',
      email,
      account_id: accountId,
      chatgpt_account_id: accountId,
      plan_type: planType,
      chatgpt_plan_type: planType,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      session_token: sessionToken,
      last_refresh: lastRefresh,
      expired,
      disabled: false,
      id_token_synthetic: !realIdToken,
    };
    const warnings = [
      !refreshToken ? '缺少 refresh_token，access_token 过期后 CPA 不能自动刷新。' : '',
      !realIdToken ? '缺少真实 id_token，已根据 account_id / plan_type 写入 CPA 额度面板可解析的占位 claims；上游认证仍使用 access_token。' : '',
      !sessionToken ? '缺少 session_token，部分依赖网页会话的工具可能不可用。' : '',
    ].filter(Boolean);

    return {
      output,
      fileName: `${email}.json`,
      warnings,
    };
  }

  return {
    buildCpaJson,
  };
});
```

- [ ] **Step 4: 运行新测试，确认通过**

Run:

```bash
node --test tests/cpa-json-builder.test.js
```

Expected:

```text
# tests 2
# fail 0
```

- [ ] **Step 5: 提交统一构建器**

```bash
git add shared/cpa-json-builder.js tests/cpa-json-builder.test.js
git commit -m "feat: add worker-compatible cpa json builder"
```

### Task 2: 让本地 CLI Proxy API 改为输出 worker 风格 CPA JSON

**Files:**
- Modify: `background/local-cli-proxy-api.js`
- Test: `tests/background-local-cli-proxy-api.test.js`

- [ ] **Step 1: 增加失败用例，验证 artifact 结构和文件名不再使用 codex-* 规则**

```js
test('local cli proxy api builds worker-compatible CPA artifact and email-based filename', async () => {
  const source = fs.readFileSync('background/local-cli-proxy-api.js', 'utf8');
  const builderSource = fs.readFileSync('shared/cpa-json-builder.js', 'utf8');
  const globalScope = {};
  new Function('self', `${builderSource}; return self.MultiPageCpaJsonBuilder;`)(globalScope);
  const api = new Function('self', `${source}; return self.MultiPageBackgroundLocalCliProxyApi;`)(globalScope);

  const client = api.createLocalCliProxyApi({
    crypto: webcrypto,
    fetch: async () => {
      throw new Error('fetch should not be used in this test');
    },
    sessionToJsonConverter: { convertSessionJson() { throw new Error('old converter should not be used'); } },
    cpaJsonBuilder: globalScope.MultiPageCpaJsonBuilder,
  });

  const artifact = await client.buildAuthJsonArtifact({
    pluginDir: 'C:/plugin',
    relativeAuthDir: '.cli-proxy-api',
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

  assert.equal(artifact.fileName, 'user@example.com.json');
  assert.equal(artifact.filePath, 'C:/plugin/.cli-proxy-api/user@example.com.json');
  assert.equal(artifact.authJson.email, 'user@example.com');
  assert.equal(artifact.authJson.last_refresh, '2026-05-21T12:34:56.000Z');
  assert.equal(artifact.authJson.disabled, false);
});
```

- [ ] **Step 2: 跑本模块测试，确认先失败**

Run:

```bash
node --test tests/background-local-cli-proxy-api.test.js
```

Expected:

```text
not ok ... old converter should not be used
```

- [ ] **Step 3: 改 `background/local-cli-proxy-api.js`，接入统一构建器**

```js
function getCpaJsonBuilder(explicitBuilder = null) {
  const candidate = explicitBuilder
    || globalThis.MultiPageCpaJsonBuilder
    || (typeof self !== 'undefined' ? self.MultiPageCpaJsonBuilder : null)
    || null;
  if (candidate && typeof candidate.buildCpaJson === 'function') {
    return candidate;
  }
  throw new Error('cpa-json-builder 模块未加载，无法生成本地 CPA JSON。');
}

function createLocalCliProxyApi(deps = {}) {
  const fetchLike = getFetchLike(deps.fetch);
  const cryptoLike = getCryptoLike(deps.crypto);
  const cpaJsonBuilder = getCpaJsonBuilder(deps.cpaJsonBuilder);
  const ensureDirectory = typeof deps.ensureDirectory === 'function' ? deps.ensureDirectory : null;
  const writeTextFile = typeof deps.writeTextFile === 'function' ? deps.writeTextFile : null;

  async function buildAuthJsonArtifact(options = {}) {
    const pluginDir = normalizeString(options.pluginDir);
    if (!pluginDir) {
      throw new Error('生成本地 auth json 失败：缺少 pluginDir。');
    }

    const built = cpaJsonBuilder.buildCpaJson({
      session: options.session,
      accessToken: options.accessToken || options.access_token,
      refreshToken: options.refreshToken || options.refresh_token,
      sessionToken: options.sessionToken || options.session_token,
      idToken: options.idToken || options.id_token,
      email: options.email,
      accountId: options.accountId || options.account_id,
      userId: options.userId || options.user_id,
      planType: options.planType || options.plan_type,
      expiresAt: options.expiresAt || options.expires_at,
      now: options.now || new Date(),
    });

    const relativeAuthDir = sanitizeRelativeDir(options.relativeAuthDir || DEFAULT_RELATIVE_AUTH_DIR);
    const directoryPath = joinPath(pluginDir, relativeAuthDir);
    const filePath = joinPath(directoryPath, built.fileName);
    const jsonText = `${JSON.stringify(built.output, null, 2)}\n`;

    return {
      provider: 'codex',
      fileName: built.fileName,
      directoryPath,
      filePath,
      relativeAuthDir,
      authJson: built.output,
      jsonText,
      warnings: built.warnings.slice(),
    };
  }
}
```

- [ ] **Step 4: 跑本模块测试，确认通过**

Run:

```bash
node --test tests/background-local-cli-proxy-api.test.js
```

Expected:

```text
# tests ... passed
# fail 0
```

- [ ] **Step 5: 提交本模块改动**

```bash
git add background/local-cli-proxy-api.js tests/background-local-cli-proxy-api.test.js
git commit -m "refactor: align local cli proxy api cpa export"
```

### Task 3: 整改无 RT 的 Step 7 导出并补强验收

**Files:**
- Modify: `background/steps/wait-registration-success.js`
- Test: `tests/background-step6-retry-limit.test.js`

- [ ] **Step 1: 写失败用例，直接断言 helper 收到的 JSON 内容和邮箱文件名**

```js
assert.equal(JSON.parse(events.fetchCalls[0].options.body).filePath, 'C:/plugin/.cli-proxy-api/user@example.com.json');
const savedJson = JSON.parse(JSON.parse(events.fetchCalls[0].options.body).content);
assert.equal(savedJson.email, 'user@example.com');
assert.equal(savedJson.account_id, 'acct-1');
assert.equal(savedJson.chatgpt_account_id, 'acct-1');
assert.equal(savedJson.plan_type, 'plus');
assert.equal(savedJson.chatgpt_plan_type, 'plus');
assert.equal(savedJson.refresh_token, '');
assert.equal(savedJson.session_token, 'session-cookie-token');
assert.equal(savedJson.disabled, false);
assert.equal(savedJson.id_token_synthetic, true);
assert.match(savedJson.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
```

- [ ] **Step 2: 跑 step 7 测试，确认先失败**

Run:

```bash
node --test tests/background-step6-retry-limit.test.js
```

Expected:

```text
not ok ... Expected values to be strictly equal:
+ actual - expected
+ 'C:/plugin/.cli-proxy-api/codex-user@example.com-plus.json'
```

- [ ] **Step 3: 让无 RT 导出显式传递 worker 对齐所需上下文**

```js
const artifact = await api.buildAuthJsonArtifact({
  pluginDir,
  relativeAuthDir: state.localCpaJsonRelativeAuthDir,
  session: sessionResult?.session,
  accessToken: sessionResult?.accessToken,
  refreshToken: sessionResult?.session?.refreshToken || sessionResult?.session?.refresh_token || '',
  sessionToken: sessionResult?.session?.sessionToken,
  email: sessionResult?.email || sessionResult?.session?.user?.email || state?.email,
  expiresAt: sessionResult?.expiresAt || sessionResult?.session?.expires,
  accountId: sessionResult?.session?.account?.id,
  userId: sessionResult?.session?.user?.id,
  planType: sessionResult?.session?.account?.planType,
  now: new Date(),
});
```

- [ ] **Step 4: 重新运行 step 7 测试，确认通过**

Run:

```bash
node --test tests/background-step6-retry-limit.test.js
```

Expected:

```text
# tests ... passed
# fail 0
```

- [ ] **Step 5: 提交无 RT 整改**

```bash
git add background/steps/wait-registration-success.js tests/background-step6-retry-limit.test.js
git commit -m "fix: align no-rt cpa export with worker output"
```

### Task 4: 整改有 RT 的 CPA JSON 导出并补强验收

**Files:**
- Modify: `background/steps/platform-verify.js`
- Test: `tests/background-platform-verify-cpa-api.test.js`

- [ ] **Step 1: 写失败用例，断言有 RT 导出使用邮箱文件名和 worker 风格字段**

```js
assert.equal(fetchCalls[0].url, 'http://127.0.0.1:17373/save-auth-json');
const payload = JSON.parse(fetchCalls[0].options.body);
assert.equal(payload.filePath, 'C:/plugin/.cli-proxy-api/user@example.com.json');
const savedJson = JSON.parse(payload.content);
assert.equal(savedJson.email, 'user@example.com');
assert.equal(savedJson.account_id, 'acct-1');
assert.equal(savedJson.chatgpt_account_id, 'acct-1');
assert.equal(savedJson.plan_type, 'plus');
assert.equal(savedJson.chatgpt_plan_type, 'plus');
assert.equal(savedJson.refresh_token, 'refresh-123');
assert.equal(savedJson.session_token, '');
assert.equal(savedJson.disabled, false);
assert.equal(savedJson.id_token_synthetic, false);
assert.equal(savedJson.id_token, 'real.id.token');
assert.match(savedJson.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
```

- [ ] **Step 2: 跑有 RT 导出测试，确认先失败**

Run:

```bash
node --test tests/background-platform-verify-cpa-api.test.js
```

Expected:

```text
not ok ... Expected values to be strictly equal:
+ actual - expected
+ 'C:/plugin/.cli-proxy-api/codex-user@example.com-plus.json'
```

- [ ] **Step 3: 改 `background/steps/platform-verify.js`，确保有 RT 走统一构建器**

```js
const artifact = await api.buildAuthJsonArtifact({
  pluginDir,
  relativeAuthDir: state.localCpaJsonRelativeAuthDir,
  accessToken: tokenBundle.accessToken,
  refreshToken: tokenBundle.refreshToken,
  idToken: tokenBundle.idToken,
  sessionToken: '',
  email: state.email,
  accountId: state.accountId || exchangedSession?.account?.id,
  userId: exchangedSession?.user?.id,
  planType: exchangedSession?.account?.planType,
  expiresAt: tokenBundle.expiresAt,
  session: exchangedSession,
  now: new Date(),
});
```

- [ ] **Step 4: 重新运行有 RT 导出测试，确认通过**

Run:

```bash
node --test tests/background-platform-verify-cpa-api.test.js
```

Expected:

```text
# tests ... passed
# fail 0
```

- [ ] **Step 5: 提交有 RT 整改**

```bash
git add background/steps/platform-verify.js tests/background-platform-verify-cpa-api.test.js
git commit -m "fix: align oauth cpa export with worker output"
```

### Task 5: 跑回归并核对无关链路未受影响

**Files:**
- Verify: `shared/cpa-json-builder.js`
- Verify: `background/local-cli-proxy-api.js`
- Verify: `background/steps/wait-registration-success.js`
- Verify: `background/steps/platform-verify.js`
- Verify: `tests/cpa-json-builder.test.js`
- Verify: `tests/background-local-cli-proxy-api.test.js`
- Verify: `tests/background-step6-retry-limit.test.js`
- Verify: `tests/background-platform-verify-cpa-api.test.js`

- [ ] **Step 1: 跑本次新增与直接受影响的测试集合**

Run:

```bash
node --test \
  tests/cpa-json-builder.test.js \
  tests/background-local-cli-proxy-api.test.js \
  tests/background-step6-retry-limit.test.js \
  tests/background-platform-verify-cpa-api.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 2: 跑与本地 CPA JSON 模式相关的回归测试**

Run:

```bash
node --test \
  tests/background-panel-bridge-module.test.js \
  tests/background-step-registry.test.js \
  tests/step-definitions-module.test.js \
  tests/flow-capabilities-module.test.js \
  tests/background-navigation-utils-module.test.js
```

Expected:

```text
# fail 0
```

- [ ] **Step 3: 检查最终 diff，只包含本次设计范围**

Run:

```bash
git diff --stat HEAD~4..HEAD
git status --short
```

Expected:

```text
仅包含 cpa json builder、local cli proxy api、wait-registration-success、platform-verify、对应测试文件
工作区无意外未跟踪文件
```

- [ ] **Step 4: 提交最终收尾**

```bash
git add shared/cpa-json-builder.js background/local-cli-proxy-api.js background/steps/wait-registration-success.js background/steps/platform-verify.js tests/cpa-json-builder.test.js tests/background-local-cli-proxy-api.test.js tests/background-step6-retry-limit.test.js tests/background-platform-verify-cpa-api.test.js
git commit -m "feat: align local cpa json exports with worker format"
```

- [ ] **Step 5: 记录验证结论并准备进入收尾流程**

```text
- 本次只整改 CPA JSON 的有 RT / 无 RT 导出
- sub2api 未改动
- 导出文件名统一为 注册邮箱.json
- worker.js 结构已作为最终验收标准
```
