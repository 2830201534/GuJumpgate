const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sidepanelHtml = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function createButton() {
  return {
    disabled: false,
    dataset: {},
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    async click() {
      const listener = this.listeners.get('click');
      if (listener) {
        await listener({ currentTarget: this, preventDefault() {} });
      }
    },
  };
}

function createInput() {
  return {
    value: '',
    readOnly: false,
    classList: {
      toggle() {},
    },
    title: '',
  };
}

function createLabel() {
  return {
    textContent: '',
    className: '',
  };
}

function loadModule(overrides = {}) {
  const source = fs.readFileSync('sidepanel/local-cpa-json-browser-write.js', 'utf8');
  const windowObject = {
    showDirectoryPicker: overrides.showDirectoryPicker,
  };
  return new Function('window', `${source}; return window.SidepanelLocalCpaJsonBrowserWrite;`)(windowObject);
}

function createPermissionHandle(permission = 'granted', extras = {}) {
  return {
    kind: 'directory',
    name: extras.name || 'PluginRoot',
    async queryPermission() {
      return permission;
    },
    async requestPermission() {
      return permission;
    },
  };
}

test('manager renders granted root directory status into the local cpa json display field', async () => {
  const api = loadModule();
  const dom = {
    inputLocalCpaJsonPluginDir: createInput(),
    textLocalCpaJsonRootDirStatus: createLabel(),
    btnChooseLocalCpaJsonRootDir: createButton(),
    btnCheckLocalCpaJsonRootDir: createButton(),
  };
  const manager = api.createLocalCpaJsonBrowserWriteManager({
    dom,
    state: {
      getLatestState: () => ({
        localCpaJsonRootDirName: 'MyPlugin',
        localCpaJsonRootDirStatus: 'granted',
      }),
      syncLatestState: () => {},
    },
    localCpaJsonFs: {
      loadRootDirectoryHandle: async () => createPermissionHandle('granted', { name: 'MyPlugin' }),
      ensureWritableDirectoryHandle: async (handle) => handle,
    },
    helpers: {
      persistStatePatch: async () => {},
      showToast: () => {},
    },
  });

  await manager.refreshAuthorizationState();

  assert.equal(dom.inputLocalCpaJsonPluginDir.value, 'MyPlugin');
  assert.match(dom.textLocalCpaJsonRootDirStatus.textContent, /已授权，可写入/);
});

test('choosing a root directory stores the handle and persists state patch', async () => {
  let savedHandle = null;
  let persistedPatch = null;
  const pickedHandle = createPermissionHandle('granted', { name: 'PluginRoot' });
  const api = loadModule({
    showDirectoryPicker: async () => pickedHandle,
  });
  const dom = {
    inputLocalCpaJsonPluginDir: createInput(),
    textLocalCpaJsonRootDirStatus: createLabel(),
    btnChooseLocalCpaJsonRootDir: createButton(),
    btnCheckLocalCpaJsonRootDir: createButton(),
  };
  const manager = api.createLocalCpaJsonBrowserWriteManager({
    dom,
    state: {
      getLatestState: () => ({}),
      syncLatestState: () => {},
    },
    localCpaJsonFs: {
      saveRootDirectoryHandle: async (handle) => {
        savedHandle = handle;
      },
      ensureWritableDirectoryHandle: async (handle) => handle,
      loadRootDirectoryHandle: async () => pickedHandle,
    },
    helpers: {
      persistStatePatch: async (patch) => {
        persistedPatch = patch;
      },
      showToast: () => {},
    },
  });

  manager.bindEvents();
  await dom.btnChooseLocalCpaJsonRootDir.click();

  assert.equal(savedHandle, pickedHandle);
  assert.deepStrictEqual(persistedPatch, {
    localCpaJsonRootDirName: 'PluginRoot',
    localCpaJsonRootDirStatus: 'granted',
  });
  assert.equal(dom.inputLocalCpaJsonPluginDir.value, 'PluginRoot');
});

