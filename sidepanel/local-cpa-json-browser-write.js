(function attachLocalCpaJsonBrowserWrite(root, factory) {
  root.SidepanelLocalCpaJsonBrowserWrite = factory();
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis), function createLocalCpaJsonBrowserWriteModule() {
  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  function createLocalCpaJsonBrowserWriteManager(deps = {}) {
    const {
      dom = {},
      helpers = {},
      localCpaJsonFs = null,
      state = {},
      showDirectoryPicker = typeof window !== 'undefined' ? window.showDirectoryPicker?.bind(window) : null,
    } = deps;

    const {
      btnCheckLocalCpaJsonRootDir = null,
      btnChooseLocalCpaJsonRootDir = null,
      inputLocalCpaJsonPluginDir = null,
      textLocalCpaJsonRootDirStatus = null,
    } = dom;

    const {
      persistStatePatch = async () => {},
      showToast = () => {},
    } = helpers;

    const {
      getLatestState = () => ({}),
      syncLatestState = () => {},
    } = state;
    let cachedRootHandle = null;

    function rememberRootHandle(handle) {
      cachedRootHandle = handle && handle.kind === 'directory'
        ? handle
        : null;
      return cachedRootHandle;
    }

    function setStatusText(status, rootDirName = '') {
      if (!textLocalCpaJsonRootDirStatus) return;
      const normalizedName = normalizeString(rootDirName);
      if (status === 'granted') {
        textLocalCpaJsonRootDirStatus.textContent = normalizedName
          ? `已授权，可写入：${normalizedName}`
          : '已授权，可写入';
        return;
      }
      if (status === 'missing') {
        textLocalCpaJsonRootDirStatus.textContent = '未选择目录';
        return;
      }
      if (status === 'denied') {
        textLocalCpaJsonRootDirStatus.textContent = '权限失效，需重新授权';
        return;
      }
      textLocalCpaJsonRootDirStatus.textContent = '写入失败，请查看日志';
    }

    function renderStateSnapshot(snapshot = {}) {
      const rootDirName = normalizeString(snapshot?.localCpaJsonRootDirName);
      const rootDirStatus = normalizeString(snapshot?.localCpaJsonRootDirStatus) || 'missing';
      if (inputLocalCpaJsonPluginDir) {
        inputLocalCpaJsonPluginDir.value = rootDirName;
        inputLocalCpaJsonPluginDir.title = rootDirName;
      }
      setStatusText(rootDirStatus, rootDirName);
    }

    async function updateStoredStatePatch(patch = {}) {
      syncLatestState(patch);
      await persistStatePatch(patch);
      renderStateSnapshot({
        ...getLatestState(),
        ...patch,
      });
    }

    async function refreshAuthorizationState() {
      const latest = getLatestState();
      const rootHandle = rememberRootHandle(
        cachedRootHandle || await localCpaJsonFs?.loadRootDirectoryHandle?.()
      );
      if (!rootHandle) {
        renderStateSnapshot({
          ...latest,
          localCpaJsonRootDirName: '',
          localCpaJsonRootDirStatus: 'missing',
        });
        return {
          rootDirHandle: null,
          rootDirName: '',
          rootDirStatus: 'missing',
        };
      }

      try {
        await localCpaJsonFs.ensureWritableDirectoryHandle(rootHandle, { allowPrompt: false });
        const next = {
          localCpaJsonRootDirName: rootHandle.name || latest?.localCpaJsonRootDirName || '',
          localCpaJsonRootDirStatus: 'granted',
        };
        renderStateSnapshot(next);
        return {
          rootDirHandle: rootHandle,
          rootDirName: next.localCpaJsonRootDirName,
          rootDirStatus: 'granted',
        };
      } catch {
        const next = {
          localCpaJsonRootDirName: rootHandle.name || latest?.localCpaJsonRootDirName || '',
          localCpaJsonRootDirStatus: 'denied',
        };
        renderStateSnapshot(next);
        return {
          rootDirHandle: rootHandle,
          rootDirName: next.localCpaJsonRootDirName,
          rootDirStatus: 'denied',
        };
      }
    }

    async function chooseRootDirectory() {
      if (typeof showDirectoryPicker !== 'function') {
        throw new Error('当前环境不支持目录选择。');
      }
      const handle = await showDirectoryPicker();
      rememberRootHandle(handle);
      await localCpaJsonFs.saveRootDirectoryHandle(handle);
      await localCpaJsonFs.ensureWritableDirectoryHandle(handle, { allowPrompt: true });
      const patch = {
        localCpaJsonRootDirName: handle.name || '',
        localCpaJsonRootDirStatus: 'granted',
      };
      await updateStoredStatePatch(patch);
      showToast('本地 CPA 根目录已授权。', 'success', 1800);
      return handle;
    }

    async function checkRootDirectoryPermission() {
      const rootHandle = rememberRootHandle(
        cachedRootHandle || await localCpaJsonFs?.loadRootDirectoryHandle?.()
      );
      if (!rootHandle) {
        const patch = {
          localCpaJsonRootDirName: '',
          localCpaJsonRootDirStatus: 'missing',
        };
        await updateStoredStatePatch(patch);
        throw new Error('尚未选择本地 CPA 根目录，请先在侧边栏完成授权。');
      }

      let current;
      try {
        await localCpaJsonFs.ensureWritableDirectoryHandle(rootHandle, {
          allowPrompt: true,
          preferPrompt: true,
        });
        current = {
          rootDirHandle: rootHandle,
          rootDirName: rootHandle.name || '',
          rootDirStatus: 'granted',
        };
      } catch {
        current = {
          rootDirHandle: rootHandle,
          rootDirName: rootHandle.name || '',
          rootDirStatus: 'denied',
        };
      }

      const patch = {
        localCpaJsonRootDirName: current.rootDirName,
        localCpaJsonRootDirStatus: current.rootDirStatus,
      };
      await updateStoredStatePatch(patch);
      if (current.rootDirStatus === 'granted') {
        showToast('本地 CPA 根目录权限正常。', 'success', 1800);
        return current;
      }
      throw new Error('本地 CPA 根目录权限已失效，请重新选择或重新授权后重试。');
    }

    async function handleRuntimeMessage(message = {}) {
      if (message?.type !== 'LOCAL_CPA_JSON_WRITE_FILE') {
        return null;
      }
      const rootHandle = rememberRootHandle(
        cachedRootHandle || await localCpaJsonFs?.loadRootDirectoryHandle?.()
      );
      if (!rootHandle) {
        throw new Error('尚未选择本地 CPA 根目录，请先在侧边栏完成授权。');
      }

      const writeResult = await localCpaJsonFs.writeAuthJson({
        rootHandle,
        fileName: message?.payload?.fileName,
        jsonText: message?.payload?.jsonText,
      });

      const rootDirName = normalizeString(rootHandle.name);
      await updateStoredStatePatch({
        localCpaJsonRootDirName: rootDirName,
        localCpaJsonRootDirStatus: 'granted',
      });

      return {
        ok: true,
        filePathLabel: writeResult.filePathLabel,
        rootDirName,
      };
    }

    function bindEvents() {
      btnChooseLocalCpaJsonRootDir?.addEventListener('click', () => (
        chooseRootDirectory().catch((error) => {
          showToast(error?.message || '选择本地 CPA 根目录失败。', 'error');
        })
      ));
      btnCheckLocalCpaJsonRootDir?.addEventListener('click', () => (
        checkRootDirectoryPermission().catch((error) => {
          showToast(error?.message || '检测本地 CPA 根目录权限失败。', 'error');
        })
      ));
    }

    return {
      bindEvents,
      checkRootDirectoryPermission,
      chooseRootDirectory,
      getCachedRootDirectoryHandle: () => cachedRootHandle,
      handleRuntimeMessage,
      refreshAuthorizationState,
      renderStateSnapshot,
    };
  }

  return {
    createLocalCpaJsonBrowserWriteManager,
  };
});
