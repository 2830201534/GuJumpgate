(function attachLocalCpaJsonFs(root, factory) {
  root.SidepanelLocalCpaJsonFs = factory();
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis), function createLocalCpaJsonFsModule() {
  const DB_NAME = 'local-cpa-json-fs';
  const STORE_NAME = 'handles';
  const ROOT_DIR_KEY = 'root-directory';
  const DEFAULT_RELATIVE_AUTH_DIR = '.cli-proxy-api';

  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  function openDatabase(indexedDbApi) {
    return new Promise((resolve, reject) => {
      if (!indexedDbApi?.open) {
        reject(new Error('当前环境不支持 IndexedDB，无法持久化本地 CPA 根目录授权。'));
        return;
      }

      const request = indexedDbApi.open(DB_NAME, 1);
      request.onerror = () => {
        reject(request.error || new Error('打开本地目录授权存储失败。'));
      };
      request.onupgradeneeded = (event) => {
        const db = event?.target?.result;
        if (!db?.objectStoreNames?.contains?.(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  function requestStoreOperation(indexedDbApi, mode, handler) {
    return openDatabase(indexedDbApi).then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = handler(store);
      request.onerror = () => {
        reject(request.error || new Error('访问本地目录授权存储失败。'));
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
    }));
  }

  function createLocalCpaJsonFsStore(deps = {}) {
    const {
      indexedDB: indexedDbApi = globalThis.indexedDB,
    } = deps;

    async function saveRootDirectoryHandle(handle) {
      if (!handle || handle.kind !== 'directory') {
        throw new Error('无效的本地 CPA 根目录句柄。');
      }
      await requestStoreOperation(indexedDbApi, 'readwrite', (store) => store.put(handle, ROOT_DIR_KEY));
      return handle;
    }

    function loadRootDirectoryHandle() {
      return requestStoreOperation(indexedDbApi, 'readonly', (store) => store.get(ROOT_DIR_KEY));
    }

    async function ensureWritableDirectoryHandle(handle, { allowPrompt = false } = {}) {
      if (!handle || handle.kind !== 'directory') {
        throw new Error('尚未选择本地 CPA 根目录，请先在侧边栏完成授权。');
      }

      const queryPermission = typeof handle.queryPermission === 'function'
        ? handle.queryPermission.bind(handle)
        : null;
      const requestPermission = typeof handle.requestPermission === 'function'
        ? handle.requestPermission.bind(handle)
        : null;

      let permission = queryPermission
        ? await queryPermission({ mode: 'readwrite' })
        : 'granted';
      if (permission !== 'granted' && allowPrompt && requestPermission) {
        permission = await requestPermission({ mode: 'readwrite' });
      }
      if (permission !== 'granted') {
        throw new Error('本地 CPA 根目录权限已失效，请重新选择或重新授权后重试。');
      }
      return handle;
    }

    async function writeAuthJson({
      rootHandle,
      relativeAuthDir = DEFAULT_RELATIVE_AUTH_DIR,
      fileName,
      jsonText,
    } = {}) {
      const writableRoot = await ensureWritableDirectoryHandle(rootHandle, { allowPrompt: false });
      const normalizedRelativeAuthDir = normalizeString(relativeAuthDir) || DEFAULT_RELATIVE_AUTH_DIR;
      const normalizedFileName = normalizeString(fileName);
      if (!normalizedFileName) {
        throw new Error('缺少注册邮箱，无法生成本地 CPA JSON 文件名。');
      }

      const authDir = await writableRoot.getDirectoryHandle(normalizedRelativeAuthDir, { create: true });
      const fileHandle = await authDir.getFileHandle(normalizedFileName, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(String(jsonText || ''));
      } finally {
        await writable.close();
      }

      return {
        filePathLabel: `${writableRoot.name}/${normalizedRelativeAuthDir}/${normalizedFileName}`,
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
