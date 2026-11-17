(function (g) {
  'use strict';

  function classifyErrorStatus(status) {
    const lower = String(status || '').toLowerCase();
    if (
      lower.includes('wrong password') ||
      lower.includes('does not exist') ||
      lower.includes("couldn't find your google account") ||
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
      lower.includes('account disabled')
    ) {
      return 'gid-err-action';
    }
    return 'gid-err-retry';
  }

  function isProxyToken(token) {
    const t = String(token || '').trim();
    if (!t) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
    if (/^proxy[:=]/i.test(t)) return true;
    if (/^([a-z0-9.-]+\.[a-z0-9.-]+):(\d{2,})(:[^:\s]+:.+)?$/i.test(t)) return true;
    if (/^[^|\s]+\|\d{2,}(\|[^|\s]*\|[^|\s]*)?$/.test(t)) return true;
    return false;
  }

  function classifyLineSegments(line) {
    const parts = String(line || '').split(/(\s+)/);
    const out = [];
    let tokenIdx = 0;
    let seenRecovery = false;
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) {
        out.push({ type: 'space', text: p });
        continue;
      }
      if (tokenIdx === 0) out.push({ type: 'email', text: p });
      else if (tokenIdx === 1) out.push({ type: 'password', text: p });
      else if (isProxyToken(p)) out.push({ type: 'proxy', text: p });
      else if (!seenRecovery && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) {
        seenRecovery = true;
        out.push({ type: 'recovery', text: p });
      } else {
        out.push({ type: '2fa', text: p });
      }
      tokenIdx++;
    }
    return out;
  }

  function parseCredentialLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    const parts = trimmed.replace(/\t+/g, ' ').split(/\s+/).filter(Boolean);
    if (parts.length < 2) return null;

    const email = parts[0];
    const password = parts[1];
    let recovery = '';
    let proxy = '';
    const twoFa = [];

    for (let i = 2; i < parts.length; i++) {
      const tok = parts[i];
      if (!proxy && isProxyToken(tok)) {
        proxy = tok.replace(/^proxy[:=]/i, '');
        continue;
      }
      if (!recovery && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tok)) {
        recovery = tok;
        continue;
      }
      twoFa.push(tok);
    }

    let provider = 'gmail';
    const lo = email.toLowerCase();
    if (/@(outlook|hotmail|live|msn|office365)\./.test(lo)) provider = 'outlook';
    else if (/@(yahoo|ymail|rocketmail|aol)\./.test(lo)) provider = 'yahoo';

    return { email, password, recovery, twoFa: twoFa.join(''), proxy, provider };
  }

  function convertTableHtmlToPlainText(html) {
    const str = String(html || '');
    if (!/<t[rdh][\s>]/i.test(str)) return str;
    const rows = [];
    const trMatches = str.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const cells = tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
      const vals = cells.map((c) => c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (vals.length) rows.push(vals.join(' '));
    }
    return rows.join('\n');
  }

  g.NewShooterCredentials = {
    classifyErrorStatus,
    isProxyToken,
    classifyLineSegments,
    parseCredentialLine,
    convertTableHtmlToPlainText
  };
})(typeof self !== 'undefined' ? self : this);
