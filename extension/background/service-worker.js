importScripts('../lib/totp.js', '../lib/verification.js', '../lib/automation-settings.js');

const DEFAULT_WS_URL = 'ws://127.0.0.1:8080';

let ws = null;
let currentWsUrl = '';
let wsReconnectTimer = null;
let verificationPool = new self.Verification();
let activeProxyAuth = null;
let initPromise = null;
const authRetryCounts = new Map();
const pendingQueueTimers = new Set();
const pendingWsRequests = new Map();
const wsOpenWaiters = [];

function parseStandaloneProxy(raw) {
  let trimmed = String(raw || '').trim().replace(/^proxy[:=]/i, '');
  if (!trimmed || /^(direct|none|null|off)$/i.test(trimmed)) return null;
  if (/^[a-z0-9+.-]+:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const proto = u.protocol.replace(/:$/, '').toLowerCase();
    const scheme = proto.replace(/h$/, '').replace(/a$/, '');
    if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) {
      throw new Error(`Unsupported standalone proxy protocol: ${proto}`);
    }
    const port = Number(u.port || (scheme.startsWith('socks') ? 1080 : (scheme === 'https' ? 443 : 8080)));
    if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid proxy host or port');
    }
    return {
      protocol: proto,
      scheme,
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || '')
    };
  }
  if (trimmed.includes('|')) {
    const parts = trimmed.split('|').map((s) => s.trim());
    const port = Number(parts[1] || 8080);
    if (!parts[0] || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid proxy host or port');
    }
    return { protocol: 'http', scheme: 'http', host: parts[0], port, username: parts[2] || '', password: parts.slice(3).join('|') };
  }
  if (trimmed.startsWith('[')) {
    const m = trimmed.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*):(.*))?$/);
    if (!m) throw new Error('Invalid bracketed proxy format');
    return { protocol: 'http', scheme: 'http', host: m[1], port: Number(m[2]), username: m[3] || '', password: m[4] || '' };
  }
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx !== -1) {
    const authPart = trimmed.slice(0, atIdx);
    const addrPart = trimmed.slice(atIdx + 1);
    const colonIdx = authPart.indexOf(':');
    const username = colonIdx === -1 ? authPart : authPart.slice(0, colonIdx);
    const password = colonIdx === -1 ? '' : authPart.slice(colonIdx + 1);
    const [host = '', portStr = '8080'] = addrPart.split(':');
    return { protocol: 'http', scheme: 'http', host, port: Number(portStr), username, password };
  }
  const parts = trimmed.split(':');
  if (parts.length >= 4) {
    return {
      protocol: 'http',
      scheme: 'http',
      host: parts[0],
      port: Number(parts[1] || 8080),
      username: parts[2] || '',
      password: parts.slice(3).join(':')
    };
  }
  const port = Number(parts[1] || 8080);
  if (!parts[0] || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid proxy host or port');
  }
  return {
    protocol: 'http',
    scheme: 'http',
    host: parts[0],
    port,
    username: '',
    password: ''
  };
}

if (chrome.webRequest?.onAuthRequired) {
  const respondProxyAuth = (details, callback) => {
    if (!activeProxyAuth || (!activeProxyAuth.username && !activeProxyAuth.password)) {
      return callback({});
    }
    const attempts = (authRetryCounts.get(details.requestId) || 0) + 1;
    authRetryCounts.set(details.requestId, attempts);
    if (attempts > 2) {
      authRetryCounts.delete(details.requestId);
      return callback({ cancel: true });
    }
    return callback({
      authCredentials: {
        username: activeProxyAuth.username || '',
        password: activeProxyAuth.password || ''
      }
    });
  };

  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (!details.isProxy) {
        return callback({});
      }
      if (activeProxyAuth) {
        respondProxyAuth(details, callback);
        return;
      }
      getSession(['standaloneProxyAuth'])
        .then((ses) => {
          if (!activeProxyAuth && ses?.standaloneProxyAuth) {
            activeProxyAuth = ses.standaloneProxyAuth;
          }
          if (activeProxyAuth) {
            respondProxyAuth(details, callback);
            return null;
          }
          return (initPromise || Promise.resolve())
            .then(() => getSession(['standaloneProxyAuth']))
            .then((ses2) => {
              if (!activeProxyAuth && ses2?.standaloneProxyAuth) {
                activeProxyAuth = ses2.standaloneProxyAuth;
              }
              respondProxyAuth(details, callback);
            });
        })
        .catch(() => callback({}));
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
  );

  const clearAuthTracker = (details) => {
    if (details?.requestId) authRetryCounts.delete(details.requestId);
  };
  chrome.webRequest.onCompleted?.addListener(clearAuthTracker, { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred?.addListener(clearAuthTracker, { urls: ['<all_urls>'] });
}

// ── Storage Helpers (MV3 sleep-resilient) ────────────────────────────────────
async function getSession(keys) {
  try {
    if (chrome.storage?.session) return await chrome.storage.session.get(keys);
  } catch { }
  return chrome.storage.local.get(keys);
}

async function setSession(obj) {
  try {
    if (chrome.storage?.session) return await chrome.storage.session.set(obj);
  } catch { }
  return chrome.storage.local.set(obj);
}

async function extractRpaParamsFromUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const u = new URL(urlStr);
    const acc = u.searchParams.get('rpa_account');
    const em = u.searchParams.get('rpa_email');
    const rpaWs = u.searchParams.get('rpa_ws');
    const update = {};
    if (acc) update.rpa_account = acc;
    if (em) update.rpa_email = em;
    if (rpaWs) update.wsUrl = rpaWs;
    if (Object.keys(update).length > 0) {
      await chrome.storage.local.set(update);
      if (rpaWs) await connectWebSocket(rpaWs);
      else sendRegisterAgent();
      return true;
    }
  } catch { }
  return false;
}

async function initState() {
  const res = await chrome.storage.local.get(['verificationItems', 'wsUrl', 'rpa_account', 'rpa_email']);
  if (Array.isArray(res.verificationItems)) {
    verificationPool = self.Verification.fromJSON(res.verificationItems);
  }
  const ses = await getSession(['standaloneProxyAuth']);
  if (ses.standaloneProxyAuth) activeProxyAuth = ses.standaloneProxyAuth;
  await chrome.alarms.create('relay_keepalive', { periodInMinutes: 0.4 });
  const tabs = await chrome.tabs.query({}).catch(() => []);
  let discovered = false;
  for (const t of tabs) {
    if (await extractRpaParamsFromUrl(t.url)) discovered = true;
  }
  if (!discovered) connectWebSocket();
}

chrome.runtime.onInstalled.addListener(() => { initPromise = initState(); });
chrome.runtime.onStartup.addListener(() => { initPromise = initState(); });
initPromise = initState();

