# Local CPA JSON Browser Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `local-cpa-json` 与 `local-cpa-json-no-rt` 的本地落盘从 `hotmail_helper.py` 主路径切换为 sidepanel 基于浏览器目录授权的直写盘。

**Architecture:** 保留 background 的 OAuth / session 读取与 CPA JSON artifact 构建逻辑，只替换“保存文件”这一层。sidepanel 负责根目录选择、`IndexedDB` 目录句柄持久化、权限检查与实际文件写入，background 通过 panel bridge / runtime message 请求 sidepanel 写盘并等待结果。

**Tech Stack:** Chrome Extension Manifest V3、sidepanel 页面、`File System Access API`、`IndexedDB`、Node 内置测试框架 `node:test`

---

## File Structure

### Create

- `sidepanel/local-cpa-json-fs.js`
  - 负责目录句柄 `IndexedDB` 持久化、权限检查、`.cli-proxy-api` 目录获取、JSON 文件写入。
- `tests/sidepanel-local-cpa-json-fs.test.js`
  - 负责目录句柄存储与写盘单测。
- `tests/sidepanel-local-cpa-json-browser-write.test.js`
  - 负责 sidepanel 消息处理、本地状态展示与按钮行为单测。

### Modify

- `sidepanel/sidepanel.html`
  - 将“插件目录”区域升级为“展示 + 选择目录按钮 + 权限状态”。
- `sidepanel/sidepanel.js`
  - 接入新写盘模块，管理目录授权状态，处理 background 发来的写盘请求。
- `background/panel-bridge.js`
  - 新增 background 到 sidepanel 的本地写盘桥接协议。
- `background/steps/wait-registration-success.js`
  - `local-cpa-json-no-rt` 导出改为调用 sidepanel 写盘。
- `background/steps/platform-verify.js`
  - `local-cpa-json` 有 RT 导出改为调用 sidepanel 写盘。
- `background.js`
  - 如现有消息路由需要显式注册新 bridge message，则补充路由与状态字段默认值。
- `tests/background-panel-bridge-module.test.js`
  - 校验新 bridge 请求/错误分支。
- `tests/background-step6-retry-limit.test.js`
  - 校验无 RT 路径改为 sidepanel 写盘。
- `tests/background-platform-verify-cpa-api.test.js`
  - 校验有 RT 路径改为 sidepanel 写盘。
- `tests/background-account-history-settings.test.js`
  - 如状态字段结构变化，补充归一化断言。
- `tests/sidepanel-contribution-mode.test.js`
  - 如 UI 受模式影响，补充本地 CPA 区域状态展示断言。

## Task 1: Build The Directory Handle Storage And File Writer

**Files:**
- Create: `sidepanel/local-cpa-json-fs.js`
- Test: `tests/sidepanel-local-cpa-json-fs.test.js`

- [ ] **Step 1: Write the failing tests for handle persistence, permission checks, and file writing**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadModule(overrides = {}) {
  const source = fs.readFileSync('sidepanel/local-cpa-json-fs.js', 'utf8');
  const scope = {
    indexedDB: overrides.indexedDB,
    DOMException: overrides.DOMException || globalThis.DOMException,
  };
  return new Function('window', `${source}; return window.SidepanelLocalCpaJsonFs;`)(scope);
}

test('persists and restores a root directory handle from indexeddb', async () => {
  const fakeHandle = { kind: 'directory', name: 'plugin-root' };
  const api = loadModule({
    indexedDB: createFakeIndexedDb(),
  });

  const store = api.createLocalCpaJsonFsStore();
  await store.saveRootDirectoryHandle(fakeHandle);
  const restored = await store.loadRootDirectoryHandle();

  assert.equal(restored, fakeHandle);
});

