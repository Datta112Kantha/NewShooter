'use strict';

const crypto = require('node:crypto');

const FIRST_NAMES = [
  'Jane', 'John', 'Alex', 'Morgan', 'Taylor', 'Jordan', 'Emily', 'Daniel', 'Sophia', 'Liam',
  'Olivia', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Chloe', 'mason', 'Harper', 'Logan'
].map((n) => n[0].toUpperCase() + n.slice(1));

const LAST_NAMES = [
  'Doe', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
  'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson'
];

const JOB_TITLES = [
  'Account Executive', 'Operations Manager', 'Product Lead', 'Solutions Architect', 'Customer Success Specialist',
  'Billing Coordinator', 'Senior Analyst', 'Technical Director', 'Finance Associate', 'Support Lead'
];

const COMPANIES = [
  'Northstar Digital', 'Apex Commerce', 'BlueRidge Logistics', 'Cloudcrest Labs', 'Summit Retail Group',
  'Meridian Services', 'Horizon Supply Co.', 'Evergreen Partners', 'Pinnacle Cloud', 'Vanguard Systems'
];

const DOMAINS = [
  'northstardigital.example', 'apexcommerce.example', 'blueridge.example', 'cloudcrest.example', 'summitretail.example'
];

const PRODUCTS = [
  'Cloud Workspace Suite', 'Enterprise Relay Plan', 'Smart Analytics Module', 'Priority Support Pack',
  'Managed Backup Vault', 'Compliance Audit Toolkit', 'Dedicated IP Add-on', 'Pro Automation Bundle'
];