// ── Extension Action Click Handler (Independent OS Popup Window) ────────────
if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(async () => {
    try {
      const popupUrl = chrome.runtime.getURL('popup/popup.html');
      const allWindows = await chrome.windows.getAll({ populate: true }).catch(() => []);
      for (const win of allWindows) {
        if (win.tabs?.some((t) => t.url && (t.url.startsWith(popupUrl) || t.url.includes('popup/popup.html')))) {
          await chrome.windows.update(win.id, { focused: true }).catch(() => { });
          return;
        }
      }
      await chrome.windows.create({
        url: popupUrl,
        type: 'popup',
        width: 780,
        height: 680,
        focused: true
      });
    } catch (err) {
      console.warn('Failed to handle action click:', err);
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'relay_keepalive') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    } else {
      sendHeartbeat();
    }
    processLoginQueueTick();
  } else if (alarm.name === 'relay_login_queue') {
    processLoginQueueTick();
  }
});

// ── Verification Pool Persistence ────────────────────────────────────────────
async function saveVerificationPool() {
  await chrome.storage.local.set({ verificationItems: verificationPool.toJSON() });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const ses = await getSession(['cdpLocks', 'tabEmails', 'pendingLogins', 'tabLiveInfo']);
  const locks = ses.cdpLocks || {};
  if (locks[tabId]) {
    delete locks[tabId];
    await setSession({ cdpLocks: locks });
  }
  const pending = ses.pendingLogins || {};
  if (pending[tabId]) {
    delete pending[tabId];
    await setSession({ pendingLogins: pending });
  }
  const liveInfo = ses.tabLiveInfo || {};
  if (liveInfo[tabId]) {
    delete liveInfo[tabId];
    await setSession({ tabLiveInfo: liveInfo });
  }
  const tabEmails = ses.tabEmails || {};
  const email = tabEmails[tabId];
  if (email) {
    const released = verificationPool.releaseByEmail(email);
    if (released > 0) await saveVerificationPool();
    delete tabEmails[tabId];
    await setSession({ tabEmails });
  }
});

chrome.debugger?.onDetach?.addListener(async (source) => {
  if (!source?.tabId) return;
  const ses = await getSession(['cdpLocks']);
  const locks = ses.cdpLocks || {};
  if (locks[source.tabId]) {
    delete locks[source.tabId];
    await setSession({ cdpLocks: locks });
  }
});

// ── URL Bootstrap Detection (?rpa_account=...&rpa_email=...&rpa_ws=...) ──────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const urlStr = changeInfo.url || tab?.url;
  if (urlStr) await extractRpaParamsFromUrl(urlStr);
});

// ── WebSocket Connection & Controller Bridge ─────────────────────────────────
function resolveWsOpenWaiters(ok) {
  while (wsOpenWaiters.length > 0) {
    const w = wsOpenWaiters.shift();
    clearTimeout(w.timer);
    w.resolve(ok);
  }
}

async function connectWebSocket(explicitUrl) {
  const settings = await self.AutomationSettings.load();
  const stored = await chrome.storage.local.get(['wsUrl']);
  const targetUrl = explicitUrl || stored.wsUrl || settings.wsUrl || DEFAULT_WS_URL;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    if (currentWsUrl === targetUrl) return;
    try { ws.close(); } catch { }
    ws = null;
  }

  currentWsUrl = targetUrl;
  try {
    ws = new WebSocket(targetUrl);
  } catch {
    resolveWsOpenWaiters(false);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    clearTimeout(wsReconnectTimer);
    resolveWsOpenWaiters(true);
    sendRegisterAgent();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    await handleControllerMessage(msg);
  };

  ws.onerror = () => {
    try { ws.close(); } catch { }
  };

  ws.onclose = () => {
    ws = null;
    resolveWsOpenWaiters(false);
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => connectWebSocket(), 3500);
}

async function ensureWsConnected(explicitUrl, timeoutMs = 4000) {
  const settings = await self.AutomationSettings.load();
  const stored = await chrome.storage.local.get(['wsUrl']);
  const targetUrl = explicitUrl || stored.wsUrl || settings.wsUrl || DEFAULT_WS_URL;
  if (ws && ws.readyState === WebSocket.OPEN && currentWsUrl === targetUrl) {
    return true;
  }
  await connectWebSocket(targetUrl);
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  if (!ws) return false;
  return new Promise((resolve) => {
    const entry = {
      resolve,
      timer: setTimeout(() => {
        const idx = wsOpenWaiters.indexOf(entry);
        if (idx !== -1) wsOpenWaiters.splice(idx, 1);
        resolve(Boolean(ws && ws.readyState === WebSocket.OPEN));
      }, timeoutMs)
    };
    wsOpenWaiters.push(entry);
  });
}

