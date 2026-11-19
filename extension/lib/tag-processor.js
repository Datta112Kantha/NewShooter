(function (g) {
  'use strict';

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (lo, hi) => Math.floor(Math.random() * (Math.max(lo, hi) - Math.min(lo, hi) + 1)) + Math.min(lo, hi);

  function resolveSpintax(input) {
    let text = String(input ?? '');
    if (!text.includes('{') || !text.includes('|')) return text;
    const styleBlocks = [];
    text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
      const i = styleBlocks.length;
      styleBlocks.push(m);
      return `__NS_STYLE_${i}__`;
    });
    const re = /\{([^{}]*\|[^{}]*)\}/g;
    let guard = 0;
    while (guard++ < 10 && re.test(text)) {
      re.lastIndex = 0;
      text = text.replace(re, (_, inner) => pick(inner.split('|')));
    }
    for (let i = 0; i < styleBlocks.length; i++) {
      text = text.replace(`__NS_STYLE_${i}__`, styleBlocks[i]);
    }
    return text;
  }

  function processTags(recipientEmail, textOrObj, options = {}) {
    const email = String(recipientEmail || '').trim();
    const user = email.includes('@') ? email.split('@')[0] : email;
    const now = new Date();
    const firstNames = ['Jane', 'Alex', 'Morgan', 'Taylor', 'Jordan', 'Emily', 'Liam'];
    const lastNames = ['Doe', 'Smith', 'Miller', 'Wilson', 'Taylor', 'Moore'];
    const fn = pick(firstNames);
    const ln = pick(lastNames);

    const map = {
      '{email}': email,
      '{user}': user,
      '{firstname}': fn,
      '{lastname}': ln,
      '{name}': `${fn} ${ln}`,
      '{greet}': pick(['Hi', 'Hello', 'Dear']),
      '{closing}': pick(['Best regards', 'Kind regards', 'Sincerely']),
      '{company}': pick(['Northstar Digital', 'Apex Commerce', 'Cloudcrest Labs']),
      '{orderno}': String(randInt(1000000000, 9999999999)),
      '{date}': now.toLocaleDateString('en-US'),
      '{year}': String(now.getFullYear()),
      ...(options.tags || {})
    };

    const resolveStr = (str) => {
      let s = resolveSpintax(str);
      s = s.replace(/\{[^{}]+\}/g, (tok) => {
        if (tok === '{random_digit}' || tok === '{digit}') return String(randInt(0, 9));
        if (tok in map) return map[tok];
        const m = tok.match(/^\{\s*(\d+)\s*-\s*(\d+)\s*\}$/);
        if (m) return String(randInt(parseInt(m[1], 10), parseInt(m[2], 10)));
        return tok;
      });
      return s;
    };

    if (typeof textOrObj === 'string') return resolveStr(textOrObj);
    if (textOrObj && typeof textOrObj === 'object') {
      const out = {};
      for (const k of Object.keys(textOrObj)) {
        out[k] = typeof textOrObj[k] === 'string' ? resolveStr(textOrObj[k]) : textOrObj[k];
      }
      return out;
    }
    return textOrObj;
  }

  g.NewShooterTags = { resolveSpintax, processTags };
})(typeof self !== 'undefined' ? self : this);
