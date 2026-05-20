(function attachCpaJsonBuilder(root, factory) {
  root.MultiPageCpaJsonBuilder = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createCpaJsonBuilderModule() {
  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const normalized = normalizeString(value);
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  function decodeBase64Url(value) {
    const normalized = normalizeString(value).replace(/-/g, '+').replace(/_/g, '/');
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
      return Buffer.from(json, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function parseJwtPayload(token) {
    const normalized = normalizeString(token);
    if (!normalized) {
      return {};
    }

    const parts = normalized.split('.');
    if (parts.length < 2 || !parts[1]) {
      return {};
    }

    try {
      return JSON.parse(decodeBase64Url(parts[1]));
    } catch {
      return {};
    }
  }

  function getOpenAIAuthSection(payload) {
    if (!isPlainObject(payload) || !isPlainObject(payload['https://api.openai.com/auth'])) {
      return {};
    }
    return payload['https://api.openai.com/auth'];
  }

  function getOpenAIProfileSection(payload) {
    if (!isPlainObject(payload) || !isPlainObject(payload['https://api.openai.com/profile'])) {
      return {};
    }
    return payload['https://api.openai.com/profile'];
  }

  function createUnsignedJwt(payload) {
    return `${encodeBase64UrlJson({ alg: 'none', typ: 'JWT', cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.`;
  }

  function toIso(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }

    const normalized = normalizeString(value);
    if (!normalized) {
      return '';
    }

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  function unixSecondsToIso(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return '';
    }

    const parsed = new Date(Math.trunc(numeric) * 1000);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  function buildSyntheticIdToken({ email, accountId, planType, userId, expiresAt }) {
    return createUnsignedJwt({
      email: email || undefined,
      exp: Math.trunc(new Date(expiresAt || Date.now()).getTime() / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: planType,
        chatgpt_user_id: userId || undefined,
        user_id: userId || undefined,
      },
    });
  }

  function buildCpaJson(input = {}) {
    const session = isPlainObject(input.session) ? input.session : {};
    const accessToken = firstNonEmpty(input.accessToken, input.access_token, session.accessToken, session.access_token);
    if (!accessToken) {
      throw new Error('缺少 access_token，无法生成本地 CPA JSON。');
    }

    const accessPayload = parseJwtPayload(accessToken);
    const accessAuth = getOpenAIAuthSection(accessPayload);
    const accessProfile = getOpenAIProfileSection(accessPayload);
    const realIdToken = firstNonEmpty(input.idToken, input.id_token, session.idToken, session.id_token);
    const idPayload = parseJwtPayload(realIdToken);
    const idAuth = getOpenAIAuthSection(idPayload);

    const email = firstNonEmpty(
      session.user && session.user.email,
      session.email,
      accessProfile.email,
      idPayload.email,
      accessPayload.email,
      input.email,
      input.registrationEmail
    );
    if (!email) {
      throw new Error('缺少 email，无法生成本地 CPA JSON 文件名。');
    }

    const accountId = firstNonEmpty(
      session.account && session.account.id,
      session.account_id,
      input.accountId,
      input.account_id,
      accessAuth.chatgpt_account_id,
      accessAuth.account_id,
      idAuth.chatgpt_account_id,
      idAuth.account_id
    );
    const planType = firstNonEmpty(
      session.account && session.account.planType,
      session.plan_type,
      input.planType,
      input.plan_type,
      accessAuth.chatgpt_plan_type,
      accessAuth.plan_type,
      idAuth.chatgpt_plan_type,
      idAuth.plan_type,
      'unknown'
    );
    const userId = firstNonEmpty(
      session.user && session.user.id,
      input.userId,
      accessAuth.chatgpt_user_id,
      accessAuth.user_id,
      idAuth.chatgpt_user_id,
      idAuth.user_id
    );
    const refreshToken = firstNonEmpty(
      input.refreshToken,
      input.refresh_token,
      session.refreshToken,
      session.refresh_token
    );
    const sessionToken = firstNonEmpty(
      input.sessionToken,
      input.session_token,
      session.sessionToken,
      session.session_token
    );
    const expired = firstNonEmpty(
      toIso(session.expires),
      toIso(session.expiresAt),
      toIso(input.expires),
      toIso(input.expiresAt),
      unixSecondsToIso(accessPayload.exp)
    );
    const idToken = realIdToken || buildSyntheticIdToken({
      email,
      accountId,
      planType,
      userId,
      expiresAt: expired || input.now || new Date(),
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
      !realIdToken
        ? '缺少真实 id_token，已根据 account_id / plan_type 写入 CPA 额度面板可解析的占位 claims；上游认证仍使用 access_token。'
        : '',
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
