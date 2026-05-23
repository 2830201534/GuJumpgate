(function attachBackgroundPayPalCheckoutFlow(root, factory) {
  root.MultiPageBackgroundPayPalCheckoutFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPayPalCheckoutFlowModule() {
  const PAYPAL_SOURCE = 'paypal-flow';
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PAYPAL_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/paypal-flow.js'];
  const PAYPAL_SUCCESS_URL_PATTERN = /^https:\/\/(?:chatgpt\.com|www\.chatgpt\.com|chat\.openai\.com)\/(?:backend-api\/)?payments\/success(?:[/?#]|$)/i;
  const PAYPAL_LOGIN_TRANSITION_TIMEOUT_MS = 30000;
  const PAYPAL_LOGIN_TRANSITION_POLL_MS = 500;

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

    function isPaymentsSuccessUrl(url = '') {
      return PAYPAL_SUCCESS_URL_PATTERN.test(String(url || ''));
    }

    function isHostedEntrySource(state = {}) {
      return String(state?.paypalCheckoutEntrySource || '').trim() === 'plus-checkout-create';
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

    async function resolvePayPalTabId(state = {}) {
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
      const legacyCheckoutTabId = Number(state?.plusCheckoutTabId) || 0;
      if (legacyCheckoutTabId) {
        return legacyCheckoutTabId;
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
          const message = '步骤 7：PayPal 支付链路已失效，准备回退到节点 plus-checkout-create 重新创建 Checkout。';
          await failNodeFromBackground('paypal-checkout-flow', message);
          throw new Error(message);
        }
        await ensurePayPalReady(tabId, '步骤 7：正在识别 PayPal 当前阶段...');
        const paypalState = await readHostedPayPalState(tabId);
        const stage = String(paypalState?.hostedStage || paypalState?.stage || '').trim();
        await setState({
          paypalCheckoutTabId: tabId,
          paypalCheckoutUrl: String(paypalState?.currentUrl || currentUrl || '').trim(),
          paypalCheckoutStage: stage,
          paypalCheckoutEntrySource: String(state?.paypalCheckoutEntrySource || 'plus-checkout-create').trim(),
        });
        if (!stage || stage === 'outside_paypal' || stage === 'unknown') {
          const message = '步骤 7：PayPal 支付链路已失效，准备回退到节点 plus-checkout-create 重新创建 Checkout。';
          await failNodeFromBackground('paypal-checkout-flow', message);
          throw new Error(message);
        }
        const latestState = typeof getState === 'function'
          ? await getState().catch(() => ({}))
          : {};
        const mergedState = {
          ...(state || {}),
          ...(latestState && typeof latestState === 'object' ? latestState : {}),
        };
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

    async function executePayPalCheckoutFlow(state = {}) {
      const tabId = await resolvePayPalTabId(state);
      await setState({
        paypalCheckoutTabId: tabId,
      });

      if (isHostedEntrySource(state)) {
        await executeHostedPayPalFlow(tabId, state);
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
