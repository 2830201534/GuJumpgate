const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function createFakeIndexedDb() {
  const records = new Map();

  return {
    open() {
      const request = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };

      queueMicrotask(() => {
        const db = {
          objectStoreNames: {
            contains(name) {
              return name === 'handles';
            },
          },
          createObjectStore() {
            return {};
          },
          transaction() {
            return {
              objectStore() {
                return {
                  get(key) {
                    const getRequest = {
                      result: records.get(key),
                      onsuccess: null,
                      onerror: null,
                    };
                    queueMicrotask(() => {
                      getRequest.onsuccess?.({ target: getRequest });
                    });
                    return getRequest;
                  },
                  put(value, key) {
                    records.set(key, value);
                    const putRequest = {
                      result: key,
                      onsuccess: null,
                      onerror: null,
                    };
                    queueMicrotask(() => {
                      putRequest.onsuccess?.({ target: putRequest });
                    });
                    return putRequest;
                  },
                };
              },
            };
          },
        };
        request.result = db;
        request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });

      return request;
    },
  };
}

function createFakeDirectoryHandle(name, options = {}) {
  const writes = [];
  const nestedDirectories = new Map();

  const handle = {
    kind: 'directory',
    name,
    async queryPermission() {
      return options.permission || 'granted';
    },
    async requestPermission() {
      return options.requestPermissionResult || options.permission || 'granted';
    },
    async getDirectoryHandle(directoryName, { create } = {}) {
      if (!create && !nestedDirectories.has(directoryName)) {
        throw new Error(`missing directory ${directoryName}`);
      }
      if (!nestedDirectories.has(directoryName)) {
        nestedDirectories.set(directoryName, {
          async getFileHandle(fileName, { create: createFile } = {}) {
            if (!createFile) {
              throw new Error(`missing file ${fileName}`);
            }
            return {
              async createWritable() {
                return {
                  async write(content) {
                    writes.push({ fileName, content });
                    options.onWrite?.({ fileName, content });
                  },
                  async close() {},
                };
              },
            };
          },
        });
      }
      return nestedDirectories.get(directoryName);
    },
  };

  return { handle, writes };
}

function createPermissionHandle(permission = 'denied', extras = {}) {
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

  const store = api.createLocalCpaJsonFsStore({
    indexedDB: createFakeIndexedDb(),
  });
  await store.saveRootDirectoryHandle(fakeHandle);
  const restored = await store.loadRootDirectoryHandle();

  assert.equal(restored, fakeHandle);
});

test('writes cpa json under .cli-proxy-api and returns a label path', async () => {
  const { handle: rootHandle, writes } = createFakeDirectoryHandle('MyPlugin');
  const api = loadModule({
    indexedDB: createFakeIndexedDb(),
  });

  const store = api.createLocalCpaJsonFsStore({
    indexedDB: createFakeIndexedDb(),
  });
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
  const store = api.createLocalCpaJsonFsStore({
    indexedDB: createFakeIndexedDb(),
  });

  await assert.rejects(
    () => store.ensureWritableDirectoryHandle(createPermissionHandle('denied')),
    /本地 CPA 根目录权限已失效/
  );
});
