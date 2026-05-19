const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/contribution-content-update-service.js', 'utf8');

function createContributionContentService(options = {}) {
  const cache = new Map();
  const windowObject = {};
  let fetchCalls = 0;

  const localStorage = {
    getItem(key) {
      return cache.has(key) ? cache.get(key) : null;
    },
    setItem(key, value) {
      cache.set(key, String(value));
    },
    removeItem(key) {
      cache.delete(key);
    },
  };

  if (options.cachedSnapshot) {
    cache.set(
      'multipage-contribution-content-summary-v1',
      JSON.stringify(options.cachedSnapshot)
    );
  }

  const fetchImpl = options.fetchImpl || (async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        items: [],
        prompt_version: '',
        has_visible_updates: false,
        latest_updated_at: '',
        latest_updated_at_display: '',
      };
    },
  }));

  const wrappedFetch = async (...args) => {
    fetchCalls += 1;
    return fetchImpl(...args);
  };

  const api = new Function(
    'window',
    'localStorage',
    'fetch',
    'AbortController',
    'setTimeout',
    'clearTimeout',
    `${source}; return window.SidepanelContributionContentService;`
  )(
    windowObject,
    localStorage,
    wrappedFetch,
    AbortController,
    setTimeout,
    clearTimeout
  );

  return {
    api,
    getFetchCalls() {
      return fetchCalls;
    },
  };
}

test('getContentUpdateSnapshot stays idle when external contribution content is disabled', async () => {
  const { api } = createContributionContentService({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          prompt_version: 'auto_run_notice:2026-04-21T12:05:00Z',
          has_visible_updates: true,
          latest_updated_at: '2026-04-21T12:05:00Z',
          latest_updated_at_display: '2026-04-21 20:05',
          items: [
            {
              slug: 'auto_run_notice',
              title: '自动提示',
              text: '使用说明有更新了，可点上方“使用说明”查看。',
              is_enabled: true,
              has_content: true,
              is_visible: true,
              updated_at: '2026-04-21T12:05:00Z',
              updated_at_display: '2026-04-21 20:05',
            },
          ],
        };
      },
    }),
  });

  const snapshot = await api.getContentUpdateSnapshot();

  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.promptVersion, '');
  assert.equal(snapshot.hasVisibleUpdates, false);
  assert.equal(snapshot.latestUpdatedAt, '');
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.portalUrl, '');
  assert.equal(snapshot.apiUrl, '');
});

test('getContentUpdateSnapshot does not hit the network when contribution content is disabled', async () => {
  const cachedSnapshot = {
    status: 'update-available',
    promptVersion: 'announcement:2026-04-20T00:00:00Z',
    hasVisibleUpdates: true,
    latestUpdatedAt: '2026-04-20T00:00:00Z',
    latestUpdatedAtDisplay: '2026-04-20 08:00',
    items: [
      {
        slug: 'announcement',
        title: '站点公告',
        isEnabled: true,
        hasContent: true,
        isVisible: true,
        updatedAt: '2026-04-20T00:00:00Z',
        updatedAtDisplay: '2026-04-20 08:00',
      },
    ],
    portalUrl: '',
    apiUrl: '',
    checkedAt: Date.now() - 1000,
  };

  const { api, getFetchCalls } = createContributionContentService({
    cachedSnapshot,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });

  const snapshot = await api.getContentUpdateSnapshot();

  assert.equal(getFetchCalls(), 0);
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.promptVersion, '');
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.portalUrl, '');
  assert.equal(snapshot.apiUrl, '');
});