async function sendWsRequest(payload, timeoutMs = 30000) {
  const connected = await ensureWsConnected(payload.wsUrl);
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Controller WebSocket unreachable (${currentWsUrl || DEFAULT_WS_URL})`);
  }
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body = { ...payload, requestId };
  delete body.wsUrl;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWsRequests.delete(requestId);
      reject(new Error(`Controller request timed out (${payload.type})`));
    }, timeoutMs);
    pendingWsRequests.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify(body));
  });
}

async function sendWs(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    await ensureWsConnected();
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

async function sendRegisterAgent() {
  const local = await chrome.storage.local.get(['rpa_account', 'rpa_email', 'rpa_proxy']);
  if (!local.rpa_account && !local.rpa_email) return;
  sendWs({
    type: 'REGISTER_AGENT',
    accountId: local.rpa_account || local.rpa_email,
    email: local.rpa_email || '',
    proxy: local.rpa_proxy || '',
    provider: detectProviderFromEmail(local.rpa_email)
  });
}

async function sendHeartbeat() {
  const tabs = await chrome.tabs.query({});
  const mailTabs = tabs
    .filter((t) => /mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com/i.test(t.url || ''))
    .map((t) => ({
      tabId: t.id,
      title: t.title || '',
      url: t.url || '',
      provider: t.url.includes('outlook.') ? 'outlook' : (t.url.includes('yahoo.') ? 'yahoo' : 'gmail')
    }));
  sendWs({ type: 'HEARTBEAT', tabs: mailTabs });
}

function detectProviderFromEmail(email) {
  const lo = String(email || '').toLowerCase();
  if (/@(outlook|hotmail|live|msn|office365)\./.test(lo)) return 'outlook';
  if (/@(yahoo|ymail|rocketmail)\./.test(lo)) return 'yahoo';
  return 'gmail';
}

const PROVIDER_MAIL_PATTERNS = {
  gmail: /mail\.google\.com/i,
  outlook: /outlook\.(live|office|office365)\.com/i,
  yahoo: /mail\.yahoo\.com/i
};

const ALL_MAIL_URL_PATTERNS = [
  'https://mail.google.com/*',
  'https://outlook.live.com/*',
  'https://outlook.office.com/*',
  'https://outlook.office365.com/*',
  'https://mail.yahoo.com/*'
];

async function findTargetMailTab(msg) {
  const allTabs = await chrome.tabs.query({});
  const provider = msg.provider || 'gmail';
  const rx = PROVIDER_MAIL_PATTERNS[provider] || PROVIDER_MAIL_PATTERNS.gmail;
  if (msg.tabId) {
    const exact = allTabs.find((t) => t.id === Number(msg.tabId));
    if (exact && rx.test(exact.url || '')) return exact;
  }
  const candidates = allTabs.filter((t) => rx.test(t.url || ''));
  if (candidates.length === 0) return null;
  if (msg.email) {
    const byTitle = candidates.find((t) => (t.title || '').toLowerCase().includes(msg.email.toLowerCase()));
    if (byTitle) return byTitle;
  }
  return candidates[0];
}

async function handleControllerMessage(msg) {
  const type = String(msg.type || '').toUpperCase();

  if (msg.requestId && pendingWsRequests.has(msg.requestId)) {
    const pending = pendingWsRequests.get(msg.requestId);
    pendingWsRequests.delete(msg.requestId);
    clearTimeout(pending.timer);
    pending.resolve(msg);
    return;
  }

  if (type === 'REGISTER_SUCCESS') {
    await chrome.storage.local.set({
      rpa_account: msg.accountId || '',
      rpa_email: msg.email || '',
      rpa_password: msg.password || '',
      rpa_recovery: msg.recovery || '',
      rpa_twoFa: msg.twoFa || '',
      rpa_provider: msg.provider || 'gmail'
    });
    if (msg.automationSettings) {
      await self.AutomationSettings.save(msg.automationSettings);
    }
    return;
  }

  if (type === 'EXECUTE_DISPATCH' || type === 'START_DISPATCH') {
    const tab = await findTargetMailTab(msg);
    if (!tab) {
      sendWs({
        type: 'TASK_STATUS_UPDATE',
        taskId: msg.taskId,
        accountId: msg.accountId,
        status: 'FAILED',
        errorMessage: `No open ${msg.provider || 'mail'} tab available`
      });
      return;
    }
    chrome.tabs.sendMessage(tab.id, { action: 'EXECUTE_DISPATCH', payload: msg }, (resp) => {
      if (chrome.runtime.lastError) {
        sendWs({
          type: 'TASK_STATUS_UPDATE',
          taskId: msg.taskId,
          accountId: msg.accountId,
          tabId: tab.id,
          status: 'FAILED',
          errorMessage: chrome.runtime.lastError.message
        });
      }
    });
    return;
  }

  if (type === 'ABORT_DISPATCH') {
    const tabs = await chrome.tabs.query({ url: ALL_MAIL_URL_PATTERNS });
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { action: 'ABORT_DISPATCH' }).catch(() => { });
    }
    return;
  }

  if (type === 'FETCH_FOLDERS') {
    let tabs = [];
    if (msg.tabId) {
      const exact = await chrome.tabs.get(Number(msg.tabId)).catch(() => null);
      if (exact && /mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com/i.test(exact.url || '')) {
        tabs = [exact];
      }
    }
    if (tabs.length === 0) {
      tabs = await chrome.tabs.query({ url: ALL_MAIL_URL_PATTERNS });
    }
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { action: 'FETCH_FOLDERS' }).catch(() => { });
    }
    return;
  }

  if (type === 'RELOAD_TABS') {
    const ids = Array.isArray(msg.tabIds) ? msg.tabIds : null;
    if (ids && ids.length > 0) {
      let reloadedAny = false;
      for (const id of ids) {
        const existing = await chrome.tabs.get(Number(id)).catch(() => null);
        if (existing) {
          await chrome.tabs.reload(existing.id).catch(() => { });
          reloadedAny = true;
        }
      }
      if (!reloadedAny) {
        const tabs = await chrome.tabs.query({ url: ALL_MAIL_URL_PATTERNS });
        for (const t of tabs) chrome.tabs.reload(t.id).catch(() => { });
      }
    } else {
      const tabs = await chrome.tabs.query({ url: ALL_MAIL_URL_PATTERNS });
      for (const t of tabs) chrome.tabs.reload(t.id).catch(() => { });
    }
    return;
  }

  if (type === 'CLOSE_TAB' && msg.tabId) {
    chrome.tabs.remove(Number(msg.tabId)).catch(() => { });
    return;
  }

  if (type === 'CLOSE_WINDOW' || type === 'CLOSE_BROWSER') {
    const wins = await chrome.windows.getAll();
    for (const w of wins) chrome.windows.remove(w.id).catch(() => { });
    return;
  }

  if (type === 'PING_TABS' || type === 'PING') {
    const [tabs, ses, local] = await Promise.all([
      chrome.tabs.query({}),
      getSession(['pendingLogins', 'tabEmails', 'verificationStatuses', 'tabLiveInfo']),
      chrome.storage.local.get(['rpa_account', 'rpa_email'])
    ]);
    const pending = ses.pendingLogins || {};
    const emails = ses.tabEmails || {};
    const vs = ses.verificationStatuses || {};
    const liveInfo = ses.tabLiveInfo || {};

    const tabList = tabs.map((t) => {
      const email = emails[t.id] || pending[t.id]?.email || (t.title?.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0]) || '';
      const info = liveInfo[t.id] || {};
      const verif = vs[String(email).trim().toLowerCase()];
      const provider = info.provider || detectProviderFromEmail(email || t.url);
      let status = info.status || 'Active';
      if (verif) {
        status = verif.statusText || 'Verification';
      } else if (/accounts\.google\.com|login\.live\.com|login\.yahoo\.com/i.test(t.url || '')) {
        status = 'Logging in';
      } else if (/mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com/i.test(t.url || '')) {
        status = info.status || 'Ready';
      }

      return {
        tabId: t.id,
        id: t.id,
        windowId: t.windowId,
        email,
        provider,
        tabName: t.title || email || 'Mail Tab',
        status,
        inboxCount: info.inboxCount ?? 0
      };
    });

    sendWs({
      type: 'PONG_TABS',
      requestId: msg.requestId,
      tabs: tabList,
      timestamp: Date.now()
    });
    return;
  }
}

// ── CDP Debugger Helpers (Click + Enter + Humanized Organic Typing) ──────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randJitter = (base, variation) => Math.max(0, base + (Math.random() * 2 - 1) * variation);

async function ensureCdpAttached(tabId) {
  const ses = await getSession(['cdpLocks']);
  const locks = ses.cdpLocks || {};
  if (locks[tabId]) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError && !/Another debugger/i.test(chrome.runtime.lastError.message)) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve();
    });
  });
  locks[tabId] = true;
  await setSession({ cdpLocks: locks });
}

function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}

async function cdpClick(tabId, x, y) {
  await ensureCdpAttached(tabId);
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(25);
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(35);
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function cdpEnter(tabId) {
  await ensureCdpAttached(tabId);
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', code: 'Enter' });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

async function cdpTypeOrganic(tabId, text) {
  const settings = await self.AutomationSettings.load();
  const profile = self.AutomationSettings.getTypingProfile(settings);
  await ensureCdpAttached(tabId);

  const str = String(text || '');
  if (profile.base === 0) {
    await cdpSend(tabId, 'Input.insertText', { text: str });
    return;
  }

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      // rawKeyDown has NO text field so Chrome does not insert twice alongside char
      await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch });
      await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch });
      await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    } else {
      await cdpSend(tabId, 'Input.insertText', { text: ch });
    }
    const delay = (ch === ' ' || ch === '.' || ch === '@')
      ? randJitter(profile.pauseBase, profile.pauseVariation)
      : randJitter(profile.base, profile.variation);
    if (delay > 0) await sleep(delay);
  }
}

function getProviderLoginUrl(provider) {
  if (provider === 'outlook') return 'https://login.live.com/';
  if (provider === 'yahoo') return 'https://login.yahoo.com/';
  return 'https://accounts.google.com/ServiceLogin?service=mail';
}

// ── Tiled Grid Window Opener & Tab Controls ──────────────────────────────────
async function openTabsGrid({ count, provider = 'gmail', accounts = [], hGap = 15, vGap = 15, hVal, vVal, stagger = true, layout, screenWidth, screenHeight, startUrls = [], baseX = 0, baseY = 0 }) {
  const n = Math.max(1, Math.min(20, Number(count || 1)));
  const hPercent = Math.max(10, Math.min(100, Number(hVal ?? hGap ?? 20)));
  const vPercent = Math.max(10, Math.min(100, Number(vVal ?? vGap ?? 20)));
  const gapX = Math.max(0, Math.round(Number(hGap ?? 15) * 0.4));
  const gapY = Math.max(0, Math.round(Number(vGap ?? 15) * 0.4));
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  // Default to conservative 800x600 when screen bounds are unknown so bounds stay >50% visible even on headless displays
  const availW = Math.max(640, Number(screenWidth || 800));
  const availH = Math.max(520, Number(screenHeight || 600));

  // Map H and V sliders to proportional screen percentage dimensions (e.g. width = Math.round(availW * (hVal/100)), height = Math.round(availH * (vVal/100)))
  const w = Math.max(240, Math.min(availW, Math.round(availW * (hPercent / 100))));
  const h = Math.max(240, Math.min(availH, Math.round(availH * (vPercent / 100))));
  const isStagger = (layout === 'tile' || layout === 'grid' || stagger === false) ? false : Boolean(stagger || layout === 'stagger');
  const opened = [];

  for (let i = 0; i < n; i++) {
    let left, top;
    if (isStagger) {
      // Diagonal staggered positioning: left = baseX + i * 36, top = baseY + i * 36
      const maxL = Math.max(0, availW - Math.ceil(w * 0.5));
      const maxT = Math.max(0, availH - Math.ceil(h * 0.5));
      left = Math.max(0, Math.min(maxL, Number(baseX || 0) + i * 36));
      top = Math.max(0, Math.min(maxT, Number(baseY || 0) + i * 36));
    } else {
      // Tiled grid positioning
      const col = i % cols;
      const row = Math.floor(i / cols);
      left = Math.max(0, Math.min(Math.max(0, availW - Math.ceil(w * 0.65)), col * (w + gapX)));
      top = Math.max(0, Math.min(Math.max(0, availH - Math.ceil(h * 0.65)), row * (h + gapY)));
    }
    const acc = accounts[i] || null;
    const targetProvider = acc?.provider || provider;
    const targetUrl = startUrls[i] || getProviderLoginUrl(targetProvider);

    let win;
    try {
      win = await chrome.windows.create({
        url: targetUrl,
        left,
        top,
        width: w,
        height: h,
        focused: i === 0
      });
    } catch {
      win = await chrome.windows.create({
        url: targetUrl,
        focused: i === 0
      });
    }
    const tabId = win.tabs?.[0]?.id;
    if (acc && tabId) {
      const ses = await getSession(['pendingLogins']);
      const pending = ses.pendingLogins || {};
      pending[tabId] = acc;
      await setSession({ pendingLogins: pending });
    }
    opened.push({ windowId: win.id, tabId, left, top, width: w, height: h });
  }
  return opened;
}

async function applyStandaloneProxy(proxyStr) {
  if (!chrome.proxy?.settings) throw new Error('chrome.proxy API unavailable');
  const trimmed = String(proxyStr || '').trim();
  const parsed = parseStandaloneProxy(trimmed);
  if (!parsed) {
    activeProxyAuth = null;
    await setSession({ standaloneProxyAuth: null });
    await self.AutomationSettings.save({ standaloneProxy: '' });
    await new Promise((res) => chrome.proxy.settings.clear({ scope: 'regular' }, res));
    return { mode: 'direct' };
  }
  if (parsed.username || parsed.password) {
    activeProxyAuth = { username: parsed.username, password: parsed.password };
    await setSession({ standaloneProxyAuth: activeProxyAuth });
  } else {
    activeProxyAuth = null;
    await setSession({ standaloneProxyAuth: null });
  }
  await self.AutomationSettings.save({ standaloneProxy: trimmed });

  await new Promise((res) => {
    chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: parsed.scheme, host: parsed.host, port: parsed.port },
          bypassList: ['127.0.0.1', 'localhost']
        }
      },
      scope: 'regular'
    }, res);
  });

  const requiresBridge = parsed.scheme.startsWith('socks') && Boolean(parsed.username || parsed.password);
  return {
    mode: 'fixed_servers',
    scheme: parsed.scheme,
    host: parsed.host,
    port: parsed.port,
    hasAuth: Boolean(parsed.username),
    requiresBridge,
    warning: requiresBridge ? 'Chromium chrome.proxy does not natively authenticate SOCKS5; use Controller Isolated Launch for SOCKS5 auth.' : ''
  };
}

let queueTickRunning = false;
async function processLoginQueueTick() {
  if (queueTickRunning) return;
  queueTickRunning = true;
  try {
    const ses = await getSession(['loginQueue', 'pendingLogins']);
    const q = ses.loginQueue;
    if (!q || !Array.isArray(q.items) || q.items.length === 0) return;

    const now = Date.now();
    if (q.nextAt && now + 50 < q.nextAt) {
      const waitMs = q.nextAt - now;
      const t = setTimeout(() => { pendingQueueTimers.delete(t); processLoginQueueTick(); }, waitMs);
      pendingQueueTimers.add(t);
      chrome.alarms.create('relay_login_queue', { when: q.nextAt });
      return;
    }

    const item = q.items.shift();
    if (item) {
      const acc = item.account;
      if (acc.proxy) {
        await applyStandaloneProxy(acc.proxy).catch(() => { });
      }
      if (item.targetTabId) {
        const pending = ses.pendingLogins || {};
        pending[item.targetTabId] = acc;
        await setSession({ pendingLogins: pending });
        await chrome.tabs.update(item.targetTabId, { url: getProviderLoginUrl(acc.provider || 'gmail') }).catch(() => { });
      } else {
        await openTabsGrid({
          count: 1,
          provider: acc.provider || 'gmail',
          stagger: true,
          accounts: [acc],
          hGap: q.hGap,
          vGap: q.vGap
        });
      }
    }

    if (q.items.length > 0) {
      q.nextAt = Date.now() + Math.max(1000, Number(q.gapMs || 4000));
      await setSession({ loginQueue: q });
      const waitMs = q.nextAt - Date.now();
      const t = setTimeout(() => { pendingQueueTimers.delete(t); processLoginQueueTick(); }, waitMs);
      pendingQueueTimers.add(t);
      chrome.alarms.create('relay_login_queue', { when: q.nextAt });
    } else {
      await setSession({ loginQueue: null });
    }
  } finally {
    queueTickRunning = false;
  }
}

async function startLoginQueue({ accounts = [], gapSec = 4, assignExistingTabs = false, hGap = 15, vGap = 15 }) {
  for (const t of pendingQueueTimers) clearTimeout(t);
  pendingQueueTimers.clear();
  if (!Array.isArray(accounts) || accounts.length === 0) return { queued: 0 };

  let targetTabs = [];
  if (assignExistingTabs) {
    const allTabs = await chrome.tabs.query({});
    targetTabs = allTabs.filter((t) =>
      /accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.yahoo\.com|about:blank/i.test(t.url || '')
    );
  }

  const items = accounts.map((acc, idx) => ({
    account: acc,
    targetTabId: assignExistingTabs && targetTabs[idx] ? targetTabs[idx].id : null
  }));

  await setSession({
    loginQueue: {
      items,
      gapMs: Math.max(1000, Number(gapSec || 4) * 1000),
      nextAt: Date.now(),
      hGap,
      vGap
    }
  });
  await processLoginQueueTick();
  return { queued: items.length };
}

async function recordVerificationStatus(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return;
  const ses = await getSession(['verificationStatuses']);
  const statuses = ses.verificationStatuses || {};
  statuses[email] = {
    email,
    statusText: payload.statusText || payload.step || payload.status || '',
    severity: payload.severity || 'action',
    code: payload.code || '',
    ts: Date.now()
  };
  await setSession({ verificationStatuses: statuses });
  sendWs({
    type: 'VERIFICATION_STATUS',
    accountId: payload.accountId || email,
    email,
    tabId: payload.tabId,
    statusText: statuses[email].statusText,
    severity: statuses[email].severity,
    code: statuses[email].code
  });
  chrome.runtime.sendMessage({ action: 'VERIFICATION_STATUS_UPDATE', statuses }).catch(() => { });
}

// ── Runtime Message Router (Popup + Content Scripts) ─────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab?.id;

    switch (msg.action) {
      case 'BOOTSTRAP_RPA': {
        const update = {};
        if (msg.accountId) update.rpa_account = msg.accountId;
        if (msg.email) update.rpa_email = msg.email;
        if (msg.wsUrl) update.wsUrl = msg.wsUrl;
        if (Object.keys(update).length > 0) {
          await chrome.storage.local.set(update);
        }
        if (msg.wsUrl) await connectWebSocket(msg.wsUrl);
        else await sendRegisterAgent();
        for (let i = 0; i < 20; i++) {
          const cur = await chrome.storage.local.get(['rpa_password']);
          if (cur.rpa_password) break;
          await sleep(50);
        }
        return sendResponse({ ok: true });
      }

      case 'CDP_CLICK':
        if (!tabId) return sendResponse({ ok: false });
        await cdpClick(tabId, msg.x, msg.y);
        return sendResponse({ ok: true });

      case 'CDP_ENTER':
        if (!tabId) return sendResponse({ ok: false });
        await cdpEnter(tabId);
        return sendResponse({ ok: true });

      case 'CDP_TYPE':
        if (!tabId) return sendResponse({ ok: false });
        await cdpTypeOrganic(tabId, msg.text);
        return sendResponse({ ok: true });

      case 'GENERATE_TOTP': {
        const code = await self.NewShooterTOTP.generateTOTP(msg.secret);
        return sendResponse({ ok: true, code });
      }

      case 'GET_AUTOMATION_SETTINGS': {
        const settings = await self.AutomationSettings.load();
        return sendResponse({ ok: true, settings });
      }

      case 'UPDATE_AUTOMATION_SETTINGS': {
        const settings = await self.AutomationSettings.save(msg.settings || {});
        if (msg.settings && 'wsUrl' in msg.settings && msg.settings.wsUrl) {
          await chrome.storage.local.set({ wsUrl: msg.settings.wsUrl });
          connectWebSocket(msg.settings.wsUrl);
        }
        return sendResponse({ ok: true, settings });
      }

      case 'GET_PENDING_LOGIN': {
        const settings = await self.AutomationSettings.load();
        const ses = await getSession(['pendingLogins']);
        const pending = ses.pendingLogins || {};
        if (tabId && pending[tabId]) {
          return sendResponse({ ok: true, account: pending[tabId], settings });
        }
        const local = await chrome.storage.local.get(['rpa_email', 'rpa_password', 'rpa_recovery', 'rpa_twoFa']);
        if (local.rpa_email && local.rpa_password) {
          return sendResponse({
            ok: true,
            account: {
              email: local.rpa_email,
              password: local.rpa_password,
              recovery: local.rpa_recovery || '',
              twoFa: local.rpa_twoFa || ''
            },
            settings
          });
        }
        return sendResponse({ ok: false, settings });
      }

      case 'INBOX_READY': {
        const [ses, local] = await Promise.all([
          getSession(['tabEmails', 'verificationStatuses', 'tabLiveInfo']),
          chrome.storage.local.get(['rpa_account', 'rpa_email'])
        ]);
        const te = ses.tabEmails || {};
        const resolvedEmail = msg.email || (tabId ? te[tabId] : '') || local.rpa_email || '';
        const liveInfo = ses.tabLiveInfo || {};
        if (tabId) {
          liveInfo[tabId] = {
            status: 'Ready',
            inboxCount: msg.inboxCount || 0,
            draftCount: msg.draftCount || 0,
            sentCount: msg.sentCount || 0,
            spamCount: msg.spamCount || 0,
            provider: msg.provider || detectProviderFromEmail(resolvedEmail),
            isBlocked: Boolean(msg.isBlocked),
            lastUpdated: Date.now()
          };
        }
        if (tabId && resolvedEmail) {
          te[tabId] = resolvedEmail;
          const vs = ses.verificationStatuses || {};
          delete vs[String(resolvedEmail).trim().toLowerCase()];
          await setSession({ tabEmails: te, verificationStatuses: vs, tabLiveInfo: liveInfo });
          chrome.runtime.sendMessage({ action: 'VERIFICATION_STATUS_UPDATE', statuses: vs }).catch(() => { });
        } else if (tabId) {
          await setSession({ tabLiveInfo: liveInfo });
        }
        sendWs({
          type: 'AGENT_INBOX_READY',
          accountId: msg.accountId || local.rpa_account || resolvedEmail,
          tabId,
          email: resolvedEmail,
          provider: msg.provider || 'gmail',
          tabName: sender.tab?.title || resolvedEmail,
          inboxCount: msg.inboxCount || 0,
          draftCount: msg.draftCount || 0,
          sentCount: msg.sentCount || 0,
          spamCount: msg.spamCount || 0,
          isBlocked: Boolean(msg.isBlocked)
        });
        return sendResponse({ ok: true });
      }

      case 'GDS_SKIPPED': {
        const entry = { url: msg.url || '', tabId, ts: Date.now() };
        await setSession({ lastGdsSkipped: entry });
        sendWs({
          type: 'TASK_STATUS_UPDATE',
          tabId,
          status: 'GDS_SKIPPED',
          step: 'GDS Skipped',
          url: entry.url
        });
        return sendResponse({ ok: true, ...entry });
      }

      case 'REPORT_VERIFICATION_STATUS': {
        await recordVerificationStatus({ ...msg, tabId });
        return sendResponse({ ok: true });
      }

      case 'GET_VERIFICATION_STATUSES': {
        const ses = await getSession(['verificationStatuses']);
        return sendResponse({ ok: true, statuses: ses.verificationStatuses || {} });
      }

      case 'CLEAR_VERIFICATION_STATUSES': {
        await setSession({ verificationStatuses: {} });
        return sendResponse({ ok: true, statuses: {} });
      }

      case 'DISPATCH_STATUS':
      case 'TASK_STATUS_UPDATE': {
        const [ses, local] = await Promise.all([
          getSession(['tabEmails', 'tabLiveInfo']),
          chrome.storage.local.get(['rpa_account', 'rpa_email'])
        ]);
        const resolvedEmail = msg.email || (tabId ? ses.tabEmails?.[tabId] : '') || local.rpa_email || '';
        if (tabId) {
          const liveInfo = ses.tabLiveInfo || {};
          liveInfo[tabId] = {
            ...(liveInfo[tabId] || {}),
            status: msg.status || msg.step || 'Active',
            lastUpdated: Date.now()
          };
          await setSession({ tabLiveInfo: liveInfo });
        }
        if (resolvedEmail && (msg.status === 'FAILED' || msg.status === 'BLOCKED')) {
          await recordVerificationStatus({
            email: resolvedEmail,
            tabId,
            statusText: msg.step || msg.errorMessage || msg.status,
            severity: /wrong\s*password|disabled|suspended|deleted|banned/i.test(String(msg.errorMessage || msg.step || '')) ? 'fatal' : 'action',
            code: msg.step
          });
        }
        sendWs({
          type: 'TASK_STATUS_UPDATE',
          taskId: msg.taskId,
          accountId: msg.accountId || local.rpa_account || resolvedEmail,
          email: resolvedEmail,
          tabId,
          step: msg.step,
          status: msg.status,
          errorMessage: msg.errorMessage
        });
        return sendResponse({ ok: true });
      }

      case 'FOLDER_COUNTS_RESULT': {
        const [ses, local] = await Promise.all([
          getSession(['tabEmails', 'tabLiveInfo']),
          chrome.storage.local.get(['rpa_account', 'rpa_email'])
        ]);
        const resolvedEmail = msg.email || (tabId ? ses.tabEmails?.[tabId] : '') || local.rpa_email || '';
        if (tabId) {
          const liveInfo = ses.tabLiveInfo || {};
          liveInfo[tabId] = {
            ...(liveInfo[tabId] || {}),
            inboxCount: msg.inbox ?? 0,
            draftCount: msg.draft ?? 0,
            sentCount: msg.sent ?? 0,
            spamCount: msg.spam ?? 0,
            isBlocked: Boolean(msg.isBlocked),
            lastUpdated: Date.now()
          };
          await setSession({ tabLiveInfo: liveInfo });
        }
        sendWs({
          type: 'FOLDER_COUNTS_RESULT',
          tabId,
          accountId: msg.accountId || local.rpa_account || resolvedEmail,
          email: resolvedEmail,
          inbox: msg.inbox,
          draft: msg.draft,
          sent: msg.sent,
          spam: msg.spam,
          isBlocked: Boolean(msg.isBlocked)
        });
        return sendResponse({ ok: true });
      }

      case 'CAPTCHA_DETECTED': {
        const settings = await self.AutomationSettings.load();
        if (settings.notifyOnCaptcha && chrome.notifications) {
          chrome.notifications.create(`captcha_${tabId || Date.now()}`, {
            type: 'basic',
            iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            title: 'Captcha Detected',
            message: `${msg.email || 'Account'} paused on security challenge.`
          });
        }
        await recordVerificationStatus({
          email: msg.email,
          accountId: msg.accountId,
          tabId,
          statusText: 'Captcha',
          severity: 'action',
          code: 'CAPTCHA'
        });
        sendWs({
          type: 'TASK_STATUS_UPDATE',
          accountId: msg.accountId || msg.email,
          tabId,
          status: 'BLOCKED',
          step: 'Captcha Required'
        });
        let closed = false;
        if (settings.closeOnCaptcha && !settings.disableTabCloseOnError && tabId) {
          await chrome.tabs.remove(tabId).catch(() => { });
          closed = true;
        }
        return sendResponse({ ok: true, settings, closed });
      }

      case 'CAPTCHA_RESOLVED': {
        const settings = await self.AutomationSettings.load();
        if (settings.notifyOnCaptcha && chrome.notifications) {
          chrome.notifications.create(`captcha_ok_${tabId || Date.now()}`, {
            type: 'basic',
            iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            title: 'Captcha Solved',
            message: `${msg.email || 'Account'} continuing login.`
          });
        }
        if (msg.email) {
          const ses = await getSession(['verificationStatuses']);
          const vs = ses.verificationStatuses || {};
          delete vs[String(msg.email).trim().toLowerCase()];
          await setSession({ verificationStatuses: vs });
          chrome.runtime.sendMessage({ action: 'VERIFICATION_STATUS_UPDATE', statuses: vs }).catch(() => { });
        }
        return sendResponse({ ok: true });
      }

      // SMS Verification Pool Messages
      case 'SMS_POOL_SYNC': {
        const result = verificationPool.syncFromString(msg.raw || '');
        await saveVerificationPool();
        return sendResponse({ ok: true, result, stats: verificationPool.getStats(), items: verificationPool.toJSON() });
      }
      case 'SMS_POOL_STATE':
        return sendResponse({ ok: true, stats: verificationPool.getStats(), items: verificationPool.toJSON(), raw: verificationPool.toInputString() });
      case 'SMS_POOL_CLEAR':
        verificationPool = new self.Verification();
        await saveVerificationPool();
        return sendResponse({ ok: true, stats: verificationPool.getStats(), items: [] });
      case 'SMS_POOL_RESET_ERRORS':
        verificationPool.resetPermanentErrors();
        await saveVerificationPool();
        return sendResponse({ ok: true, stats: verificationPool.getStats(), items: verificationPool.toJSON() });
      case 'SMS_POOL_CLAIM': {
        const item = verificationPool.getNextAvailable(msg.email);
        await saveVerificationPool();
        if (tabId && msg.email) {
          const ses = await getSession(['tabEmails']);
          const te = ses.tabEmails || {};
          te[tabId] = msg.email;
          await setSession({ tabEmails: te });
        }
        return sendResponse({ ok: Boolean(item), item });
      }
      case 'SMS_POOL_VERIFY':
        verificationPool.markVerified(msg.phone);
        await saveVerificationPool();
        return sendResponse({ ok: true });
      case 'SMS_POOL_ERROR':
        verificationPool.markPermanentError(msg.phone, msg.error);
        await saveVerificationPool();
        return sendResponse({ ok: true });
      case 'SMS_POOL_RELEASE': {
        if (msg.phone) verificationPool.release(msg.phone);
        else if (msg.email) verificationPool.releaseByEmail(msg.email);
        await saveVerificationPool();
        return sendResponse({ ok: true });
      }
      case 'FETCH_SMS_OTP': {
        try {
          const resp = await fetch(msg.url);
          const text = await resp.text();
          const match = text.match(/[Gg][-\s]?(\d{6})/) || text.match(/\b(\d{6})\b/);
          return sendResponse({ ok: Boolean(match), code: match ? match[1] : null, body: text.slice(0, 500) });
        } catch (err) {
          return sendResponse({ ok: false, error: err.message });
        }
      }

      // Popup Controls
      case 'OPEN_TABS_GRID':
        return sendResponse({ ok: true, opened: await openTabsGrid(msg) });

      case 'GET_OPEN_TABS': {
        const [tabs, ses] = await Promise.all([
          chrome.tabs.query({}),
          getSession(['pendingLogins', 'tabEmails', 'verificationStatuses', 'tabLiveInfo'])
        ]);
        const pending = ses.pendingLogins || {};
        const emails = ses.tabEmails || {};
        const liveInfo = ses.tabLiveInfo || {};
        return sendResponse({
          ok: true,
          statuses: ses.verificationStatuses || {},
          tabs: tabs.map((t) => {
            const email = emails[t.id] || pending[t.id]?.email || '';
            const info = liveInfo[t.id] || {};
            return {
              id: t.id,
              tabId: t.id,
              windowId: t.windowId,
              title: t.title,
              url: t.url,
              active: t.active,
              email,
              provider: info.provider || detectProviderFromEmail(email || t.url),
              status: info.status || 'Active',
              inboxCount: info.inboxCount ?? 0
            };
          })
        });
      }

      case 'FOCUS_TAB': {
        if (msg.windowId) await chrome.windows.update(Number(msg.windowId), { focused: true }).catch(() => { });
        if (msg.tabId) await chrome.tabs.update(Number(msg.tabId), { active: true }).catch(() => { });
        return sendResponse({ ok: true });
      }

      case 'RELOAD_TAB': {
        if (msg.tabId) await chrome.tabs.reload(Number(msg.tabId)).catch(() => { });
        return sendResponse({ ok: true });
      }

      case 'CLOSE_TAB': {
        if (msg.tabId) await chrome.tabs.remove(Number(msg.tabId)).catch(() => { });
        return sendResponse({ ok: true });
      }

      case 'MAXIMIZE_TAB_WINDOW': {
        let winId = msg.windowId ? Number(msg.windowId) : null;
        if (!winId && msg.tabId) {
          const tab = await chrome.tabs.get(Number(msg.tabId)).catch(() => null);
          if (tab?.windowId) winId = tab.windowId;
        }
        if (winId) {
          await chrome.windows.update(winId, { state: 'maximized', focused: true }).catch(() => { });
        }
        return sendResponse({ ok: true, windowId: winId });
      }

      case 'PING_TABS': {
        const [tabs, ses, local] = await Promise.all([
          chrome.tabs.query({}),
          getSession(['pendingLogins', 'tabEmails', 'verificationStatuses', 'tabLiveInfo']),
          chrome.storage.local.get(['rpa_account', 'rpa_email'])
        ]);
        const pending = ses.pendingLogins || {};
        const emails = ses.tabEmails || {};
        const vs = ses.verificationStatuses || {};
        const liveInfo = ses.tabLiveInfo || {};

        const tabList = tabs.map((t) => {
          const email = emails[t.id] || pending[t.id]?.email || (t.title?.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0]) || '';
          const info = liveInfo[t.id] || {};
          const verif = vs[String(email).trim().toLowerCase()];
          const provider = info.provider || detectProviderFromEmail(email || t.url);
          let status = info.status || 'Active';
          if (verif) {
            status = verif.statusText || 'Verification';
          } else if (/accounts\.google\.com|login\.live\.com|login\.yahoo\.com/i.test(t.url || '')) {
            status = 'Logging in';
          } else if (/mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com/i.test(t.url || '')) {
            status = info.status || 'Ready';
          }

          return {
            tabId: t.id,
            id: t.id,
            windowId: t.windowId,
            email,
            provider,
            tabName: t.title || email || 'Mail Tab',
            title: t.title || '',
            url: t.url || '',
            active: Boolean(t.active),
            status,
            inboxCount: info.inboxCount ?? 0,
            draftCount: info.draftCount ?? 0,
            sentCount: info.sentCount ?? 0,
            spamCount: info.spamCount ?? 0
          };
        });

        return sendResponse({
          ok: true,
          tabs: tabList,
          total: tabList.length,
          timestamp: Date.now()
        });
      }

      case 'REORDER_TABS': {
        const [allWindows, ses] = await Promise.all([
          chrome.windows.getAll({ populate: true }).catch(() => []),
          getSession(['pendingLogins', 'tabEmails'])
        ]);
        const pending = ses.pendingLogins || {};
        const emails = ses.tabEmails || {};
        const popupUrl = chrome.runtime.getURL('popup/popup.html');

        const mailItems = [];
        for (const win of allWindows) {
          if (!win.tabs || win.tabs.length === 0) continue;
          if (win.tabs.some((t) => t.url && (t.url.startsWith(popupUrl) || t.url.includes('popup/popup.html')))) {
            continue;
          }
          for (const t of win.tabs) {
            if (/mail\.google\.com|accounts\.google\.com|outlook\.(live|office|office365)\.com|login\.live\.com|login\.microsoftonline\.com|mail\.yahoo\.com|login\.yahoo\.com/i.test(t.url || '')) {
              const email = (emails[t.id] || pending[t.id]?.email || '').toLowerCase();
              mailItems.push({
                windowId: win.id,
                tab: t,
                email,
                url: t.url || ''
              });
            }
          }
        }

        mailItems.sort((a, b) => {
          if (a.email && b.email) {
            const cmp = a.email.localeCompare(b.email);
            if (cmp !== 0) return cmp;
          } else if (a.email && !b.email) {
            return -1;
          } else if (!a.email && b.email) {
            return 1;
          }
          return (a.url || '').localeCompare(b.url || '');
        });

        const availW = Math.max(640, Number(msg.screenWidth || 1440));
        const availH = Math.max(520, Number(msg.screenHeight || 900));
        const count = mailItems.length;

        for (let i = 0; i < count; i++) {
          const item = mailItems[i];
          let left, top, w, h;
          if (msg.layout === 'tile') {
            const cols = Math.ceil(Math.sqrt(count));
            const rows = Math.ceil(count / cols);
            w = Math.max(240, Math.floor(availW / cols));
            h = Math.max(240, Math.floor(availH / rows));
            const col = i % cols;
            const row = Math.floor(i / cols);
            left = Math.max(0, Math.min(availW - w, col * w));
            top = Math.max(0, Math.min(availH - h, row * h));
          } else {
            // Diagonal staggered positioning: left = baseX + i * 36, top = baseY + i * 36
            const baseX = Number(msg.baseX || 0);
            const baseY = Number(msg.baseY || 0);
            w = Math.max(320, Math.min(availW - 100, Math.round(availW * 0.45)));
            h = Math.max(320, Math.min(availH - 100, Math.round(availH * 0.55)));
            const maxL = Math.max(100, availW - Math.ceil(w * 0.5));
            const maxT = Math.max(100, availH - Math.ceil(h * 0.5));
            left = (baseX + i * 36) % maxL;
            top = (baseY + i * 36) % maxT;
          }

          await chrome.windows.update(item.windowId, {
            left,
            top,
            width: w,
            height: h,
            focused: i === 0
          }).catch(() => { });
          await chrome.tabs.move(item.tab.id, { index: i }).catch(() => { });
        }

        return sendResponse({ ok: true, reordered: count });
      }

      case 'RELOAD_ALL_TABS': {
        const tabs = await chrome.tabs.query({}).catch(() => []);
        const mailTabs = tabs.filter((t) =>
          /mail\.google\.com|accounts\.google\.com|outlook\.(live|office|office365)\.com|login\.live\.com|login\.microsoftonline\.com|mail\.yahoo\.com|login\.yahoo\.com/i.test(t.url || '')
        );
        await Promise.all(mailTabs.map((t) => chrome.tabs.reload(t.id).catch(() => { })));
        return sendResponse({ ok: true, reloaded: mailTabs.length });
      }

      case 'CLOSE_ALL_MAIL_TABS': {
        const tabs = await chrome.tabs.query({}).catch(() => []);
        for (const t of tabs) {
          if (/google|outlook|yahoo|live\.com|microsoftonline/i.test(t.url || '')) {
            await chrome.tabs.remove(t.id).catch(() => { });
          }
        }
        return sendResponse({ ok: true });
      }

      case 'LOGOUT_ALL_ACCOUNTS': {
        const domains = [
          'google.com', 'accounts.google.com', 'mail.google.com',
          'live.com', 'login.live.com', 'microsoftonline.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
          'yahoo.com', 'login.yahoo.com', 'mail.yahoo.com'
        ];
        let removed = 0;
        for (const domain of domains) {
          const list = await chrome.cookies.getAll({ domain }).catch(() => []);
          await Promise.all((list || []).map((c) => {
            const proto = c.secure ? 'https' : 'http';
            const host = String(c.domain || domain).replace(/^\./, '');
            const url = `${proto}://${host}${c.path || '/'}`;
            removed += 1;
            return chrome.cookies.remove({ url, name: c.name }).catch(() => { });
          }));
        }

        const tabs = await chrome.tabs.query({}).catch(() => []);
        let redirected = 0;
        for (const t of tabs) {
          const url = t.url || '';
          let targetLoginUrl = null;
          if (/google\.com|mail\.google\.com|accounts\.google\.com/i.test(url)) {
            targetLoginUrl = 'https://accounts.google.com/';
          } else if (/outlook\.(live|office|office365)\.com|login\.live\.com|login\.microsoftonline\.com|live\.com/i.test(url)) {
            targetLoginUrl = 'https://login.live.com/';
          } else if (/yahoo\.com|mail\.yahoo\.com|login\.yahoo\.com/i.test(url)) {
            targetLoginUrl = 'https://login.yahoo.com/';
          }
          if (targetLoginUrl) {
            await chrome.tabs.update(t.id, { url: targetLoginUrl }).catch(() => { });
            redirected += 1;
          }
        }

        await setSession({ pendingLogins: {}, tabEmails: {}, verificationStatuses: {} });
        chrome.runtime.sendMessage({ action: 'VERIFICATION_STATUS_UPDATE', statuses: {} }).catch(() => { });

        return sendResponse({ ok: true, removed, redirected });
      }

      case 'SET_STANDALONE_PROXY':
        return sendResponse({ ok: true, config: await applyStandaloneProxy(msg.proxy) });

      case 'START_LOGIN_QUEUE': {
        const res = await startLoginQueue({
          accounts: msg.accounts,
          gapSec: msg.gapSec,
          assignExistingTabs: Boolean(msg.assignExistingTabs),
          hGap: msg.hGap,
          vGap: msg.vGap
        });
        return sendResponse({ ok: true, ...res });
      }

      case 'GET_WS_STATUS':
        return sendResponse({
          ok: true,
          connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
          wsUrl: currentWsUrl || DEFAULT_WS_URL
        });

      case 'LAUNCH_ISOLATED_ACCOUNTS': {
        const accountCount = Math.max(1, Array.isArray(msg.accounts) ? msg.accounts.length : 1);
        const timeoutMs = Math.max(60000, accountCount * 45000);
        const res = await sendWsRequest({
          type: 'LAUNCH_ISOLATED_ACCOUNTS',
          bulk: msg.bulk || '',
          accounts: msg.accounts || [],
          defaultProxy: msg.defaultProxy || '',
          headless: msg.headless,
          startUrl: msg.startUrl,
          ipCheckUrl: msg.ipCheckUrl,
          wsUrl: msg.wsUrl
        }, timeoutMs);
        return sendResponse(res);
      }

      default:
        return sendResponse({ ok: false, error: 'Unknown action' });
    }
  })().catch((err) => {
    try { sendResponse({ ok: false, error: err.message }); } catch { }
  });
  return true; // keep channel open for async response
});