test('writes cpa json under .cli-proxy-api and returns a label path', async () => {
  const writes = [];
  const rootHandle = createFakeDirectoryHandle('MyPlugin', {
    onWrite: ({ fileName, content }) => writes.push({ fileName, content }),
  });
  const api = loadModule({
    indexedDB: createFakeIndexedDb(),
  });

  const store = api.createLocalCpaJsonFsStore();
  const result = await store.writeAuthJson({
    rootHandle,
    relativeAuthDir: '.cli-proxy-api',
    fileName: 'user@example.com.json',
    jsonText: '{"email":"user@example.com"}\n',
  });

  assert.equal(result.filePathLabel, 'MyPlugin/.cli-proxy-api/user@example.com.json');
  assert.deepStrictEqual(writes, [{
    fileName: 'user@example.com.json',
    content: '{"email":"user@example.com"}\n',
  }]);
});

test('throws an actionable error when directory permission is denied', async () => {
  const api = loadModule({
    indexedDB: createFakeIndexedDb(),
  });
  const store = api.createLocalCpaJsonFsStore();

  await assert.rejects(
    () => store.ensureWritableDirectoryHandle(createPermissionHandle('denied')),
    /本地 CPA 根目录权限已失效/
  );
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test tests/sidepanel-local-cpa-json-fs.test.js`

Expected: FAIL with module/file missing or exported API missing, proving tests cover new behavior instead of existing logic.

- [ ] **Step 3: Implement the directory handle store and writer**

```js
(function attachLocalCpaJsonFs(root, factory) {
  root.SidepanelLocalCpaJsonFs = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createLocalCpaJsonFsModule() {
  const DB_NAME = 'local-cpa-json-fs';
  const STORE_NAME = 'handles';
  const ROOT_DIR_KEY = 'root-directory';
  const DEFAULT_RELATIVE_AUTH_DIR = '.cli-proxy-api';

  function createLocalCpaJsonFsStore(deps = {}) {
    const {
      indexedDB: indexedDbApi = globalThis.indexedDB,
    } = deps;

    async function saveRootDirectoryHandle(handle) { /* open db, put(handle) */ }
    async function loadRootDirectoryHandle() { /* open db, get(ROOT_DIR_KEY) */ }
    async function ensureWritableDirectoryHandle(handle) { /* queryPermission/requestPermission */ }
    async function writeAuthJson({ rootHandle, relativeAuthDir, fileName, jsonText }) {
      const writableRoot = await ensureWritableDirectoryHandle(rootHandle);
      const authDir = await writableRoot.getDirectoryHandle(relativeAuthDir || DEFAULT_RELATIVE_AUTH_DIR, { create: true });
      const fileHandle = await authDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(jsonText);
      await writable.close();
      return {
        filePathLabel: `${writableRoot.name}/${relativeAuthDir || DEFAULT_RELATIVE_AUTH_DIR}/${fileName}`,
      };
    }

    return {
      ensureWritableDirectoryHandle,
      loadRootDirectoryHandle,
      saveRootDirectoryHandle,
      writeAuthJson,
    };
  }

  return { createLocalCpaJsonFsStore };
});
```

- [ ] **Step 4: Run the module tests to verify they pass**

Run: `node --test tests/sidepanel-local-cpa-json-fs.test.js`

Expected: PASS with coverage for `IndexedDB` restore, permission re-check, `.cli-proxy-api` auto-create, and write result label.

- [ ] **Step 5: Commit the storage/writer module**

```bash
git add sidepanel/local-cpa-json-fs.js tests/sidepanel-local-cpa-json-fs.test.js
git commit -m "feat: add local cpa json browser file writer"
```

## Task 2: Wire Sidepanel UI, State, And Message Handling

**Files:**
- Modify: `sidepanel/sidepanel.html`
- Modify: `sidepanel/sidepanel.js`
- Create: `tests/sidepanel-local-cpa-json-browser-write.test.js`

- [ ] **Step 1: Write failing tests for the sidepanel root-directory workflow**

```js
test('local cpa json settings render a selected root directory status instead of requiring a raw path', async () => {
  const dom = createSidepanelDom();
  const api = loadSidepanel(dom, {
    localCpaJsonFs: {
      loadRootDirectoryHandle: async () => ({ name: 'MyPlugin', queryPermission: async () => 'granted' }),
    },
  });

  await api.applySettingsState({
    panelMode: 'local-cpa-json',
    localCpaJsonRootDirName: 'MyPlugin',
    localCpaJsonRootDirStatus: 'granted',
  });

  assert.equal(dom.inputLocalCpaJsonPluginDir.value, 'MyPlugin');
  assert.match(dom.rootDirectoryStatus.textContent, /已授权，可写入/);
});

test('clicking choose-root-directory stores the handle and updates state', async () => {
  const dom = createSidepanelDom();
  let savedHandle = null;
  const pickedHandle = createPermissionHandle('granted', { name: 'PluginRoot' });
  const api = loadSidepanel(dom, {
    showDirectoryPicker: async () => pickedHandle,
    localCpaJsonFs: {
      saveRootDirectoryHandle: async (handle) => { savedHandle = handle; },
      ensureWritableDirectoryHandle: async (handle) => handle,
    },
  });

  await dom.btnChooseLocalCpaJsonRootDir.click();

  assert.equal(savedHandle, pickedHandle);
  assert.equal(dom.inputLocalCpaJsonPluginDir.value, 'PluginRoot');
});

test('sidepanel handles background save request and writes json via directory handle', async () => {
  const dom = createSidepanelDom();
  const api = loadSidepanel(dom, {
    localCpaJsonFs: {
      loadRootDirectoryHandle: async () => createPermissionHandle('granted', { name: 'PluginRoot' }),
      writeAuthJson: async () => ({ filePathLabel: 'PluginRoot/.cli-proxy-api/user@example.com.json' }),
    },
  });

  const response = await api.handleRuntimeMessage({
    type: 'LOCAL_CPA_JSON_WRITE_FILE',
    payload: {
      fileName: 'user@example.com.json',
      jsonText: '{"email":"user@example.com"}\n',
      relativeAuthDir: '.cli-proxy-api',
      registrationEmail: 'user@example.com',
    },
  });

  assert.deepStrictEqual(response, {
    ok: true,
    filePathLabel: 'PluginRoot/.cli-proxy-api/user@example.com.json',
    rootDirName: 'PluginRoot',
  });
});
```

- [ ] **Step 2: Run the sidepanel tests to verify they fail**

Run: `node --test tests/sidepanel-local-cpa-json-browser-write.test.js`

Expected: FAIL because the new buttons, state labels, and `LOCAL_CPA_JSON_WRITE_FILE` message handler do not exist yet.

- [ ] **Step 3: Implement sidepanel UI, persisted state, and runtime message handling**

```html
<div class="data-row" id="row-local-cpa-json-plugin-dir" style="display:none;">
  <span class="data-label">根目录</span>
  <div class="data-inline data-inline-wrap">
    <input type="text" id="input-local-cpa-json-plugin-dir" class="data-input" readonly placeholder="未选择根目录" />
    <button id="btn-choose-local-cpa-json-root-dir" class="btn btn-ghost btn-xs" type="button">选择根目录</button>
    <button id="btn-check-local-cpa-json-root-dir" class="btn btn-ghost btn-xs" type="button">检测权限</button>
  </div>
</div>
<div class="data-row" id="row-local-cpa-json-root-dir-status" style="display:none;">
  <span class="data-label">状态</span>
  <span id="text-local-cpa-json-root-dir-status" class="hero-sms-country-note">未选择目录</span>
</div>
```

```js
const localCpaJsonFsStore = window.SidepanelLocalCpaJsonFs?.createLocalCpaJsonFsStore?.();

async function chooseLocalCpaJsonRootDirectory() {
  const handle = await window.showDirectoryPicker();
  await localCpaJsonFsStore.saveRootDirectoryHandle(handle);
  await localCpaJsonFsStore.ensureWritableDirectoryHandle(handle);
  latestState.localCpaJsonRootDirName = handle.name;
  latestState.localCpaJsonRootDirStatus = 'granted';
  await persistSettings({ localCpaJsonRootDirName: handle.name, localCpaJsonRootDirStatus: 'granted' });
  renderLocalCpaJsonRootDirState();
}

async function handleLocalCpaJsonWriteRequest(payload = {}) {
  const rootHandle = await localCpaJsonFsStore.loadRootDirectoryHandle();
  if (!rootHandle) {
    throw new Error('尚未选择本地 CPA 根目录，请先在侧边栏完成授权。');
  }
  const result = await localCpaJsonFsStore.writeAuthJson({
    rootHandle,
    relativeAuthDir: payload.relativeAuthDir,
    fileName: payload.fileName,
    jsonText: payload.jsonText,
  });
  return {
    ok: true,
    filePathLabel: result.filePathLabel,
    rootDirName: rootHandle.name,
  };
}
```

- [ ] **Step 4: Run the sidepanel tests to verify they pass**

Run: `node --test tests/sidepanel-local-cpa-json-browser-write.test.js`

Expected: PASS with successful handle selection, status rendering, and save-request response coverage.

- [ ] **Step 5: Commit the sidepanel integration**

```bash
git add sidepanel/sidepanel.html sidepanel/sidepanel.js tests/sidepanel-local-cpa-json-browser-write.test.js
git commit -m "feat: add sidepanel local cpa json directory authorization"
```

## Task 3: Add A Background-To-Sidepanel Save Bridge

**Files:**
- Modify: `background/panel-bridge.js`
- Modify: `background.js`
- Test: `tests/background-panel-bridge-module.test.js`

- [ ] **Step 1: Write the failing bridge tests**

```js
test('panel bridge saves local cpa json through sidepanel runtime channel', async () => {
  const sendCalls = [];
  const bridge = api.createPanelBridge({
    addLog: async () => {},
    sendRuntimeMessageToSidepanel: async (message) => {
      sendCalls.push(message);
      return {
        ok: true,
        filePathLabel: 'PluginRoot/.cli-proxy-api/user@example.com.json',
        rootDirName: 'PluginRoot',
      };
    },
  });

  const result = await bridge.saveLocalCpaJsonViaPanel({
    fileName: 'user@example.com.json',
    jsonText: '{"email":"user@example.com"}\n',
    relativeAuthDir: '.cli-proxy-api',
    registrationEmail: 'user@example.com',
  });

  assert.equal(sendCalls[0].type, 'LOCAL_CPA_JSON_WRITE_FILE');
  assert.equal(result.filePathLabel, 'PluginRoot/.cli-proxy-api/user@example.com.json');
});

test('panel bridge throws an actionable error when sidepanel is unavailable', async () => {
  const bridge = api.createPanelBridge({
    addLog: async () => {},
    sendRuntimeMessageToSidepanel: async () => {
      throw new Error('Receiving end does not exist.');
    },
  });

  await assert.rejects(
    () => bridge.saveLocalCpaJsonViaPanel({
      fileName: 'user@example.com.json',
      jsonText: '{}\n',
      registrationEmail: 'user@example.com',
    }),
    /当前未检测到侧边栏写盘通道/
  );
});
```

- [ ] **Step 2: Run the bridge tests to verify they fail**

Run: `node --test tests/background-panel-bridge-module.test.js`

Expected: FAIL because `saveLocalCpaJsonViaPanel()` and the sidepanel runtime channel do not exist yet.

- [ ] **Step 3: Implement the bridge helper and message route**

```js
function createPanelBridge(deps = {}) {
  const {
    sendRuntimeMessageToSidepanel = async (message) => chrome.runtime.sendMessage(message),
  } = deps;

  async function saveLocalCpaJsonViaPanel(payload = {}) {
    try {
      const response = await sendRuntimeMessageToSidepanel({
        type: 'LOCAL_CPA_JSON_WRITE_FILE',
        source: 'background',
        payload,
      });
      if (response?.error) {
        throw new Error(response.error);
      }
      if (!response?.ok) {
        throw new Error('sidepanel did not confirm the local cpa json write.');
      }
      return response;
    } catch (error) {
      const message = String(error?.message || error || '').trim();
      if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
        throw new Error('当前未检测到侧边栏写盘通道，请打开扩展侧边栏后重试。');
      }
      throw error;
    }
  }

  return {
    requestOAuthUrlFromPanel,
    saveLocalCpaJsonViaPanel,
  };
}
```

- [ ] **Step 4: Run the bridge tests to verify they pass**

Run: `node --test tests/background-panel-bridge-module.test.js`

Expected: PASS with success and missing-sidepanel branches covered.

- [ ] **Step 5: Commit the bridge changes**

```bash
git add background/panel-bridge.js background.js tests/background-panel-bridge-module.test.js
git commit -m "feat: add panel bridge for local cpa json browser writes"
```

## Task 4: Migrate The No-RT Export Path To Browser Writes

**Files:**
- Modify: `background/steps/wait-registration-success.js`
- Test: `tests/background-step6-retry-limit.test.js`

- [ ] **Step 1: Write the failing no-RT export tests**

```js
test('local cpa json no-RT export saves through sidepanel after artifact generation', async () => {
  const saveCalls = [];
  const executor = api.createStep6Executor({
    addLog: async () => {},
    createLocalCliProxyApi: () => ({
      buildAuthJsonArtifact: async () => ({
        filePath: 'ignored-by-browser-write',
        jsonText: '{"email":"user@example.com"}\n',
        warnings: [],
      }),
    }),
    saveLocalCpaJsonViaPanel: async (payload) => {
      saveCalls.push(payload);
      return { ok: true, filePathLabel: 'PluginRoot/.cli-proxy-api/user@example.com.json' };
    },
    sendToContentScriptResilient: async () => ({
      email: 'user@example.com',
      session: { user: { email: 'user@example.com' }, account: { id: 'acct-1', planType: 'plus' } },
    }),
  });

  const result = await executor.executeLocalCpaJsonNoRtExport({
    panelMode: 'local-cpa-json-no-rt',
    localCpaJsonPluginDir: 'PluginRoot',
  });

  assert.equal(saveCalls[0].fileName, 'user@example.com.json');
  assert.equal(result.localCpaJsonFilePath, 'PluginRoot/.cli-proxy-api/user@example.com.json');
});

test('local cpa json no-RT export fails when no sidepanel write channel is available', async () => {
  const executor = api.createStep6Executor({
    addLog: async () => {},
    createLocalCliProxyApi: () => ({ buildAuthJsonArtifact: async () => ({ jsonText: '{}\n', warnings: [] }) }),
    saveLocalCpaJsonViaPanel: async () => {
      throw new Error('当前未检测到侧边栏写盘通道，请打开扩展侧边栏后重试。');
    },
    sendToContentScriptResilient: async () => ({ email: 'user@example.com', session: { user: { email: 'user@example.com' } } }),
  });

  await assert.rejects(
    () => executor.executeLocalCpaJsonNoRtExport({ panelMode: 'local-cpa-json-no-rt' }),
    /当前未检测到侧边栏写盘通道/
  );
});
```

- [ ] **Step 2: Run the no-RT tests to verify they fail**

Run: `node --test tests/background-step6-retry-limit.test.js`

Expected: FAIL because step 6 still calls helper fetch instead of the new panel save bridge.

- [ ] **Step 3: Implement no-RT save via sidepanel**

```js
function createStep6Executor(deps = {}) {
  const {
    saveLocalCpaJsonViaPanel = null,
  } = deps;

  async function exportLocalCpaJsonNoRt(state = {}, options = {}) {
    const artifact = await api.buildAuthJsonArtifact({ /* existing fields */ });
    const email = normalizeString(state?.email || sessionResult?.email || sessionResult?.session?.user?.email);
    if (!email) {
      throw new Error('缺少注册邮箱，无法生成本地 CPA JSON 文件名。');
    }
    const saved = await saveLocalCpaJsonViaPanel({
      fileName: `${email}.json`,
      jsonText: artifact.jsonText,
      relativeAuthDir: state.localCpaJsonRelativeAuthDir,
      registrationEmail: email,
    });
    return {
      verifiedStatus: `本地CPA JSON 无RT 已导出：${saved.filePathLabel}`,
      localCpaJsonFilePath: saved.filePathLabel,
    };
  }
}
```

- [ ] **Step 4: Run the no-RT tests to verify they pass**

Run: `node --test tests/background-step6-retry-limit.test.js`

Expected: PASS with sidepanel-save success path and missing-channel failure path both covered.

- [ ] **Step 5: Commit the no-RT migration**

```bash
git add background/steps/wait-registration-success.js tests/background-step6-retry-limit.test.js
git commit -m "refactor: route no-rt local cpa export through sidepanel"
```

## Task 5: Migrate The With-RT Export Path To Browser Writes

**Files:**
- Modify: `background/steps/platform-verify.js`
- Test: `tests/background-platform-verify-cpa-api.test.js`

- [ ] **Step 1: Write the failing with-RT export tests**

```js
test('platform verify local cpa json export saves through sidepanel after callback exchange', async () => {
  const saveCalls = [];
  const executor = api.createStep10Executor({
    addLog: async () => {},
    getPanelMode: () => 'local-cpa-json',
    createLocalCliProxyApi: () => ({
      exchangeCallbackToAuthArtifact: async () => ({
        jsonText: '{"email":"flow@example.com"}\n',
        warnings: [],
      }),
    }),
    saveLocalCpaJsonViaPanel: async (payload) => {
      saveCalls.push(payload);
      return { ok: true, filePathLabel: 'PluginRoot/.cli-proxy-api/flow@example.com.json' };
    },
  });

  await executor.executeStep10({
    panelMode: 'local-cpa-json',
    localhostUrl: 'http://localhost:1455/auth/callback?code=callback-code&state=oauth-state',
    localCpaJsonOAuthState: 'oauth-state',
    email: 'flow@example.com',
    localCpaJsonPkceCodes: { codeVerifier: 'verifier-local' },
  });

  assert.equal(saveCalls[0].fileName, 'flow@example.com.json');
});

test('platform verify local cpa json export reports missing root directory authorization', async () => {
  const executor = api.createStep10Executor({
    addLog: async () => {},
    getPanelMode: () => 'local-cpa-json',
    createLocalCliProxyApi: () => ({
      exchangeCallbackToAuthArtifact: async () => ({ jsonText: '{}\n', warnings: [] }),
    }),
    saveLocalCpaJsonViaPanel: async () => {
      throw new Error('尚未选择本地 CPA 根目录，请先在侧边栏完成授权。');
    },
  });

  await assert.rejects(
    () => executor.executeStep10({
      panelMode: 'local-cpa-json',
      localhostUrl: 'http://localhost:1455/auth/callback?code=callback-code&state=oauth-state',
      localCpaJsonOAuthState: 'oauth-state',
      email: 'flow@example.com',
      localCpaJsonPkceCodes: { codeVerifier: 'verifier-local' },
    }),
    /尚未选择本地 CPA 根目录/
  );
});
```

- [ ] **Step 2: Run the with-RT tests to verify they fail**

Run: `node --test tests/background-platform-verify-cpa-api.test.js`

Expected: FAIL because step 10 still attempts helper save instead of panel save.

- [ ] **Step 3: Implement with-RT save via sidepanel**

```js
async function executeLocalCpaJsonStep10(state) {
  const artifact = await api.exchangeCallbackToAuthArtifact({
    callbackUrl: callback.url,
    expectedState,
    pkceCodes: state.localCpaJsonPkceCodes,
    pluginDir,
    relativeAuthDir: state.localCpaJsonRelativeAuthDir,
    registrationEmail: state.email,
    now: new Date(),
  });
  const email = normalizeString(state.email);
  if (!email) {
    throw new Error('缺少注册邮箱，无法生成本地 CPA JSON 文件名。');
  }
  const saved = await saveLocalCpaJsonViaPanel({
    fileName: `${email}.json`,
    jsonText: artifact.jsonText,
    relativeAuthDir: state.localCpaJsonRelativeAuthDir,
    registrationEmail: email,
  });
  await completeNodeFromBackground(state?.nodeId || 'platform-verify', {
    localhostUrl: callback.url,
    verifiedStatus: `本地CPA JSON 有RT 已导出：${saved.filePathLabel}`,
    localCpaJsonFilePath: saved.filePathLabel,
  });
}
```

- [ ] **Step 4: Run the with-RT tests to verify they pass**

Run: `node --test tests/background-platform-verify-cpa-api.test.js`

Expected: PASS with sidepanel write success and “root directory not authorized” failure both covered.

- [ ] **Step 5: Commit the with-RT migration**

```bash
git add background/steps/platform-verify.js tests/background-platform-verify-cpa-api.test.js
git commit -m "refactor: route local cpa oauth export through sidepanel"
```

## Task 6: Update Validation, Regression Coverage, And Remove Helper As Main Path

**Files:**
- Modify: `background/panel-bridge.js`
- Modify: `sidepanel/sidepanel.js`
- Modify: `tests/background-account-history-settings.test.js`
- Modify: `tests/sidepanel-contribution-mode.test.js`
- Modify: `tests/background-step6-retry-limit.test.js`
- Modify: `tests/background-platform-verify-cpa-api.test.js`

- [ ] **Step 1: Write failing validation/regression tests for the new directory-based UX**

```js
test('local cpa json panel mode no longer marks the display field invalid when a stored directory handle exists', async () => {
  const result = api.validateLocalCpaJsonPluginDir({
    panelMode: 'local-cpa-json',
    rootDirAuthorized: true,
  });

  assert.equal(result.valid, true);
});

test('background local cpa export regression keeps worker-compatible json content while using browser writes', async () => {
  const savedJson = JSON.parse(saveCalls[0].jsonText);
  assert.equal(savedJson.email, 'user@example.com');
  assert.equal(savedJson.chatgpt_account_id, 'acct-1');
  assert.equal(savedJson.plan_type, 'plus');
});
```

- [ ] **Step 2: Run the focused regression tests to verify they fail**

Run: `node --test tests/background-account-history-settings.test.js tests/sidepanel-contribution-mode.test.js tests/background-step6-retry-limit.test.js tests/background-platform-verify-cpa-api.test.js`

Expected: FAIL because the UI still requires a raw path and the new state fields are not wired into validation/rendering.

- [ ] **Step 3: Implement validation cleanup and explicit non-helper main path behavior**

```js
function validateLocalCpaJsonPluginDir(options = {}) {
  const required = panelMode === localCpaJsonMode || panelMode === localCpaJsonNoRtMode;
  const rootDirAuthorized = Boolean(options.rootDirAuthorized ?? latestState?.localCpaJsonRootDirStatus === 'granted');
  const displayValue = String(inputLocalCpaJsonPluginDir?.value || '').trim();
  const valid = !required || rootDirAuthorized || Boolean(displayValue);
  inputLocalCpaJsonPluginDir.classList.toggle('is-invalid', required && !rootDirAuthorized);
  inputLocalCpaJsonPluginDir.title = required && !rootDirAuthorized
    ? '本地CPA JSON 模式下必须先选择并授权根目录'
    : '';
  return { valid, required, pluginDir: displayValue, rootDirAuthorized };
}
```

- [ ] **Step 4: Run the full regression set to verify everything passes**

Run: `node --test tests/sidepanel-local-cpa-json-fs.test.js tests/sidepanel-local-cpa-json-browser-write.test.js tests/background-panel-bridge-module.test.js tests/background-step6-retry-limit.test.js tests/background-platform-verify-cpa-api.test.js tests/background-account-history-settings.test.js tests/sidepanel-contribution-mode.test.js`

Expected: PASS with browser-write coverage, updated validation, and no regression in CPA JSON structure assertions.

- [ ] **Step 5: Commit the regression and validation cleanup**

```bash
git add sidepanel/sidepanel.js tests/background-account-history-settings.test.js tests/sidepanel-contribution-mode.test.js tests/background-step6-retry-limit.test.js tests/background-platform-verify-cpa-api.test.js tests/sidepanel-local-cpa-json-fs.test.js tests/sidepanel-local-cpa-json-browser-write.test.js tests/background-panel-bridge-module.test.js
git commit -m "test: cover browser-based local cpa json export flow"
```

## Task 7: Final Verification And Documentation Sync

**Files:**
- Modify: `docs/superpowers/specs/2026-05-21-local-cpa-json-browser-write-design.md` (only if implementation meaningfully diverges)
- Modify: `docs/superpowers/plans/2026-05-21-local-cpa-json-browser-write.md` (check off completed steps during execution if desired)

- [ ] **Step 1: Run the targeted final verification commands**

Run: `node --test tests/sidepanel-local-cpa-json-fs.test.js tests/sidepanel-local-cpa-json-browser-write.test.js tests/background-panel-bridge-module.test.js tests/background-step6-retry-limit.test.js tests/background-platform-verify-cpa-api.test.js`

Expected: PASS

Run: `node --test tests/cpa-json-builder.test.js tests/background-local-cli-proxy-api.test.js`

Expected: PASS, confirming worker-compatible JSON generation is unchanged.

- [ ] **Step 2: Run one broader regression command for touched platform plumbing**

Run: `node --test tests/background-step-registry.test.js tests/step-definitions-module.test.js tests/flow-capabilities-module.test.js`

Expected: PASS, confirming the flow graph and mode routing still recognize both local CPA modes.

- [ ] **Step 3: Inspect git diff and confirm helper is no longer the main path for local CPA exports**

Run: `git diff --stat`

Expected: only the planned sidepanel/background/tests/docs files changed; helper code, if untouched, is now non-primary for local CPA export.

- [ ] **Step 4: Commit any final doc sync if needed**

```bash
git add docs/superpowers/specs/2026-05-21-local-cpa-json-browser-write-design.md docs/superpowers/plans/2026-05-21-local-cpa-json-browser-write.md
git commit -m "docs: sync browser write implementation notes"
```

- [ ] **Step 5: Prepare execution handoff summary**

```text
- 已完成目录句柄写盘基础模块
- 已完成 sidepanel 授权与写盘消息处理
- 已完成有RT/无RT 两条链路切换
- 已完成回归验证
- 若仍有残留 helper 逻辑，仅作为兼容代码存在，不再是主路径
```

## Self-Review

- Spec coverage:
  - 目录句柄授权、`IndexedDB` 持久化、`.cli-proxy-api` 自动创建、sidepanel 写盘、background 消息桥、两条导出链路切换、错误提示、测试与回归，均已映射到 Task 1-7。
- Placeholder scan:
  - 未保留 `TODO` / `TBD`；每个任务都包含具体文件、测试、命令、预期结果。
- Type consistency:
  - 统一使用 `LOCAL_CPA_JSON_WRITE_FILE`、`filePathLabel`、`localCpaJsonRootDirName`、`localCpaJsonRootDirStatus`、`saveLocalCpaJsonViaPanel()` 作为跨任务协议命名。