test('manager handles background save request and writes json through directory handle store', async () => {
  const api = loadModule();
  const dom = {
    inputLocalCpaJsonPluginDir: createInput(),
    textLocalCpaJsonRootDirStatus: createLabel(),
    btnChooseLocalCpaJsonRootDir: createButton(),
    btnCheckLocalCpaJsonRootDir: createButton(),
  };
  const manager = api.createLocalCpaJsonBrowserWriteManager({
    dom,
    state: {
      getLatestState: () => ({
        localCpaJsonRootDirName: 'PluginRoot',
        localCpaJsonRootDirStatus: 'granted',
      }),
      syncLatestState: () => {},
    },
    localCpaJsonFs: {
      loadRootDirectoryHandle: async () => createPermissionHandle('granted', { name: 'PluginRoot' }),
      writeAuthJson: async () => ({
        filePathLabel: 'PluginRoot/user@example.com.json',
      }),
    },
    helpers: {
      persistStatePatch: async () => {},
      showToast: () => {},
    },
  });

  const response = await manager.handleRuntimeMessage({
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
    filePathLabel: 'PluginRoot/user@example.com.json',
    rootDirName: 'PluginRoot',
  });
});

test('refreshAuthorizationState marks prompt-only handles as denied without requesting permission', async () => {
  let requestPermissionCalled = false;
  const api = loadModule();
  const dom = {
    inputLocalCpaJsonPluginDir: createInput(),
    textLocalCpaJsonRootDirStatus: createLabel(),
    btnChooseLocalCpaJsonRootDir: createButton(),
    btnCheckLocalCpaJsonRootDir: createButton(),
  };
  const handle = {
    kind: 'directory',
    name: 'PluginRoot',
    async queryPermission() {
      return 'prompt';
    },
    async requestPermission() {
      requestPermissionCalled = true;
      throw new Error('User activation is required');
    },
  };
  const manager = api.createLocalCpaJsonBrowserWriteManager({
    dom,
    state: {
      getLatestState: () => ({
        localCpaJsonRootDirName: 'PluginRoot',
        localCpaJsonRootDirStatus: 'granted',
      }),
      syncLatestState: () => {},
    },
    localCpaJsonFs: {
      loadRootDirectoryHandle: async () => handle,
      ensureWritableDirectoryHandle: async (target, options = {}) => {
        if (options.allowPrompt) {
          return target;
        }
        throw new Error('本地 CPA 根目录权限已失效，请重新选择或重新授权后重试。');
      },
    },
    helpers: {
      persistStatePatch: async () => {},
      showToast: () => {},
    },
  });

  const result = await manager.refreshAuthorizationState();

  assert.equal(result.rootDirStatus, 'denied');
  assert.match(dom.textLocalCpaJsonRootDirStatus.textContent, /权限失效/);
  assert.equal(requestPermissionCalled, false);
});

test('sidepanel html exposes local cpa json root directory actions and loads the browser write module', () => {
  assert.match(sidepanelHtml, /id="btn-choose-local-cpa-json-root-dir"/);
  assert.match(sidepanelHtml, /id="btn-check-local-cpa-json-root-dir"/);
  assert.match(sidepanelHtml, /id="row-local-cpa-json-root-dir-status"/);
  assert.match(sidepanelHtml, /id="text-local-cpa-json-root-dir-status"/);
  assert.match(sidepanelHtml, /<script src="local-cpa-json-fs\.js"><\/script>/);
  assert.match(sidepanelHtml, /<script src="local-cpa-json-browser-write\.js"><\/script>/);
});

test('sidepanel source wires local cpa json browser write manager into runtime messages', () => {
  assert.match(sidepanelSource, /const btnChooseLocalCpaJsonRootDir = document\.getElementById\('btn-choose-local-cpa-json-root-dir'\);/);
  assert.match(sidepanelSource, /const btnCheckLocalCpaJsonRootDir = document\.getElementById\('btn-check-local-cpa-json-root-dir'\);/);
  assert.match(sidepanelSource, /const textLocalCpaJsonRootDirStatus = document\.getElementById\('text-local-cpa-json-root-dir-status'\);/);
  assert.match(sidepanelSource, /window\.SidepanelLocalCpaJsonBrowserWrite\?\.createLocalCpaJsonBrowserWriteManager/);
  assert.match(sidepanelSource, /case 'LOCAL_CPA_JSON_WRITE_FILE':/);
});
