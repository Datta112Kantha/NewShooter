'use strict';

const { parseProxy } = require('../proxy/proxyParser');

const DEFAULT_AUTOMATION_SETTINGS = Object.freeze({
  notifyOnCaptcha: true,
  closeOnCaptcha: false,
  disableTabCloseOnError: false,
  captchaTimeoutSec: 300,
  typingSpeed: 'normal',
  humanizeTyping: true,
  totpMaxRetries: 3
});

const TYPING_PROFILES = Object.freeze({
  slow: { base: 90, variation: 60, backspaceBase: 35, backspaceVariation: 25, pauseBase: 150, pauseVariation: 100 },
  normal: { base: 40, variation: 30, backspaceBase: 20, backspaceVariation: 15, pauseBase: 80, pauseVariation: 50 },
  fast: { base: 15, variation: 15, backspaceBase: 8, backspaceVariation: 7, pauseBase: 30, pauseVariation: 20 },
  instant: { base: 0, variation: 0, backspaceBase: 0, backspaceVariation: 0, pauseBase: 0, pauseVariation: 0 }
});

/**
 * Classify login failure / challenge statuses into Relay-EXT badge tiers:
 *   - 'gid-err-fatal'  -> wrong password, missing account, changed password, bad recovery
 *   - 'gid-err-action' -> needs manual intervention (add recovery mail, too many attempts)
 *   - 'gid-err-retry'  -> transient / captcha / phone / OTP error
 */
function classifyErrorStatus(status) {
  const lower = String(status || '').toLowerCase();
  if (
    lower.includes('wrong password') ||
    lower.includes('does not exist') ||
    lower.includes('couldn\'t find your google account') ||
    lower.includes('password changed') ||
    lower.includes('password was changed') ||
    lower.includes('incorrect recovery mail') ||
    lower.includes('may not be secure')
  ) {
    return 'gid-err-fatal';
  }
  if (
    lower.includes('add recovery mail') ||
    lower.includes('too many incorrect attempt') ||
    lower.includes('account disabled') ||
    lower.includes('suspended')
  ) {
    return 'gid-err-action';
  }
  return 'gid-err-retry';
}

function isProxyToken(token) {
  if (!token) return false;
  const t = String(token).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  if (/^proxy[:=]/i.test(t)) return true;
  // IP:port or host:port[:user:pass]
  if (/^([a-z0-9.-]+\.[a-z0-9.-]+|\[?[0-9a-f:]+\]?):(\d{2,})(:[^:\s]+:.+)?$/i.test(t)) return true;
  if (/^[^|\s]+\|\d{2,}(\|[^|\s]*\|[^|\s]*)?$/.test(t)) return true;
  return false;
}

function detectProviderFromEmail(email) {
  const lower = String(email || '').toLowerCase();
  if (/@(outlook|hotmail|live|msn|office365)\./.test(lower)) return 'outlook';
  if (/@(yahoo|ymail|rocketmail|aol)\./.test(lower)) return 'yahoo';
  return 'gmail';
}

/**
 * Parse a single credential line:
 *   <email> <password> [<recoveryEmail>] [<2FA ...>] [proxy:<proxyUrl> | <proxyUrl>]
 * Also supports tab/comma/semicolon/pipe separation (except proxy pipes when prefixed).
 *
 * Strategy:
 *   - token[0]: email
 *   - token[1]: password
 *   - trailing or `proxy:...` token: proxy (optional)
 *   - first remaining email-like token: recoveryEmail (optional)
 *   - everything else remaining: twoFa (optional, concatenated without spaces)
 */
function parseLoginLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;

  // Normalize comma/semicolon/tab delimiters outside proxy URLs
  let normalized = raw.replace(/\t+/g, ' ');
  if (normalized.includes(',') && !normalized.includes(' ')) {
    normalized = normalized.replace(/,/g, ' ');
  } else if (normalized.includes(';') && !normalized.includes(' ')) {
    normalized = normalized.replace(/;/g, ' ');
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const email = parts[0];
  const password = parts[1];
  let proxy = '';
  let proxyError = '';
  let recovery = '';
  const twoFaTokens = [];

  for (let i = 2; i < parts.length; i++) {
    const tok = parts[i];
    if (!proxy && isProxyToken(tok)) {
      const candidate = tok.replace(/^proxy[:=]/i, '');
      try {
        parseProxy(candidate);
        proxy = candidate;
      } catch (err) {
        proxy = candidate;
        proxyError = err.message;
      }
      continue;
    }
    if (!recovery && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tok)) {
      recovery = tok;
      continue;
    }
    twoFaTokens.push(tok);
  }

  return {
    email,
    password,
    recovery,
    twoFa: twoFaTokens.join(''),
    proxy,
    ...(proxyError ? { proxyError } : {}),
    provider: detectProviderFromEmail(email),
    raw
  };
}

function parseBulkCredentials(text) {
  const lines = String(text || '').split(/\r?\n/);
  const parsed = [];
  const invalid = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const item = parseLoginLine(trimmed);
    if (item && item.email.includes('@')) {
      parsed.push(item);
    } else {
      invalid.push({ lineNumber: i + 1, line: trimmed });
    }
  }

  return { accounts: parsed, invalid };
}

/**
 * Classify segments in a login input line for color-coded live editor highlighting.
 */
function classifyLoginSegments(line) {
  const tokens = String(line || '').split(/(\s+)/);
  const result = [];
  let nonSpaceIndex = 0;
  let seenRecovery = false;

  for (const part of tokens) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      result.push({ type: 'space', text: part });
      continue;
    }
    if (nonSpaceIndex === 0) {
      result.push({ type: 'email', text: part });
    } else if (nonSpaceIndex === 1) {
      result.push({ type: 'password', text: part });
    } else if (isProxyToken(part)) {
      result.push({ type: 'proxy', text: part });
    } else if (!seenRecovery && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) {
      seenRecovery = true;
      result.push({ type: 'recovery', text: part });
    } else {
      result.push({ type: '2fa', text: part });
    }
    nonSpaceIndex++;
  }
  return result;
}

/**
 * Extract plain tab-separated lines when user pastes an HTML table from Excel / Sheets.
 */
function convertHtmlTableToPlainText(html) {
  const str = String(html || '');
  if (!/<t[rdh][\s>]/i.test(str)) return str;

  const rows = [];
  const trMatches = str.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    const cells = tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    const values = cells.map((cell) =>
      cell
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim()
    ).filter(Boolean);
    if (values.length > 0) rows.push(values.join('\t'));
  }
  return rows.join('\n');
}

function getTypingProfile(settings = {}) {
  const merged = { ...DEFAULT_AUTOMATION_SETTINGS, ...settings };
  const profile = TYPING_PROFILES[merged.typingSpeed] || TYPING_PROFILES.normal;
  if (merged.humanizeTyping) return { ...profile };
  return {
    base: profile.base,
    variation: 0,
    backspaceBase: profile.backspaceBase,
    backspaceVariation: 0,
    pauseBase: profile.pauseBase,
    pauseVariation: 0
  };
}

module.exports = {
  DEFAULT_AUTOMATION_SETTINGS,
  TYPING_PROFILES,
  classifyErrorStatus,
  detectProviderFromEmail,
  parseLoginLine,
  parseBulkCredentials,
  classifyLoginSegments,
  convertHtmlTableToPlainText,
  getTypingProfile
};
