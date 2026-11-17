'use strict';

const SUPPORTED_PROTOCOLS = new Set(['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']);

/**
 * Parse a proxy string into a normalized descriptor.
 * Supported formats:
 *   - http://[user:pass@]host:port
 *   - https://[user:pass@]host:port
 *   - socks4://[user@]host:port
 *   - socks5://[user:pass@]host:port
 *   - host:port
 *   - host:port:user:pass
 *   - host|port|user|pass
 *   - direct / none / "" -> null
 *
 * @param {string|object|null|undefined} input
 * @returns {object|null}
 */
function parseProxy(input) {
  if (input === null || input === undefined) return null;

  if (typeof input === 'object' && !Array.isArray(input)) {
    if (!input.host || !input.port) return null;
    const protocol = normalizeProtocol(input.protocol || 'http');
    const port = validatePort(input.port);
    return {
      protocol,
      host: String(input.host).trim(),
      port,
      username: input.username != null ? String(input.username) : '',
      password: input.password != null ? String(input.password) : '',
      raw: formatProxyUrl({
        protocol,
        host: String(input.host).trim(),
        port,
        username: input.username != null ? String(input.username) : '',
        password: input.password != null ? String(input.password) : ''
      })
    };
  }

  const trimmed = String(input).trim();
  if (!trimmed || /^(direct|none|null|off)$/i.test(trimmed)) return null;

  // URL format: scheme://[user:pass@]host:port
  if (/^[a-z0-9+.-]+:\/\//i.test(trimmed)) {
    let parsedUrl;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      throw new Error(`Invalid proxy URL: ${redactProxyString(trimmed)}`);
    }
    const rawProto = parsedUrl.protocol.replace(/:$/, '').toLowerCase();
    const protocol = normalizeProtocol(rawProto);
    if (!parsedUrl.hostname) {
      throw new Error(`Missing proxy host in URL: ${redactProxyString(trimmed)}`);
    }
    const defaultPort = protocol.startsWith('socks') ? 1080 : (protocol === 'https' ? 443 : 8080);
    const port = validatePort(parsedUrl.port || defaultPort);
    const username = decodeSafe(parsedUrl.username);
    const password = decodeSafe(parsedUrl.password);
    const host = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    return {
      protocol,
      host,
      port,
      username,
      password,
      raw: trimmed
    };
  }

  // Delimited shorthand: host:port | host:port:user:pass | host|port|user|pass
  if (trimmed.includes('|')) {
    const parts = trimmed.split('|').map((s) => s.trim());
    return buildFromParts(parts, trimmed);
  }

  // IPv6 shorthand [::1]:1080[:user:pass]
  if (trimmed.startsWith('[')) {
    const m = trimmed.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*):(.*))?$/);
    if (!m) throw new Error(`Invalid bracketed proxy format: ${redactProxyString(trimmed)}`);
    return {
      protocol: 'http',
      host: m[1].trim(),
      port: validatePort(m[2]),
      username: m[3] || '',
      password: m[4] || '',
      raw: trimmed
    };
  }

  // Colon-separated: host:port or host:port:user:pass (4th field preserves colons in password)
  const colonParts = trimmed.split(':');
  if (colonParts.length === 2) {
    return buildFromParts(colonParts, trimmed);
  }
  if (colonParts.length >= 4) {
    const [host, port, username, ...rest] = colonParts;
    return buildFromParts([host, port, username, rest.join(':')], trimmed);
  }

  // Tab or whitespace separated: host port user pass
  const wsParts = trimmed.split(/[\t ]+/).filter(Boolean);
  if (wsParts.length >= 2) {
    return buildFromParts(wsParts, trimmed);
  }

  throw new Error(`Unsupported proxy format: ${redactProxyString(trimmed)}`);
}

function buildFromParts(parts, raw) {
  const [hostRaw, portRaw, userRaw = '', passRaw = ''] = parts;
  const host = String(hostRaw || '').trim();
  if (!host) throw new Error('Proxy host is empty');
  const port = validatePort(portRaw);
  return {
    protocol: 'http',
    host,
    port,
    username: String(userRaw || ''),
    password: String(passRaw || ''),
    raw
  };
}

function normalizeProtocol(proto) {
  const clean = String(proto || 'http').toLowerCase().trim();
  if (!SUPPORTED_PROTOCOLS.has(clean)) {
    throw new Error(`Unsupported proxy protocol: ${clean}`);
  }
  if (clean === 'socks5h') return 'socks5';
  if (clean === 'socks4a') return 'socks4';
  return clean;
}

function validatePort(portVal) {
  const num = Number(portVal);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error(`Invalid proxy port: ${portVal}`);
  }
  return num;
}

function decodeSafe(val) {
  if (!val) return '';
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function formatProxyUrl(proxy, { redact = false } = {}) {
  if (!proxy) return '';
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
  let auth = '';
  if (proxy.username) {
    const u = encodeURIComponent(proxy.username);
    const p = redact ? '***' : encodeURIComponent(proxy.password || '');
    auth = proxy.password || redact ? `${u}:${p}@` : `${u}@`;
  }
  return `${proxy.protocol}://${auth}${host}:${proxy.port}`;
}

function redactProxyString(str) {
  if (!str) return '';
  try {
    return String(str).replace(/(\/\/[^:@/\s]+:)([^@/\s]+)(@)/, '$1***$3')
      .replace(/^([^:\s]+:\d+:[^:\s]+:)(.+)$/, '$1***');
  } catch {
    return '[redacted-proxy]';
  }
}

/**
 * Format descriptor for Chrome / Playwright / UI display (never exposes raw password by default).
 */
function describeProxy(proxyInput) {
  const parsed = typeof proxyInput === 'object' ? parseProxy(proxyInput) : parseProxy(proxyInput);
  if (!parsed) return null;
  return {
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    hasAuth: Boolean(parsed.username || parsed.password),
    display: formatProxyUrl(parsed, { redact: true })
  };
}

module.exports = {
  SUPPORTED_PROTOCOLS,
  parseProxy,
  formatProxyUrl,
  redactProxyString,
  describeProxy
};