const CATEGORIES = ['Software', 'Cloud Services', 'Subscription', 'Digital Tools', 'Enterprise'];
const DEPARTMENTS = ['Billing', 'Customer Support', 'Technical Support', 'Sales', 'Account Management'];
const PLANS = ['Basic', 'Starter', 'Professional', 'Business', 'Enterprise'];
const CARRIERS = ['FedEx', 'UPS', 'USPS', 'DHL', 'OnTrac'];
const PAY_METHODS = ['Credit Card', 'Debit Card', 'PayPal', 'Bank Transfer', 'Apple Pay', 'Google Pay'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
const STREETS = [
  '412 Oakwood Ave', '742 Evergreen Terrace', '1180 Market St', '590 Cedar Lane', '205 Pinecrest Blvd', '88 Harbor Way'
];
const CITIES = ['Austin', 'Seattle', 'Denver', 'Chicago', 'Boston', 'Phoenix', 'Atlanta', 'Portland'];
const STATES = ['TX', 'WA', 'CO', 'IL', 'MA', 'AZ', 'GA', 'OR'];
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Australia', 'Germany'];

const PREDEFINED_TAG_CATALOG = [
  { key: '{email}', category: 'IDENTITY', desc: 'Recipient full email', example: 'alex@example.com' },
  { key: '{user}', category: 'IDENTITY', desc: 'Recipient username (before @)', example: 'alex' },
  { key: '{name}', category: 'IDENTITY', desc: 'Random full name (faker)', example: 'Jane Doe' },
  { key: '{firstname}', category: 'IDENTITY', desc: 'Random first name', example: 'Jane' },
  { key: '{lastname}', category: 'IDENTITY', desc: 'Random last name', example: 'Doe' },
  { key: '{salutation}', category: 'IDENTITY', desc: 'Random courtesy title', example: 'Ms.' },
  { key: '{jobtitle}', category: 'IDENTITY', desc: 'Random job title', example: 'Operations Manager' },
  { key: '{senderName}', category: 'IDENTITY', desc: 'Configured From display name', example: 'Billing Team' },
  { key: '{greet}', category: 'TONE', desc: 'Random greeting', example: 'Hello' },
  { key: '{closing}', category: 'TONE', desc: 'Random sign-off phrase', example: 'Best regards' },
  { key: '{company}', category: 'BUSINESS', desc: 'Random company name', example: 'Northstar Digital' },
  { key: '{department}', category: 'BUSINESS', desc: 'Random corporate department', example: 'Billing' },
  { key: '{supportemail}', category: 'BUSINESS', desc: 'Support email address', example: 'support@cloudcrest.example' },
  { key: '{website}', category: 'BUSINESS', desc: 'Company website URL', example: 'https://cloudcrest.example' },
  { key: '{orderno}', category: 'COMMERCE', desc: '10-digit order number', example: '4829104712' },
  { key: '{orderid}', category: 'COMMERCE', desc: 'Order reference label', example: 'Order ID' },
  { key: '{refno}', category: 'COMMERCE', desc: '6-char alphanumeric reference', example: 'A9F4K2' },
  { key: '{product}', category: 'COMMERCE', desc: 'Product heading label', example: 'Item' },
  { key: '{productname}', category: 'COMMERCE', desc: 'Random product name', example: 'Cloud Workspace Suite' },
  { key: '{category}', category: 'COMMERCE', desc: 'Product category', example: 'Cloud Services' },
  { key: '{sku}', category: 'COMMERCE', desc: 'SKU identifier', example: 'SKU-94F2A81C' },
  { key: '{qty}', category: 'PRICING', desc: 'Order quantity (2-4)', example: '2' },
  { key: '{unitprice}', category: 'PRICING', desc: 'Item unit price', example: '$84.50' },
  { key: '{subtotal}', category: 'PRICING', desc: 'Calculated subtotal', example: '$169.00' },
  { key: '{tax}', category: 'PRICING', desc: 'Calculated 8% tax', example: '$13.52' },
  { key: '{amount}', category: 'PRICING', desc: 'Random invoice amount', example: '$312' },
  { key: '{grandtotal}', category: 'PRICING', desc: 'Total including tax', example: '$182.52' },
  { key: '{total}', category: 'PRICING', desc: 'Total summary label', example: 'Grand Total' },
  { key: '{currency}', category: 'PRICING', desc: 'Currency code', example: 'USD' },
  { key: '{discount}', category: 'PRICING', desc: 'Discount percentage', example: '15%' },
  { key: '{paymethod}', category: 'PAYMENT', desc: 'Payment method label', example: 'Credit Card' },
  { key: '{cardlast4}', category: 'PAYMENT', desc: 'Last 4 card digits', example: '4242' },
  { key: '{transid}', category: 'PAYMENT', desc: 'Transaction ID', example: 'TXN-7B92M4K1P0' },
  { key: '{accountno}', category: 'PAYMENT', desc: 'Account number', example: 'ACC-84729104' },
  { key: '{plan}', category: 'DATES', desc: 'Subscription plan tier', example: 'Professional' },
  { key: '{memberid}', category: 'DATES', desc: 'Member identifier', example: 'MBR-8492014' },
  { key: '{time}', category: 'DATES', desc: 'Time window label', example: 'period' },
  { key: '{renewaldate}', category: 'DATES', desc: 'Date +30 days', example: 'Dec 11, 2026' },
  { key: '{trialends}', category: 'DATES', desc: 'Date +7 days', example: 'Nov 18, 2026' },
  { key: '{date}', category: 'DATES', desc: 'Short locale date', example: '11/11/2026' },
  { key: '{longdate}', category: 'DATES', desc: 'Long formatted date', example: 'Nov 11, 2026' },
  { key: '{tomorrow}', category: 'DATES', desc: 'Date +1 day', example: 'Nov 12, 2026' },
  { key: '{expiry}', category: 'DATES', desc: 'Expiry date (+30d)', example: 'Dec 11, 2026' },
  { key: '{time24}', category: 'DATES', desc: 'Current time HH:MM', example: '14:30' },
  { key: '{year}', category: 'DATES', desc: 'Current 4-digit year', example: '2026' },
  { key: '{rtime}', category: 'DATES', desc: 'Response turnaround SLA', example: '24-48 hours' },
  { key: '{resbytime}', category: 'DATES', desc: 'Respond by date', example: 'Nov 12, 2026' },
  { key: '{tracking}', category: 'SHIPPING', desc: '12-char tracking number', example: '9X2K8M4P7Q1Z' },
  { key: '{carrier}', category: 'SHIPPING', desc: 'Shipping carrier', example: 'UPS' },
  { key: '{estdelivery}', category: 'SHIPPING', desc: 'Estimated delivery (+7d)', example: 'Nov 18, 2026' },
  { key: '{ticket}', category: 'SUPPORT', desc: 'Support ticket ID', example: 'TKT-8291042' },
  { key: '{caseno}', category: 'SUPPORT', desc: 'Support case ID', example: 'CASE-492018' },
  { key: '{phone}', category: 'SUPPORT', desc: 'Random phone number', example: '+1 (512) 555-0148' },
  { key: '{address}', category: 'LOCATION', desc: 'Street address', example: '412 Oakwood Ave' },
  { key: '{city}', category: 'LOCATION', desc: 'City name', example: 'Austin' },
  { key: '{state}', category: 'LOCATION', desc: 'State abbreviation', example: 'TX' },
  { key: '{country}', category: 'LOCATION', desc: 'Country name', example: 'United States' },
  { key: '{zip}', category: 'LOCATION', desc: '5-digit postal code', example: '78701' },
  { key: '{ip}', category: 'TECH', desc: 'Sample IPv4 address', example: '198.51.100.42' },
  { key: '{uuid}', category: 'TECH', desc: 'Random UUID v4', example: '550e8400-e29b-41d4-a716-446655440000' },
  { key: '{url}', category: 'TECH', desc: 'Sample HTTPS link', example: 'https://northstardigital.example/portal' },
  { key: '{random_digit}', category: 'RANDOM', desc: 'Single random digit 0-9', example: '7' },
  { key: '{1-100}', category: 'RANDOM', desc: 'Random integer in range [min-max]', example: '42' }
];

function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDigits(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += String(randInt(0, 9));
  return out;
}

function randomAlphaNum(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Evaluate spintax expressions like `{Hello|Hi|Hey {there|friend}}`.
 * Preserves `<style>...</style>` CSS blocks and ignores `{key: value}` CSS rules without `|`.
 */
function resolveSpintax(input) {
  let text = String(input ?? '');
  if (!text.includes('{') || !text.includes('|')) return text;

  const styleBlocks = [];
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (match) => {
    const token = `__NEWSHOOTER_STYLE_BLOCK_${styleBlocks.length}__`;
    styleBlocks.push(match);
    return token;
  });

  // Resolve innermost `{a|b|...}` groups (only those containing `|`, up to 12 passes)
  let passes = 0;
  const innermostRe = /\{([^{}]*\|[^{}]*)\}/g;
  while (passes < 12 && innermostRe.test(text)) {
    innermostRe.lastIndex = 0;
    text = text.replace(innermostRe, (_, inner) => {
      const options = inner.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    passes++;
  }

  for (let i = 0; i < styleBlocks.length; i++) {
    text = text.replace(`__NEWSHOOTER_STYLE_BLOCK_${i}__`, styleBlocks[i]);
  }
  return text;
}

function buildBuiltinTagValues(recipientEmail, senderName = '') {
  const cleanEmail = String(recipientEmail || '').trim();
  const user = cleanEmail.includes('@') ? cleanEmail.split('@')[0] : cleanEmail;

  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const fullName = `${firstName} ${lastName}`;
  const domain = pick(DOMAINS);
  const now = new Date();

  const plusDays = (days) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return d;
  };
  const fmtLong = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const fmtShort = (d) => d.toLocaleDateString('en-US');
  const fmtTime24 = (d) => d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  const qty = randInt(2, 4);
  const maxUnit = Number((400 / (4 * 1.08)).toFixed(2));
  const unitPrice = Number((70.99 + Math.random() * (maxUnit - 70.99)).toFixed(2));
  const subtotal = Number((qty * unitPrice).toFixed(2));
  const tax = Number((subtotal * 0.08).toFixed(2));
  const grandTotal = (subtotal + tax).toFixed(2);
  const cityIdx = randInt(0, CITIES.length - 1);

  return {
    '{email}': cleanEmail,
    '{user}': user,
    '{name}': fullName,
    '{firstname}': firstName,
    '{lastname}': lastName,
    '{salutation}': pick(['Mr.', 'Ms.', 'Mrs.', 'Dr.']),
    '{jobtitle}': pick(JOB_TITLES),
    '{senderName}': senderName || 'Relay Sender',
    '{greet}': pick(['Hi', 'Hello', 'Dear', 'Good day', 'Greetings']),
    '{closing}': pick(['Best regards', 'Kind regards', 'Sincerely', 'Thank you', 'Warm regards', 'With appreciation']),
    '{company}': pick(COMPANIES),
    '{department}': pick(DEPARTMENTS),
    '{supportemail}': `support@${domain}`,
    '{website}': `https://${domain}`,
    '{orderno}': randomDigits(10),
    '{orderid}': pick(['Order ID', 'Order Number', 'Order No', 'Order Id', 'Order #', 'Order Ref']),
    '{refno}': randomAlphaNum(6),
    '{product}': pick(['Item', 'Product', 'Service', 'Product Name', 'Description']),
    '{productname}': pick(PRODUCTS),
    '{category}': pick(CATEGORIES),
    '{sku}': `SKU-${randomAlphaNum(8)}`,
    '{qty}': String(qty),
    '{unitprice}': `$${unitPrice.toFixed(2)}`,
    '{subtotal}': `$${subtotal.toFixed(2)}`,
    '{tax}': `$${tax.toFixed(2)}`,
    '{amount}': `$${randInt(250, 400)}`,
    '{grandtotal}': `$${grandTotal}`,
    '{total}': pick(['Total', 'Total Amount', 'Grand Total', 'Balance', 'Final Amount']),
    '{currency}': pick(CURRENCIES),
    '{discount}': `${randInt(5, 30)}%`,
    '{paymethod}': pick(PAY_METHODS),
    '{cardlast4}': randomDigits(4),
    '{transid}': `TXN-${randomAlphaNum(10)}`,
    '{accountno}': `ACC-${randomDigits(8)}`,
    '{plan}': pick(PLANS),
    '{memberid}': `MBR-${randomDigits(7)}`,
    '{time}': pick(['period', 'term', 'duration', 'cycle']),
    '{renewaldate}': fmtLong(plusDays(30)),
    '{trialends}': fmtLong(plusDays(7)),
    '{date}': fmtShort(now),
    '{longdate}': fmtLong(now),
    '{tomorrow}': fmtLong(plusDays(1)),
    '{expiry}': fmtLong(plusDays(30)),
    '{time24}': fmtTime24(now),
    '{year}': String(now.getFullYear()),
    '{rtime}': pick(['24 hours', '48 hours', '2 business days', '24-48 hours', '1-2 business days']),
    '{resbytime}': fmtLong(plusDays(1)),
    '{tracking}': randomAlphaNum(12),
    '{carrier}': pick(CARRIERS),
    '{estdelivery}': fmtLong(plusDays(7)),
    '{ticket}': `TKT-${randomDigits(7)}`,
    '{caseno}': `CASE-${randomDigits(6)}`,
    '{phone}': `+1 (${randInt(200, 899)}) 555-${randomDigits(4)}`,
    '{address}': pick(STREETS),
    '{city}': CITIES[cityIdx],
    '{state}': STATES[cityIdx],
    '{country}': pick(COUNTRIES),
    '{zip}': String(randInt(10001, 99500)),
    '{ip}': `198.51.${randInt(1, 254)}.${randInt(2, 254)}`,
    '{uuid}': crypto.randomUUID(),
    '{url}': `https://${domain}/portal/${randomAlphaNum(6).toLowerCase()}`
  };
}

function resolveCustomTagValue(tagKey, resolvedMap, customTags, tagCounters, visited = new Set()) {
  if (Object.prototype.hasOwnProperty.call(resolvedMap, tagKey)) {
    return resolvedMap[tagKey];
  }
  if (visited.has(tagKey)) {
    return tagKey; // Cycle protection
  }

  const def = customTags[tagKey];
  if (!def || !Array.isArray(def.values) || def.values.length === 0) {
    return tagKey;
  }

  let chosen;
  if (def.type === 'random') {
    chosen = String(pick(def.values));
  } else if (def.type === 'static') {
    chosen = String(def.values[0] ?? '');
  } else {
    const cur = Number(tagCounters[tagKey] || 0);
    chosen = String(def.values[cur % def.values.length]);
    tagCounters[tagKey] = cur + 1;
  }

  const nextVisited = new Set(visited);
  nextVisited.add(tagKey);

  // Resolve any spintax inside custom tag values
  chosen = resolveSpintax(chosen);

  // Resolve nested `{...}` tag references inside chosen value
  chosen = chosen.replace(/\{[^{}]+\}/g, (nestedKey) => {
    if (Object.prototype.hasOwnProperty.call(customTags, nestedKey)) {
      return resolveCustomTagValue(nestedKey, resolvedMap, customTags, tagCounters, nextVisited);
    }
    if (Object.prototype.hasOwnProperty.call(resolvedMap, nestedKey)) {
      return resolvedMap[nestedKey];
    }
    return nestedKey;
  });

  resolvedMap[tagKey] = chosen;
  return chosen;
}

/**
 * Resolve Spintax + 63 Built-in Faker Tags + `{min-max}` ranges + Custom sequential/random tags.
 * Matches `Relay-EXT` `processTags(recipientEmail, payload, options)` contract cleanly.
 */
function processTags(recipientEmail, payload, options = {}) {
  const customTags = options.customTags || options.tagsData || {};
  const tagCounters = options.tagCounters || {};
  const senderName = options.senderName || '';
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
  const excludeFn = typeof options.excludeFn === 'function' ? options.excludeFn : null;
  const cache = options.cache && typeof options.cache === 'object' ? options.cache : null;

  if (cache) {
    cache.tags = cache.tags || {};
    cache.ranges = cache.ranges || {};
  }

  const resolvedMap = buildBuiltinTagValues(recipientEmail, senderName);
  if (cache) {
    Object.assign(resolvedMap, cache.tags);
  }

  // Resolve custom tags (custom tags override built-ins of the same key if any)
  for (const tagKey of Object.keys(customTags)) {
    const def = customTags[tagKey];
    if (!def || !Array.isArray(def.values) || def.values.length === 0) continue;
    if (cache && Object.prototype.hasOwnProperty.call(cache.tags, tagKey)) {
      resolvedMap[tagKey] = cache.tags[tagKey];
      continue;
    }
    delete resolvedMap[tagKey];
    resolveCustomTagValue(tagKey, resolvedMap, customTags, tagCounters, new Set());
  }

  if (cache) {
    Object.assign(cache.tags, resolvedMap);
  }

  const rangeCache = cache ? cache.ranges : {};
  const escapedKeys = Object.keys(resolvedMap).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const tagRegex = new RegExp([...escapedKeys, '\\{random_digit\\}', '\\{digit\\}', '\\{\\s*\\d+\\s*-\\s*\\d+\\s*\\}'].join('|'), 'g');

  function replaceToken(tok) {
    if (tok === '{random_digit}' || tok === '{digit}') {
      return String(randInt(0, 9));
    }
    if (Object.prototype.hasOwnProperty.call(resolvedMap, tok)) {
      return resolvedMap[tok];
    }
    const rangeMatch = tok.match(/^\{\s*(\d+)\s*-\s*(\d+)\s*\}$/);
    if (rangeMatch) {
      let min = parseInt(rangeMatch[1], 10);
      let max = parseInt(rangeMatch[2], 10);
      if (min > max) [min, max] = [max, min];
      const cacheKey = `${min}-${max}`;
      if (!(cacheKey in rangeCache)) {
        rangeCache[cacheKey] = randInt(min, max);
      }
      return String(rangeCache[cacheKey]);
    }
    return tok;
  }

  function walk(val, fieldKey = null) {
    if (fieldKey !== null) {
      if (exclude.has(fieldKey)) return val;
      if (excludeFn && excludeFn(fieldKey, val)) return val;
    }
    if (typeof val === 'string') {
      // Protect <style> blocks during replacement
      const styles = [];
      let safeStr = val.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
        const idx = styles.length;
        styles.push(m);
        return `__NEWSHOOTER_CSS_${idx}__`;
      });
      safeStr = resolveSpintax(safeStr);
      safeStr = safeStr.replace(tagRegex, replaceToken);
      for (let i = 0; i < styles.length; i++) {
        safeStr = safeStr.replace(`__NEWSHOOTER_CSS_${i}__`, styles[i]);
      }
      return safeStr;
    }
    if (Array.isArray(val)) {
      return val.map((item) => walk(item, fieldKey));
    }
    if (val && typeof val === 'object') {
      const out = {};
      for (const k of Object.keys(val)) {
        out[k] = walk(val[k], k);
      }
      return out;
    }
    return val;
  }

  return walk(payload);
}

module.exports = {
  PREDEFINED_TAG_CATALOG,
  resolveSpintax,
  processTags,
  buildBuiltinTagValues
};
