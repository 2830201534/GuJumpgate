(function attachBackgroundPayPalCheckoutFlow(root, factory) {
  root.MultiPageBackgroundPayPalCheckoutFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPayPalCheckoutFlowModule() {
  const PAYPAL_SOURCE = 'paypal-flow';
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PLUS_CHECKOUT_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/plus-checkout.js'];
  const PAYPAL_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/paypal-flow.js'];
  const HOSTED_CHECKOUT_ADDRESS_ENDPOINT = 'https://www.meiguodizhi.com/api/v1/dz';
  const HOSTED_CHECKOUT_TRANSITION_TIMEOUT_MS = 120000;
  const HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_MIN_SECONDS = 0;
  const HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_MAX_SECONDS = 60;
  const HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_DEFAULT_SECONDS = 20;
  const HOSTED_CHECKOUT_SMS_POOL_SEPARATOR = '----';
  const HOSTED_CHECKOUT_SAMPLE_PHONE = '1234567890';
  const HOSTED_CHECKOUT_SAMPLE_VERIFICATION_URL = 'https://mail.test.com/api/text-relay/eca_tr_xxxxxxxxx';
  const PAYPAL_SUCCESS_URL_PATTERN = /^https:\/\/(?:chatgpt\.com|www\.chatgpt\.com|chat\.openai\.com)\/(?:backend-api\/)?payments\/success(?:[/?#]|$)/i;
  const PAYPAL_LOGIN_TRANSITION_TIMEOUT_MS = 30000;
  const PAYPAL_LOGIN_TRANSITION_POLL_MS = 500;
  const PAYPAL_HOSTED_STAGE_TRANSITION_TIMEOUT_MS = 30000;
  const PAYPAL_HOSTED_STAGE_TRANSITION_POLL_MS = 500;

  function createPayPalCheckoutFlowExecutor(deps = {}) {
    const {
      addLog: rawAddLog = async () => {},
      chrome,
      completeNodeFromBackground,
      ensureContentScriptReadyOnTabUntilStopped = async () => {},
      failNodeFromBackground = async () => {},
      fetch: fetchImpl = null,
      getTabId = async () => 0,
      getState = async () => ({}),
      isTabAlive = async () => false,
      queryTabsInAutomationWindow = null,
      sendTabMessageUntilStopped = async () => ({}),
      setState = async () => {},
      sleepWithStop = async () => {},
      waitForTabCompleteUntilStopped = async () => {},
      waitForTabUrlMatchUntilStopped = null,
    } = deps;

    function addLog(message, level = 'info', options = {}) {
      return rawAddLog(message, level, {
        step: 7,
        stepKey: 'paypal-checkout-flow',
        ...(options && typeof options === 'object' ? options : {}),
      });
    }

    function isPayPalUrl(url = '') {
      return /paypal\./i.test(String(url || ''));
    }

    function isHostedOpenAiCheckoutUrl(url = '') {
      return /^https:\/\/(?:pay\.openai\.com|checkout\.stripe\.com)\//i.test(String(url || ''));
    }

    function isPaymentsSuccessUrl(url = '') {
      return PAYPAL_SUCCESS_URL_PATTERN.test(String(url || ''));
    }

    function isOpenAiReturnUrl(url = '') {
      return /https:\/\/(?:chatgpt\.com|www\.chatgpt\.com|chat\.openai\.com|openai\.com)\//i.test(String(url || ''))
        && !/paypal\.|gopay|gojek|midtrans|xendit|stripe/i.test(String(url || ''));
    }

    function isHostedEntrySource(state = {}) {
      const entrySource = String(state?.paypalCheckoutEntrySource || '').trim();
      return entrySource === 'hosted-checkout'
        || Boolean(state?.paypalCheckoutGuestProfile && typeof state.paypalCheckoutGuestProfile === 'object');
    }

    function isHostedPayPalMeaningfulStage(stage = '') {
      const normalizedStage = String(stage || '').trim();
      return Boolean(normalizedStage)
        && normalizedStage !== 'outside_paypal'
        && normalizedStage !== 'unknown';
    }

    function normalizeHostedCheckoutVerificationPopupDelaySeconds(
      value,
      fallback = HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_DEFAULT_SECONDS
    ) {
      const rawValue = String(value ?? '').trim();
      const fallbackValue = Math.min(
        HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_MAX_SECONDS,
        Math.max(
          HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_MIN_SECONDS,
          Math.floor(Number(fallback) || HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_DEFAULT_SECONDS)
        )
      );
      if (!rawValue) {
        return fallbackValue;
      }
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric)) {
        return fallbackValue;
      }
      return Math.min(
        HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_MAX_SECONDS,
        Math.max(HOSTED_CHECKOUT_VERIFICATION_POPUP_DELAY_MIN_SECONDS, Math.floor(numeric))
      );
    }

    function normalizeHostedCheckoutPoolText(value = '') {
      return String(value || '').replace(/\r/g, '').trim();
    }

    function normalizeHostedCheckoutPoolPhone(phone = '') {
      return String(phone || '').replace(/\D/g, '');
    }

    function normalizeHostedCheckoutPoolUrl(value = '') {
      const rawValue = String(value || '').trim();
      if (!rawValue) {
        return '';
      }
      try {
        const parsed = new URL(rawValue);
        parsed.searchParams.delete('t');
        return parsed.toString();
      } catch {
        return rawValue
          .replace(/([?&])t=\d+(?=(&|$))/i, '$1')
          .replace(/[?&]$/g, '');
      }
    }

    function buildHostedCheckoutPoolKey(phone = '', verificationUrl = '') {
      const normalizedPhone = normalizeHostedCheckoutPoolPhone(phone);
      const normalizedUrl = normalizeHostedCheckoutPoolUrl(verificationUrl);
      return normalizedPhone && normalizedUrl
        ? `${normalizedPhone}${HOSTED_CHECKOUT_SMS_POOL_SEPARATOR}${normalizedUrl}`
        : '';
    }

    function isHostedCheckoutSampleEntry(phone = '', verificationUrl = '') {
      return normalizeHostedCheckoutPoolPhone(phone) === HOSTED_CHECKOUT_SAMPLE_PHONE
        && normalizeHostedCheckoutPoolUrl(verificationUrl) === HOSTED_CHECKOUT_SAMPLE_VERIFICATION_URL;
    }

    function parseHostedCheckoutSmsPoolEntries(text = '') {
      const lines = normalizeHostedCheckoutPoolText(text).split('\n').filter(Boolean);
      const seen = new Set();
      const entries = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const separatorIndex = line.indexOf(HOSTED_CHECKOUT_SMS_POOL_SEPARATOR);
        const hasSeparator = separatorIndex > 0;
        const phone = hasSeparator
          ? normalizeHostedCheckoutPoolPhone(line.slice(0, separatorIndex))
          : normalizeHostedCheckoutPoolPhone(line);
        const verificationUrl = hasSeparator
          ? normalizeHostedCheckoutPoolUrl(line.slice(separatorIndex + HOSTED_CHECKOUT_SMS_POOL_SEPARATOR.length))
          : normalizeHostedCheckoutPoolUrl(lines[index + 1] || '');
        if (!hasSeparator && verificationUrl) {
          index += 1;
        }
        const key = buildHostedCheckoutPoolKey(phone, verificationUrl);
        if (!phone || !verificationUrl || !key || seen.has(key) || isHostedCheckoutSampleEntry(phone, verificationUrl)) {
          continue;
        }
        seen.add(key);
        entries.push({ index: entries.length, key, phone, verificationUrl });
      }
      return entries;
    }

    function normalizeHostedCheckoutSmsPoolUsage(value = {}) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const usage = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
        const legacyUsedCount = Number(usage.usedAt) > 0 ? 1 : 0;
        const useCount = Math.max(0, Math.floor(Number(usage.useCount ?? usage.usageCount ?? legacyUsedCount) || 0));
        return [String(key || '').trim(), {
          useCount,
          usedAt: Math.max(0, Number(usage.usedAt) || 0),
          lastAttemptAt: Math.max(0, Number(usage.lastAttemptAt) || 0),
          lastError: String(usage.lastError || '').trim(),
        }];
      }).filter(([key]) => Boolean(key)));
    }

    function normalizeHostedCheckoutCurrentSmsEntry(entry = null, entries = []) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const key = String(entry.key || buildHostedCheckoutPoolKey(entry.phone, entry.verificationUrl)).trim();
      if (!key) {
        return null;
      }
      const matchedEntry = Array.isArray(entries) ? entries.find((candidate) => candidate.key === key) : null;
      if (matchedEntry) {
        return { ...matchedEntry };
      }
      const phone = normalizeHostedCheckoutPoolPhone(entry.phone);
      const verificationUrl = normalizeHostedCheckoutPoolUrl(entry.verificationUrl);
      if (!phone || !verificationUrl) {
        return null;
      }
      return { key, phone, verificationUrl };
    }

    function chooseHostedCheckoutSmsPoolEntry(entries = [], usage = {}) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return null;
      }
      const normalizedUsage = normalizeHostedCheckoutSmsPoolUsage(usage);
      return entries
        .map((entry, index) => {
          const itemUsage = normalizedUsage[entry.key] || {};
          return {
            ...entry,
            index: Number.isFinite(entry.index) ? entry.index : index,
            useCount: Math.max(0, Math.floor(Number(itemUsage.useCount) || 0)),
            usedAt: Math.max(0, Number(itemUsage.usedAt) || 0),
          };
        })
        .sort((left, right) => {
          if (left.useCount !== right.useCount) return left.useCount - right.useCount;
          if (left.usedAt !== right.usedAt) return left.usedAt - right.usedAt;
          return left.index - right.index;
        })[0] || null;
    }

    async function applyHostedCheckoutRuntimePatch(patch = {}) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
        return;
      }
      await setState(patch);
    }

    async function updateHostedCheckoutPoolUsage(entry = null, options = {}) {
      const normalizedEntry = normalizeHostedCheckoutCurrentSmsEntry(entry);
      if (!normalizedEntry?.key || typeof getState !== 'function') {
        return null;
      }
      const state = await getState().catch(() => ({}));
      const usage = normalizeHostedCheckoutSmsPoolUsage(state?.hostedCheckoutSmsPoolUsage || {});
      const previous = usage[normalizedEntry.key] || {};
      const now = Date.now();
      const incrementUseCount = Boolean(options.incrementUseCount);
      const success = options.success === true;
      const nextUsage = {
        ...usage,
        [normalizedEntry.key]: {
          useCount: incrementUseCount
            ? Math.max(0, Math.floor(Number(previous.useCount) || 0)) + 1
            : Math.max(0, Math.floor(Number(previous.useCount) || 0)),
          usedAt: incrementUseCount ? now : Math.max(0, Number(previous.usedAt) || 0),
          lastAttemptAt: now,
          lastError: success ? '' : String(options.error || '').trim(),
        },
      };
      await applyHostedCheckoutRuntimePatch({
        hostedCheckoutCurrentSmsEntry: normalizedEntry,
        hostedCheckoutSmsPoolUsage: nextUsage,
      });
      return nextUsage;
    }

    async function getHostedCheckoutRuntimeConfig(options = {}) {
      const { ensureCurrentSmsEntry = false } = options || {};
      const state = typeof getState === 'function' ? await getState().catch(() => ({})) : {};
      let stored = {};
      if (chrome?.storage?.local?.get) {
        stored = await chrome.storage.local.get([
          'hostedCheckoutVerificationUrl',
          'hostedCheckoutVerificationPopupDelaySeconds',
          'hostedCheckoutPhoneNumber',
          'hostedCheckoutSmsPoolText',
          'hostedCheckoutSmsPoolUsage',
        ]).catch(() => ({}));
      }
      const poolEntries = parseHostedCheckoutSmsPoolEntries(stored?.hostedCheckoutSmsPoolText || state?.hostedCheckoutSmsPoolText || '');
      const poolUsage = normalizeHostedCheckoutSmsPoolUsage(stored?.hostedCheckoutSmsPoolUsage || state?.hostedCheckoutSmsPoolUsage || {});
      let selectedSmsEntry = normalizeHostedCheckoutCurrentSmsEntry(state?.hostedCheckoutCurrentSmsEntry, poolEntries);
      if (!selectedSmsEntry && ensureCurrentSmsEntry && poolEntries.length > 0) {
        selectedSmsEntry = chooseHostedCheckoutSmsPoolEntry(poolEntries, poolUsage);
        if (selectedSmsEntry) {
          const nextUsage = await updateHostedCheckoutPoolUsage(selectedSmsEntry, {
            incrementUseCount: true,
            success: true,
          });
          await addLog(
            `步骤 7：Hosted 接码池已选择号码 ${selectedSmsEntry.phone}（最少使用次数优先，当前累计 ${Math.max(0, Number(nextUsage?.[selectedSmsEntry.key]?.useCount) || 0)} 次）。`,
            'info'
          );
        }
      }
      const verificationUrl = String(
        selectedSmsEntry?.verificationUrl
        || (poolEntries.length > 0 && !selectedSmsEntry ? chooseHostedCheckoutSmsPoolEntry(poolEntries, poolUsage)?.verificationUrl : '')
        || ''
      ).trim() || String(stored?.hostedCheckoutVerificationUrl || state?.hostedCheckoutVerificationUrl || '').trim();
      const phone = String(
        selectedSmsEntry?.phone
        || (poolEntries.length > 0 && !selectedSmsEntry ? chooseHostedCheckoutSmsPoolEntry(poolEntries, poolUsage)?.phone : '')
        || ''
      ).trim() || String(stored?.hostedCheckoutPhoneNumber || state?.hostedCheckoutPhoneNumber || '').trim();
      const verificationPopupDelaySeconds = normalizeHostedCheckoutVerificationPopupDelaySeconds(
        stored?.hostedCheckoutVerificationPopupDelaySeconds ?? state?.hostedCheckoutVerificationPopupDelaySeconds
      );
      return {
        verificationUrl,
        verificationPopupDelaySeconds,
        phone,
        hostedCheckoutCurrentSmsEntry: selectedSmsEntry,
        hostedCheckoutUsesSmsPool: Boolean(selectedSmsEntry),
      };
    }

    async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 30000) {
      const fetcher = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      if (typeof fetcher !== 'function') {
        throw new Error('步骤 7：当前运行环境不支持 fetch。');
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetcher(url, {
          ...options,
          ...(controller ? { signal: controller.signal } : {}),
        });
        const text = await response.text().catch(() => '');
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = {};
        }
        return { response, data };
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }

    function buildHostedCheckoutRandomEmail() {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let localPart = '';
      for (let index = 0; index < 16; index += 1) {
        localPart += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      return `${localPart}@gmail.com`;
    }

    function buildHostedCheckoutRandomPassword() {
      const lowercase = 'abcdefghijklmnopqrstuvwxyz';
      const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const digits = '0123456789';
      const symbols = '!@#$%^';
      const alphabet = `${lowercase}${uppercase}${digits}${symbols}`;
      const values = [
        lowercase[Math.floor(Math.random() * lowercase.length)],
        uppercase[Math.floor(Math.random() * uppercase.length)],
        digits[Math.floor(Math.random() * digits.length)],
        symbols[Math.floor(Math.random() * symbols.length)],
      ];
      while (values.length < 14) {
        values.push(alphabet[Math.floor(Math.random() * alphabet.length)]);
      }
      return values.sort(() => Math.random() - 0.5).join('');
    }

    function buildHostedCheckoutVisaCard() {
      const prefixes = [[4, 1, 4, 7], [4, 1, 0, 0]];
      const digits = prefixes[Math.floor(Math.random() * prefixes.length)].slice();
      while (digits.length < 15) {
        digits.push(Math.floor(Math.random() * 10));
      }
      const reversed = digits.slice().reverse();
      let sum = 0;
      for (let index = 0; index < reversed.length; index += 1) {
        let digit = reversed[index];
        if (index % 2 === 0) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }
        sum += digit;
      }
      digits.push((10 - (sum % 10)) % 10);
      const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
      const currentYear = new Date().getFullYear() % 100;
      const year = currentYear + Math.floor(Math.random() * 4) + 2;
      const cvv = String(Math.floor(100 + Math.random() * 900));
      return { number: digits.join(''), expiry: `${month} / ${year}`, cvv };
    }

    async function fetchHostedCheckoutAddress() {
      const { response, data } = await fetchJsonWithTimeout(HOSTED_CHECKOUT_ADDRESS_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: '/', method: 'address' }),
      }, 30000);
      if (!response?.ok) {
        throw new Error(`步骤 7：获取 hosted checkout 地址失败（HTTP ${response?.status || 0}）。`);
      }
      const address = data?.address || data || {};
      return {
        street: String(address.Address || address.street || '123 Main St').trim(),
        city: String(address.City || address.city || 'New York').trim(),
        state: String(address.State_Full || address.State || address.state || 'New York').trim(),
        zip: String(address.Zip_Code || address.zip || '10001').trim().slice(0, 5) || '10001',
      };
    }

    function buildHostedCheckoutGuestProfile(address = {}, config = {}) {
      const card = buildHostedCheckoutVisaCard();
      return {
        email: buildHostedCheckoutRandomEmail(),
        password: buildHostedCheckoutRandomPassword(),
        phone: String(config?.phone || '').trim(),
        firstName: 'James',
        lastName: 'Smith',
        fullName: 'James Smith',
        cardNumber: card.number,
        cardExpiry: card.expiry,
        cardCvv: card.cvv,
        address,
      };
    }

    async function ensureHostedCheckoutContext(state = {}, options = {}) {
      const requireGuestProfile = options?.requireGuestProfile === true;
      const latestState = typeof getState === 'function' ? await getState().catch(() => ({})) : {};
      const mergedState = {
        ...(state || {}),
        ...(latestState && typeof latestState === 'object' ? latestState : {}),
      };
      const existingGuestProfile = mergedState?.paypalCheckoutGuestProfile && typeof mergedState.paypalCheckoutGuestProfile === 'object'
        ? mergedState.paypalCheckoutGuestProfile
        : null;
      const needsGuestProfile = requireGuestProfile && (
        !existingGuestProfile?.address?.street
        || !existingGuestProfile?.cardNumber
        || !existingGuestProfile?.phone
      );
      const needsRuntimeConfig = !String(mergedState?.hostedCheckoutVerificationUrl || '').trim()
        || !Number.isFinite(Number(mergedState?.hostedCheckoutVerificationPopupDelaySeconds))
        || !normalizeHostedCheckoutCurrentSmsEntry(mergedState?.hostedCheckoutCurrentSmsEntry);
      if (!needsGuestProfile && !needsRuntimeConfig) {
        return mergedState;
      }
      const runtimeConfig = await getHostedCheckoutRuntimeConfig({ ensureCurrentSmsEntry: true });
      const address = needsGuestProfile
        ? await fetchHostedCheckoutAddress()
        : (existingGuestProfile?.address || {});
      const guestProfile = needsGuestProfile
        ? buildHostedCheckoutGuestProfile(address, runtimeConfig)
        : {
          ...existingGuestProfile,
          phone: String(existingGuestProfile?.phone || runtimeConfig?.phone || '').trim(),
        };
      await applyHostedCheckoutRuntimePatch({
        paypalCheckoutGuestProfile: guestProfile,
        hostedCheckoutCurrentSmsEntry: runtimeConfig?.hostedCheckoutCurrentSmsEntry || null,
        hostedCheckoutPhoneNumber: String(runtimeConfig?.phone || '').trim(),
        hostedCheckoutVerificationUrl: String(runtimeConfig?.verificationUrl || '').trim(),
        hostedCheckoutVerificationPopupDelaySeconds: Number(runtimeConfig?.verificationPopupDelaySeconds) || 0,
      });
      return {
        ...mergedState,
        paypalCheckoutGuestProfile: guestProfile,
        hostedCheckoutCurrentSmsEntry: runtimeConfig?.hostedCheckoutCurrentSmsEntry || null,
        hostedCheckoutPhoneNumber: String(runtimeConfig?.phone || '').trim(),
        hostedCheckoutVerificationUrl: String(runtimeConfig?.verificationUrl || '').trim(),
        hostedCheckoutVerificationPopupDelaySeconds: Number(runtimeConfig?.verificationPopupDelaySeconds) || 0,
      };
    }

    function extractHostedCheckoutVerificationCode(payload) {
      const candidates = [];
      if (typeof payload === 'string') {
        candidates.push(payload);
      } else if (typeof payload === 'number') {
        candidates.push(String(payload));
      } else if (payload && typeof payload === 'object') {
        candidates.push(
          payload.code,
          payload.verificationCode,
          payload.otp,
          payload.data?.code,
          payload.data?.verificationCode,
          payload.data?.otp,
          payload.message,
          payload.data?.message
        );
      }
      for (const candidate of candidates) {
        const digits = String(candidate || '').replace(/\D+/g, '');
        if (digits.length >= 6) {
          return digits.slice(0, 6);
        }
      }
      return '';
    }

    function resolveHostedVerificationUrl(state = {}) {
      const currentEntry = state?.hostedCheckoutCurrentSmsEntry;
      const currentEntryUrl = currentEntry && typeof currentEntry === 'object'
        ? String(currentEntry.verificationUrl || '').trim()
        : '';
      return currentEntryUrl || String(state?.hostedCheckoutVerificationUrl || '').trim();
    }

    async function fetchHostedVerificationCode(state = {}) {
      const verificationUrl = resolveHostedVerificationUrl(state);
      if (!verificationUrl) {
        throw new Error('步骤 7：缺少 hosted checkout 验证码地址，无法继续自动填写。');
      }
      const fetcher = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      if (typeof fetcher !== 'function') {
        throw new Error('步骤 7：当前运行环境不支持 fetch，无法获取 hosted checkout 验证码。');
      }
      const separator = verificationUrl.includes('?') ? '&' : '?';
      const response = await fetcher(`${verificationUrl}${separator}t=${Date.now()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json,text/plain,*/*',
        },
      });
      const text = await response.text().catch(() => '');
      let payload = text;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = text;
      }
      const code = extractHostedCheckoutVerificationCode(payload);
      if (!code) {
        throw new Error('hosted checkout 验证码接口暂未返回有效验证码。');
      }
      return code;
    }

    async function pollHostedVerificationCode(state = {}) {
      let lastError = null;
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        try {
          const code = await fetchHostedVerificationCode(state);
          await addLog(`步骤 7：已获取 hosted checkout 验证码（${attempt}/12）。`, 'info');
          return code;
        } catch (error) {
          lastError = error;
          await addLog(`步骤 7：hosted checkout 验证码暂不可用（${attempt}/12）：${error?.message || error}`, 'warn');
          if (attempt < 12) {
            await sleepWithStop(5000);
          }
        }
      }
      throw lastError || new Error('步骤 7：hosted checkout 验证码轮询失败。');
    }

    async function fetchFreshHostedVerificationCode(state = {}, previousCode = '') {
      const normalizedPreviousCode = extractHostedCheckoutVerificationCode(previousCode);
      await sleepWithStop(3000);
      const firstCode = await fetchHostedVerificationCode(state).catch(() => '');
      if (firstCode && (!normalizedPreviousCode || firstCode !== normalizedPreviousCode)) {
        return firstCode;
      }
      await addLog('步骤 7：重发后的验证码为空或与上次一致，3 秒后再尝试一次...', 'warn');
      await sleepWithStop(3000);
      const secondCode = await fetchHostedVerificationCode(state).catch(() => '');
      if (secondCode && (!normalizedPreviousCode || secondCode !== normalizedPreviousCode)) {
        return secondCode;
      }
      throw new Error('步骤 7：重发后获取到的验证码为空或与上次一致，请手动输入验证码后再继续。');
    }

    async function resendHostedVerificationCode(tabId) {
      const result = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP',
        source: 'background',
        payload: {
          stage: 'verification',
          action: 'resend',
        },
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    function getVerificationPopupDelaySeconds(state = {}) {
      const raw = Number(state?.hostedCheckoutVerificationPopupDelaySeconds);
      if (!Number.isFinite(raw) || raw <= 0) {
        return 0;
      }
      return Math.max(0, Math.floor(raw));
    }

    async function ensurePayPalReady(tabId, logMessage = '') {
      if (typeof waitForTabUrlMatchUntilStopped === 'function') {
        await waitForTabUrlMatchUntilStopped(tabId, (url) => isPayPalUrl(url) || isPaymentsSuccessUrl(url));
      }
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PAYPAL_SOURCE, tabId, {
        inject: PAYPAL_INJECT_FILES,
        injectSource: PAYPAL_SOURCE,
        logMessage: logMessage || '步骤 7：PayPal 页面仍在加载，等待脚本就绪...',
      });
    }

    async function ensureHostedCheckoutReady(tabId, logMessage = '') {
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: logMessage || '步骤 7：hosted checkout 页面仍在加载，等待脚本就绪...',
      });
    }

    async function readHostedCheckoutState(tabId) {
      const result = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
        type: 'PLUS_CHECKOUT_GET_STATE',
        source: 'background',
        payload: {},
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function readGeneralPayPalState(tabId) {
      const result = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_GET_STATE',
        source: 'background',
        payload: {},
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function readHostedPayPalState(tabId) {
      const result = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_HOSTED_GET_STATE',
        source: 'background',
        payload: {},
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function waitForHostedPayPalState(tabId, options = {}) {
      const timeoutMs = Math.max(1000, Number(options.timeoutMs) || PAYPAL_HOSTED_STAGE_TRANSITION_TIMEOUT_MS);
      const pollMs = Math.max(100, Number(options.pollMs) || PAYPAL_HOSTED_STAGE_TRANSITION_POLL_MS);
      const acceptStage = typeof options.acceptStage === 'function'
        ? options.acceptStage
        : (stage) => isHostedPayPalMeaningfulStage(stage);
      const startedAt = Date.now();
      let lastState = null;
      let lastStage = '';
      while (Date.now() - startedAt < timeoutMs) {
        const tab = await chrome?.tabs?.get?.(tabId).catch(() => null);
        if (!tab) {
          throw new Error('步骤 7：PayPal 标签页已关闭，无法继续识别 hosted 页面阶段。');
        }
        const currentUrl = String(tab.url || '').trim();
        if (currentUrl && !isPayPalUrl(currentUrl)) {
          return {
            hostedStage: 'outside_paypal',
            currentUrl,
          };
        }
        await ensurePayPalReady(tabId, options.logMessage || '步骤 7：正在等待 PayPal hosted 页面阶段稳定...');
        const state = await readHostedPayPalState(tabId);
        const stage = String(state?.hostedStage || state?.stage || '').trim();
        lastState = state || {};
        lastStage = stage;
        if (acceptStage(stage, state, currentUrl)) {
          return {
            ...lastState,
            currentUrl: String(lastState?.currentUrl || currentUrl || '').trim(),
          };
        }
        await sleepWithStop(pollMs);
      }
      return {
        ...(lastState || {}),
        hostedStage: lastStage || String(lastState?.hostedStage || lastState?.stage || '').trim(),
      };
    }

    async function resolvePayPalTabId(state = {}) {
      const isHostedEntry = isHostedEntrySource(state);
      const hostedCheckoutTabId = Number(state?.plusCheckoutTabId) || 0;
      if (isHostedEntry && hostedCheckoutTabId) {
        return hostedCheckoutTabId;
      }
      const storedTabId = Number(state?.paypalCheckoutTabId) || 0;
      if (storedTabId) {
        return storedTabId;
      }
      const paypalTabId = await getTabId(PAYPAL_SOURCE);
      if (paypalTabId && await isTabAlive(PAYPAL_SOURCE)) {
        return paypalTabId;
      }
      const discoveredPayPalTabId = await findOpenPayPalTabId();
      if (discoveredPayPalTabId) {
        await addLog('步骤 7：已从当前浏览器标签中发现 PayPal 页面，正在接管继续执行。', 'info');
        return discoveredPayPalTabId;
      }
      const checkoutTabId = await getTabId(PLUS_CHECKOUT_SOURCE);
      if (checkoutTabId) {
        return checkoutTabId;
      }
      if (hostedCheckoutTabId) {
        return hostedCheckoutTabId;
      }
      throw new Error('步骤 7：未找到 PayPal 标签页，请先完成上一步。');
    }

    async function findOpenPayPalTabId() {
      if (!chrome?.tabs?.query) {
        return 0;
      }
      const queryTabs = typeof queryTabsInAutomationWindow === 'function'
        ? queryTabsInAutomationWindow
        : (queryInfo) => chrome.tabs.query(queryInfo);
      const tabs = await queryTabs({}).catch(() => []);
      const candidates = (Array.isArray(tabs) ? tabs : [])
        .filter((tab) => Number.isInteger(tab?.id) && isPayPalUrl(tab.url || ''));
      if (!candidates.length) {
        return 0;
      }
      const match = candidates.find((tab) => tab.active && tab.currentWindow)
        || candidates.find((tab) => tab.active)
        || candidates[0];
      if (match?.id && chrome?.tabs?.update) {
        await chrome.tabs.update(match.id, { active: true }).catch(() => {});
      }
      return match?.id || 0;
    }

    async function dismissPrompts(tabId) {
      const result = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_DISMISS_PROMPTS',
        source: 'background',
        payload: {},
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    function resolvePayPalCredentials(state = {}) {
      const currentId = String(state?.currentPayPalAccountId || '').trim();
      const accounts = Array.isArray(state?.paypalAccounts) ? state.paypalAccounts : [];
      const selectedAccount = currentId
        ? accounts.find((account) => String(account?.id || '').trim() === currentId) || null
        : null;
      return {
        email: String(selectedAccount?.email || state?.paypalEmail || '').trim(),
        password: String(selectedAccount?.password || state?.paypalPassword || ''),
      };
    }

    async function submitLogin(tabId, state = {}) {
      const credentials = resolvePayPalCredentials(state);
      if (!credentials.password) {
        throw new Error('步骤 7：未配置可用的 PayPal 账号，请先在侧边栏添加并选择账号。');
      }
      await addLog('步骤 7：正在填写 PayPal 登录信息并提交...', 'info');
      const result = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_SUBMIT_LOGIN',
        source: 'background',
        payload: {
          email: credentials.email,
          password: credentials.password,
        },
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    function isPayPalPasswordState(pageState = {}) {
      return Boolean(pageState.hasPasswordInput)
        || pageState.loginPhase === 'password'
        || pageState.loginPhase === 'login_combined';
    }

    async function waitForPayPalPostLoginDecision(tabId, actionResult = {}) {
      const phase = String(actionResult?.phase || '').trim();
      const startedAt = Date.now();
      while (Date.now() - startedAt < PAYPAL_LOGIN_TRANSITION_TIMEOUT_MS) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          throw new Error('步骤 7：PayPal 标签页已关闭，无法继续识别登录后的页面。');
        }
        const currentUrl = tab.url || '';
        if (!currentUrl) {
          await sleepWithStop(PAYPAL_LOGIN_TRANSITION_POLL_MS);
          continue;
        }
        if (currentUrl && !isPayPalUrl(currentUrl)) {
          return {
            outcome: 'left_paypal',
            url: currentUrl,
          };
        }
        if (tab.status !== 'complete') {
          await sleepWithStop(PAYPAL_LOGIN_TRANSITION_POLL_MS);
          continue;
        }
        await ensurePayPalReady(
          tabId,
          phase === 'email_submitted'
            ? '步骤 7：PayPal 账号已提交，正在识别下一页...'
            : '步骤 7：PayPal 密码已提交，正在识别跳转结果...'
        );
        const pageState = await readGeneralPayPalState(tabId);
        if (pageState.hasPasskeyPrompt) {
          return { outcome: 'prompt', pageState };
        }
        if (pageState.approveReady) {
          return { outcome: 'approve_ready', pageState };
        }
        if (phase === 'email_submitted' && isPayPalPasswordState(pageState)) {
          return { outcome: 'password_ready', pageState };
        }
        if (phase === 'password_submitted' && !pageState.needsLogin) {
          return { outcome: 'post_login_state', pageState };
        }
        await sleepWithStop(PAYPAL_LOGIN_TRANSITION_POLL_MS);
      }
      return {
        outcome: 'timeout',
        phase,
      };
    }

    async function clickApprove(tabId) {
      const result = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_CLICK_APPROVE',
        source: 'background',
        payload: {},
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return Boolean(result?.clicked);
    }

    async function executeLegacyPayPalFlow(tabId, state = {}) {
      let loggedWaiting = false;
      while (true) {
        const currentUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
        if (currentUrl && isPaymentsSuccessUrl(currentUrl)) {
          break;
        }
        if (currentUrl && !isPayPalUrl(currentUrl)) {
          await addLog('步骤 7：PayPal 已跳转离开授权页，准备进入回跳确认。', 'ok');
          break;
        }
        await ensurePayPalReady(tabId, '步骤 7：PayPal 页面正在切换，等待脚本重新就绪...');
        const pageState = await readGeneralPayPalState(tabId);
        await setState({
          paypalCheckoutTabId: tabId,
          paypalCheckoutUrl: String(pageState?.url || currentUrl || '').trim(),
          paypalCheckoutStage: String(pageState?.hostedStage || '').trim() || (pageState?.approveReady ? 'approval' : ''),
          paypalCheckoutEntrySource: String(state?.paypalCheckoutEntrySource || 'plus-checkout-billing').trim(),
        });
        if (pageState.needsLogin) {
          const submitResult = await submitLogin(tabId, state);
          const decision = await waitForPayPalPostLoginDecision(tabId, submitResult);
          if (decision.outcome === 'left_paypal') {
            await addLog('步骤 7：PayPal 登录后已跳转离开登录/授权页，继续进入回跳确认。', 'ok');
            break;
          }
          loggedWaiting = false;
          continue;
        }
        if (pageState.hasPasskeyPrompt) {
          await addLog('步骤 7：检测到 PayPal 通行密钥提示，正在关闭...', 'info');
          await dismissPrompts(tabId);
          await sleepWithStop(1000);
          continue;
        }
        const dismissed = await dismissPrompts(tabId).catch(() => ({ clicked: 0 }));
        if (dismissed.clicked) {
          await sleepWithStop(1000);
          continue;
        }
        if (pageState.approveReady) {
          await addLog('步骤 7：正在点击 PayPal“同意并继续”...', 'info');
          const clicked = await clickApprove(tabId);
          if (clicked) {
            await setState({ plusPaypalApprovedAt: Date.now(), paypalCheckoutStage: 'approval' });
            await sleepWithStop(1000);
            continue;
          }
        }
        if (!loggedWaiting) {
          loggedWaiting = true;
          await addLog('步骤 7：等待 PayPal 授权按钮或下一步页面出现...', 'info');
        }
        await sleepWithStop(500);
      }
    }

    async function executeHostedPayPalFlow(tabId, state = {}) {
      let waitedForVerificationPopupDelay = false;
      while (true) {
        const currentTab = await chrome?.tabs?.get?.(tabId).catch(() => null);
        const currentUrl = String(currentTab?.url || '').trim();
        if (currentUrl && isPaymentsSuccessUrl(currentUrl)) {
          return;
        }
        if (currentUrl && !isPayPalUrl(currentUrl)) {
          if (isOpenAiReturnUrl(currentUrl)) {
            await addLog('步骤 7：hosted PayPal 已跳转离开授权页，准备进入回跳确认。', 'ok');
            return;
          }
          const message = '步骤 7：PayPal 支付链路已失效，准备回退到节点 plus-checkout-create 重新创建 Checkout。';
          await failNodeFromBackground('paypal-checkout-flow', message);
          throw new Error(message);
        }
        await ensurePayPalReady(tabId, '步骤 7：正在识别 PayPal 当前阶段...');
        const paypalState = await waitForHostedPayPalState(tabId, {
          timeoutMs: 10000,
          logMessage: '步骤 7：正在等待 PayPal hosted 页面完成阶段切换...',
        });
        const stage = String(paypalState?.hostedStage || paypalState?.stage || '').trim();
        const resolvedPayPalStateUrl = String(paypalState?.currentUrl || currentUrl || '').trim();
        await setState({
          paypalCheckoutTabId: tabId,
          paypalCheckoutUrl: resolvedPayPalStateUrl,
          paypalCheckoutStage: stage,
          paypalCheckoutEntrySource: String(state?.paypalCheckoutEntrySource || 'plus-checkout-create').trim(),
        });
        if (stage === 'outside_paypal' && isOpenAiReturnUrl(resolvedPayPalStateUrl)) {
          await addLog('步骤 7：hosted PayPal 已在阶段识别过程中回跳到 OpenAI，准备完成当前步骤。', 'ok');
          return;
        }
        if (!stage || stage === 'outside_paypal' || stage === 'unknown') {
          const message = '步骤 7：PayPal 支付链路已失效，准备回退到节点 plus-checkout-create 重新创建 Checkout。';
          await failNodeFromBackground('paypal-checkout-flow', message);
          throw new Error(message);
        }
        await addLog(`步骤 7：当前 PayPal hosted 阶段：${stage}。`, 'info');
        const mergedState = await ensureHostedCheckoutContext(state, {
          requireGuestProfile: stage === 'guest_checkout' || stage === 'pay_login',
        });
        let payload = {
          stage,
          ...(mergedState?.paypalCheckoutGuestProfile && typeof mergedState.paypalCheckoutGuestProfile === 'object'
            ? mergedState.paypalCheckoutGuestProfile
            : {}),
        };
        if (stage === 'verification') {
          if (!waitedForVerificationPopupDelay) {
            const delaySeconds = getVerificationPopupDelaySeconds(mergedState);
            if (delaySeconds > 0) {
              await addLog(`步骤 7：已检测到 hosted checkout 验证码弹窗，按设置等待 ${delaySeconds} 秒后再获取验证码。`, 'info');
              await sleepWithStop(delaySeconds * 1000);
            }
            waitedForVerificationPopupDelay = true;
          }
          await addLog('步骤 7：检测到 PayPal hosted checkout 验证码弹窗，正在获取并填写验证码...', 'info');
          let verificationCode = await pollHostedVerificationCode(mergedState);
          const previousStoredCode = extractHostedCheckoutVerificationCode(paypalState?.hostedVerificationStoredCode || '');
          if (previousStoredCode && verificationCode === previousStoredCode) {
            await addLog('步骤 7：新获取的验证码与浏览器记录的上次验证码一致，先点击 Resend 再重新拉取验证码。', 'warn');
            await resendHostedVerificationCode(tabId);
            verificationCode = await fetchFreshHostedVerificationCode(mergedState, previousStoredCode);
          }
          payload = {
            ...payload,
            verificationCode,
          };
        }
        const actionResult = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
          type: 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP',
          source: 'background',
          payload,
        });
        if (actionResult?.error) {
          throw new Error(actionResult.error);
        }
        if (stage === 'pay_login' && actionResult?.nextExpected === 'guest_checkout_or_verification') {
          const transitionedState = await waitForHostedPayPalState(tabId, {
            timeoutMs: PAYPAL_HOSTED_STAGE_TRANSITION_TIMEOUT_MS,
            logMessage: '步骤 7：PayPal 邮箱已提交，正在等待 guest checkout 页面加载...',
            acceptStage: (nextStage) => (
              nextStage === 'guest_checkout'
              || nextStage === 'verification'
              || nextStage === 'review_consent'
              || nextStage === 'approval'
            ),
          });
          const nextStage = String(transitionedState?.hostedStage || transitionedState?.stage || '').trim();
          if (!isHostedPayPalMeaningfulStage(nextStage) || nextStage === 'pay_login') {
            throw new Error('步骤 7：PayPal 邮箱提交后长时间未进入 guest checkout/验证码/确认页面。');
          }
          await addLog(`步骤 7：PayPal 邮箱已提交，已进入下一阶段：${nextStage}。`, 'info');
          await sleepWithStop(500);
          continue;
        }
        if (stage === 'guest_checkout' && (actionResult?.submitScheduled || actionResult?.submitted)) {
          const transitionedState = await waitForHostedPayPalState(tabId, {
            timeoutMs: PAYPAL_HOSTED_STAGE_TRANSITION_TIMEOUT_MS,
            logMessage: '步骤 7：PayPal 卡单已提交，正在等待验证码/确认页面出现...',
            acceptStage: (nextStage) => (
              nextStage === 'verification'
              || nextStage === 'review_consent'
              || nextStage === 'approval'
              || nextStage === 'outside_paypal'
            ),
          });
          const nextStage = String(transitionedState?.hostedStage || transitionedState?.stage || '').trim();
          if (!isHostedPayPalMeaningfulStage(nextStage) || nextStage === 'guest_checkout' || nextStage === 'pay_login') {
            throw new Error('步骤 7：PayPal 卡单提交后长时间未进入验证码/确认页面。');
          }
          await addLog(`步骤 7：PayPal 卡单已提交，已进入下一阶段：${nextStage}。`, 'info');
          await sleepWithStop(500);
          continue;
        }
        if (stage === 'verification' && actionResult?.verificationFailed) {
          const submittedCode = extractHostedCheckoutVerificationCode(payload.verificationCode || '');
          if (!actionResult?.resendAvailable) {
            throw new Error('步骤 7：验证码提交失败，且当前页面未找到 Resend 按钮，请手动输入验证码后再继续。');
          }
          await addLog('步骤 7：验证码提交后检测到 PayPal 错误提示，正在点击 Resend 并重新拉取验证码...', 'warn');
          await resendHostedVerificationCode(tabId);
          const retryCode = await fetchFreshHostedVerificationCode(mergedState, submittedCode);
          const retryResult = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
            type: 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP',
            source: 'background',
            payload: {
              ...payload,
              verificationCode: retryCode,
            },
          });
          if (retryResult?.error) {
            throw new Error(retryResult.error);
          }
          if (retryResult?.verificationFailed) {
            throw new Error('步骤 7：重发验证码后仍然失败，请手动输入验证码后再继续。');
          }
          const postRetryState = await waitForHostedPayPalState(tabId, {
            timeoutMs: PAYPAL_HOSTED_STAGE_TRANSITION_TIMEOUT_MS,
            logMessage: '步骤 7：验证码已重填，正在等待 PayPal 进入下一阶段...',
            acceptStage: (nextStage) => (
              nextStage === 'guest_checkout'
              || nextStage === 'review_consent'
              || nextStage === 'approval'
              || nextStage === 'outside_paypal'
            ),
          });
          const postRetryStage = String(postRetryState?.hostedStage || postRetryState?.stage || '').trim();
          if (postRetryStage === 'verification' || postRetryStage === 'pay_login' || !postRetryStage) {
            throw new Error('步骤 7：验证码重填后长时间未进入下一阶段，请手动输入验证码后再继续。');
          }
          await addLog(`步骤 7：验证码重填成功，已进入下一阶段：${postRetryStage}。`, 'info');
          waitedForVerificationPopupDelay = false;
          await sleepWithStop(500);
          continue;
        }
        if (stage === 'verification' && actionResult?.codeSubmitted && !actionResult?.verificationFailed) {
          const postVerificationState = await waitForHostedPayPalState(tabId, {
            timeoutMs: PAYPAL_HOSTED_STAGE_TRANSITION_TIMEOUT_MS,
            logMessage: '步骤 7：验证码已提交，正在等待 PayPal 进入下一阶段...',
            acceptStage: (nextStage) => (
              nextStage === 'guest_checkout'
              || nextStage === 'review_consent'
              || nextStage === 'approval'
              || nextStage === 'outside_paypal'
            ),
          });
          const nextStage = String(postVerificationState?.hostedStage || postVerificationState?.stage || '').trim();
          if (nextStage === 'verification' || nextStage === 'pay_login' || !nextStage) {
            throw new Error('步骤 7：验证码提交后长时间未进入下一阶段，请手动输入验证码后再继续。');
          }
          await addLog(`步骤 7：验证码提交成功，已进入下一阶段：${nextStage}。`, 'info');
          waitedForVerificationPopupDelay = false;
          await sleepWithStop(500);
          continue;
        }
        if (stage === 'approval' || actionResult?.approveReady) {
          await addLog('步骤 7：正在点击 PayPal 最终授权按钮...', 'info');
          const clicked = await clickApprove(tabId);
          if (clicked) {
            await setState({ plusPaypalApprovedAt: Date.now(), paypalCheckoutStage: 'approval' });
            await sleepWithStop(1000);
          }
        }
        if (typeof waitForTabUrlMatchUntilStopped === 'function') {
          const successTab = await waitForTabUrlMatchUntilStopped(
            tabId,
            (url) => isPaymentsSuccessUrl(url),
            2000,
            200
          ).catch(() => null);
          if (successTab?.url && isPaymentsSuccessUrl(successTab.url)) {
            return;
          }
        }
        await sleepWithStop(1000);
      }
    }

    async function executeHostedOpenAiFlow(tabId, state = {}) {
      await ensureHostedCheckoutReady(tabId, '步骤 7：正在识别 hosted checkout 当前阶段...');
      const mergedState = await ensureHostedCheckoutContext(state, {
        requireGuestProfile: true,
      });
      const hostedState = await readHostedCheckoutState(tabId);
      let payload = {
        address: mergedState?.paypalCheckoutGuestProfile?.address || {},
      };
      if (hostedState?.hostedVerificationVisible) {
        await addLog('步骤 7：检测到 hosted checkout OpenAI 验证码弹窗，正在获取并填写验证码...', 'info');
        payload = {
          ...payload,
          verificationCode: await pollHostedVerificationCode(mergedState),
        };
      }
      const result = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
        type: 'RUN_HOSTED_OPENAI_CHECKOUT_STEP',
        source: 'background',
        payload,
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      await setState({
        paypalCheckoutTabId: tabId,
        paypalCheckoutUrl: String(state?.plusHostedCheckoutEntryUrl || '').trim(),
        paypalCheckoutStage: hostedState?.hostedVerificationVisible ? 'hosted_openai_verification' : 'hosted_openai_checkout',
        paypalCheckoutEntrySource: String(mergedState?.paypalCheckoutEntrySource || 'hosted-checkout').trim(),
      });
      return result || {};
    }

    async function executePayPalCheckoutFlow(state = {}) {
      const tabId = await resolvePayPalTabId(state);
      const initialTab = await chrome?.tabs?.get?.(tabId).catch(() => null);
      const initialUrl = String(initialTab?.url || '').trim();
      const shouldUseHostedFlow = isHostedEntrySource(state) || isHostedOpenAiCheckoutUrl(initialUrl);
      await setState({
        paypalCheckoutTabId: tabId,
      });
      if (shouldUseHostedFlow) {
        const hostedStartedAt = Date.now();
        while (true) {
          const currentTab = await chrome?.tabs?.get?.(tabId).catch(() => null);
          const currentUrl = String(currentTab?.url || '').trim();
          if (currentUrl && isPaymentsSuccessUrl(currentUrl)) {
            break;
          }
          if (currentUrl && isHostedOpenAiCheckoutUrl(currentUrl)) {
            if (Date.now() - hostedStartedAt >= HOSTED_CHECKOUT_TRANSITION_TIMEOUT_MS) {
              const message = '步骤 7：hosted checkout 页面长时间未跳转到 PayPal 或成功页，准备回退到节点 plus-checkout-create 重新创建 Checkout。';
              await failNodeFromBackground('paypal-checkout-flow', message);
              throw new Error(message);
            }
            await executeHostedOpenAiFlow(tabId, state);
            await sleepWithStop(1000);
            continue;
          }
          if (currentUrl && isPayPalUrl(currentUrl)) {
            await executeHostedPayPalFlow(tabId, state);
            break;
          }
          if (currentUrl && isOpenAiReturnUrl(currentUrl)) {
            break;
          }
          const message = '步骤 7：当前既不在 hosted checkout，也不在 PayPal 或 success 页面，准备回退到节点 plus-checkout-create 重新创建 Checkout。';
          await failNodeFromBackground('paypal-checkout-flow', message);
          throw new Error(message);
        }
      } else {
        await executeLegacyPayPalFlow(tabId, state);
      }

      await completeNodeFromBackground('paypal-checkout-flow', {
        plusCheckoutCountry: state?.plusCheckoutCountry || '',
        plusCheckoutCurrency: state?.plusCheckoutCurrency || '',
        plusPaypalApprovedAt: Date.now(),
      });
    }

    return {
      executePayPalCheckoutFlow,
    };
  }

  return {
    createPayPalCheckoutFlowExecutor,
  };
});
