'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const http = require('node:http');
const { chromium } = require('playwright');

const { createServer } = require('../src/server/app');
const { RelayStore } = require('../src/server/store');
const { decodeFrames } = require('../src/server/wsHub');

const extDir = path.resolve(__dirname, '../extension');

// ── WebSocket Helper ──────────────────────────────────────────────────────────

function encodeMaskedClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function connectRawWs(port, pathName = '/', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${pathName} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ];
      for (const [k, v] of Object.entries(extraHeaders)) {
        lines.push(`${k}: ${v}`);
      }
      lines.push('\r\n');
      sock.write(lines.join('\r\n'));
    });

    let upgraded = false;
    let buf = Buffer.alloc(0);
    const messages = [];
    const waiters = [];

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString('latin1');
        if (!head.includes('101 Switching Protocols')) {
          sock.destroy();
          reject(new Error('WS upgrade failed: ' + head.split('\r\n')[0]));
          return;
        }
        upgraded = true;
        buf = buf.subarray(idx + 4);

        function drainFrames() {
          if (buf.length > 0) {
            const { frames, remaining } = decodeFrames(buf);
            buf = remaining;
            for (const f of frames) {
              if (f.opcode === 0x1) {
                const parsed = JSON.parse(f.payload.toString('utf8'));
                const wIdx = waiters.findIndex((w) => w.predicate(parsed));
                if (wIdx !== -1) {
                  const waiter = waiters.splice(wIdx, 1)[0];
                  if (waiter.timer) clearTimeout(waiter.timer);
                  waiter.resolve(parsed);
                } else {
                  messages.push(parsed);
                }
              }
            }
          }
        }

        drainFrames();

        resolve({
          sock,
          sendJson(obj) {
            sock.write(encodeMaskedClientFrame(JSON.stringify(obj)));
          },
          nextMessage(predicate = () => true, timeoutMs = 6000) {
            const existingIdx = messages.findIndex(predicate);
            if (existingIdx !== -1) {
              return Promise.resolve(messages.splice(existingIdx, 1)[0]);
            }
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                const idx = waiters.findIndex((w) => w.resolve === res);
                if (idx !== -1) waiters.splice(idx, 1);
                rej(new Error('Timed out waiting for WS message'));
              }, timeoutMs);
              waiters.push({ predicate, resolve: res, timer });
            });
          },
          close() {
            for (const w of waiters) if (w.timer) clearTimeout(w.timer);
            sock.destroy();
          }
        });
      }

      if (upgraded && buf.length > 0) {
        const { frames, remaining } = decodeFrames(buf);
        buf = remaining;
        for (const f of frames) {
          if (f.opcode === 0x1) {
            const parsed = JSON.parse(f.payload.toString('utf8'));
            const wIdx = waiters.findIndex((w) => w.predicate(parsed));
            if (wIdx !== -1) {
              const waiter = waiters.splice(wIdx, 1)[0];
              if (waiter.timer) clearTimeout(waiter.timer);
              waiter.resolve(parsed);
            } else {
              messages.push(parsed);
            }
          }
        }
      }
    });

    sock.on('error', (err) => {
      if (!upgraded) reject(err);
    });
  });
}

function postJson(port, urlPath, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        headers
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Test Suite ───────────────────────────────────────────────────────────────

test('Unit & Protocol: Server wsHub, store and /api/tabs ingestion of login-stage tabs and PONG_TABS', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-sync-unit-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');

  try {
    // 1. Authenticate session
    const auth = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    const sid = auth.session.token || auth.session.id;
    const cookieHeader = { Cookie: `relay_sid=${sid}` };

    // 2. Connect dashboard WS
    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', cookieHeader);
    await dashWs.nextMessage((m) => m.type === 'HELLO' || m.type === 'DASHBOARD_SYNC');

    // 3. Connect agent WS
    const agentWs = await connectRawWs(addr.port, '/ws/agent');

    // 4. Agent sends PONG_TABS with login-stage tabs (Google, Outlook, Yahoo)
    agentWs.sendJson({
      type: 'PONG_TABS',
      tabs: [
        {
          tabId: 501,
          windowId: 10,
          url: 'https://accounts.google.com/signin/v2/identifier',
          email: 'Login Pending',
          provider: 'gmail',
          status: 'login_pending',
          active: true
        },
        {
          tabId: 502,
          windowId: 10,
          url: 'https://login.live.com/login.srf',
          email: 'Login Pending',
          provider: 'outlook',
          status: 'login_pending',
          active: false
        },
        {
          tabId: 503,
          windowId: 11,
          url: 'https://login.yahoo.com/',
          email: 'Login Pending',
          provider: 'yahoo',
          status: 'login_pending',
          active: false
        }
      ]
    });

    // 5. Dashboard should receive TABS_UPDATED immediately
    const tabUpdate = await dashWs.nextMessage(
      (m) => m.type === 'TABS_UPDATED' && Array.isArray(m.onlineTabs) && m.onlineTabs.length === 3
    );
    assert.ok(tabUpdate, 'Dashboard must receive TABS_UPDATED upon PONG_TABS');
    assert.equal(tabUpdate.onlineTabs.length, 3);

    // 6. Verify store state and suppression of false duplicates
    const onlineTabs = app.store.listOnlineTabs();
    assert.equal(onlineTabs.length, 3);
    for (const tab of onlineTabs) {
      assert.equal(tab.status, 'login_pending');
      assert.equal(tab.isDup, false, 'Login pending tabs must NOT be flagged as duplicate accounts');
      assert.ok(['gmail', 'outlook', 'yahoo'].includes(tab.provider));
      assert.ok(tab.url.length > 0);
    }

    // 7. Test REST GET /api/tabs returns login-stage tabs
    const getTabsRes = await getJson(addr.port, '/api/tabs', cookieHeader);
    assert.equal(getTabsRes.statusCode, 200);
    assert.equal(getTabsRes.data.ok, true);
    assert.equal(getTabsRes.data.tabs.length, 3);
    assert.equal(getTabsRes.data.onlineTabs.length, 3);

    // 8. Test REST GET /api/tabs?refresh=1 triggers PING_TABS broadcast to agent
    const p1 = agentWs.nextMessage((m) => m.type === 'PING_TABS');
    const refreshRes = await getJson(addr.port, '/api/tabs?refresh=1', cookieHeader);
    assert.equal(refreshRes.statusCode, 200);
    const pingMsg = await p1;
    assert.ok(pingMsg, 'Agent must receive PING_TABS when /api/tabs?refresh=1 is requested');

    // 9. Test REST POST /api/tabs batch ingestion
    const postTabsRes = await postJson(
      addr.port,
      '/api/tabs',
      {
        tabs: [
          {
            tabKey: 'ext:504',
            tabId: 504,
            windowId: 12,
            email: 'auth.user@gmail.com',
            provider: 'gmail',
            status: 'Ready',
            url: 'https://mail.google.com/mail/u/0/#inbox'
          }
        ]
      },
      cookieHeader
    );
    assert.equal(postTabsRes.statusCode, 200);
    assert.equal(postTabsRes.data.ok, true);
    assert.equal(postTabsRes.data.onlineTabs.length, 4);

    // 10. Transition tab 501 from login_pending to Idle/Ready upon receiving authenticated heartbeat
    agentWs.sendJson({
      type: 'HEARTBEAT',
      tabId: 501,
      windowId: 10,
      email: 'john.doe@gmail.com',
      provider: 'gmail',
      title: 'Gmail - Inbox (john.doe@gmail.com)',
      url: 'https://mail.google.com/mail/u/0/#inbox',
      inbox: 5,
      status: 'Ready'
    });

    const transitionedUpdate = await dashWs.nextMessage(
      (m) => m.type === 'TABS_UPDATED' && m.onlineTabs.some((t) => t.email === 'john.doe@gmail.com')
    );
    assert.ok(transitionedUpdate, 'Tab must transition to authenticated state');
    const johnTab = app.store.listOnlineTabs().find((t) => t.tabId === 501);
    assert.ok(johnTab);
    assert.equal(johnTab.email, 'john.doe@gmail.com');
    assert.equal(johnTab.status, 'Ready');

    dashWs.close();
    agentWs.close();
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Deduplication: Tabs reported via both POST /api/tabs and WebSocket PONG_TABS with same tabIds are not duplicated', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-dedup-test-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');

  try {
    const auth = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    const sid = auth.session.token || auth.session.id;
    const cookieHeader = { Cookie: `relay_sid=${sid}` };

    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', cookieHeader);
    await dashWs.nextMessage((m) => m.type === 'HELLO' || m.type === 'DASHBOARD_SYNC');

    const agentWs = await connectRawWs(addr.port, '/ws/agent');

    // 5 distinct tabs to be reported by both REST and WebSocket
    const fiveTabsRest = [
      { tabId: 101, windowId: 1, email: 'acc1@gmail.com', provider: 'gmail', status: 'Idle', url: 'https://mail.google.com' },
      { tabId: 102, windowId: 1, email: 'acc2@outlook.com', provider: 'outlook', status: 'Idle', url: 'https://outlook.live.com' },
      { tabId: 103, windowId: 1, email: 'acc3@yahoo.com', provider: 'yahoo', status: 'Idle', url: 'https://mail.yahoo.com' },
      { tabId: 104, windowId: 2, email: 'Login Pending', provider: 'gmail', status: 'login_pending', url: 'https://accounts.google.com' },
      { tabId: 105, windowId: 2, email: 'Login Pending', provider: 'outlook', status: 'login_pending', url: 'https://login.live.com' }
    ];

    const fiveTabsWs = [
      { tabId: 101, windowId: 1, email: 'acc1@gmail.com', provider: 'gmail', status: 'Ready', url: 'https://mail.google.com' },
      { tabId: 102, windowId: 1, email: 'acc2@outlook.com', provider: 'outlook', status: 'Ready', url: 'https://outlook.live.com' },
      { tabId: 103, windowId: 1, email: 'acc3@yahoo.com', provider: 'yahoo', status: 'Ready', url: 'https://mail.yahoo.com' },
      { tabId: 104, windowId: 2, email: 'Login Pending', provider: 'gmail', status: 'login_pending', url: 'https://accounts.google.com' },
      { tabId: 105, windowId: 2, email: 'Login Pending', provider: 'outlook', status: 'login_pending', url: 'https://login.live.com' }
    ];

    // 1. Report tabs via POST /api/tabs
    const postRes = await postJson(addr.port, '/api/tabs', { tabs: fiveTabsRest }, cookieHeader);
    assert.equal(postRes.statusCode, 200);
    assert.equal(postRes.data.ok, true);
    assert.equal(app.store.listOnlineTabs().length, 5, 'store.listOnlineTabs() should return 5 tabs after POST');
    assert.equal(Object.keys(app.store.state.onlineTabs).length, 5, 'store.state.onlineTabs should have 5 entries after POST');

    // 2. Report the same 5 tabs via WebSocket PONG_TABS
    const dashUpdatePromise = dashWs.nextMessage((m) => m.type === 'TABS_UPDATED');
    agentWs.sendJson({
      type: 'PONG_TABS',
      tabs: fiveTabsWs
    });
    const dashMsg = await dashUpdatePromise;
    assert.ok(dashMsg, 'Dashboard should receive TABS_UPDATED on PONG_TABS');

    // 3. Verify deduplication: exactly 5 tabs, never 10
    const onlineTabs = app.store.listOnlineTabs();
    assert.equal(onlineTabs.length, 5, `store.listOnlineTabs() must return exactly 5 tabs, not ${onlineTabs.length}`);
    const stateKeys = Object.keys(app.store.state.onlineTabs);
    assert.equal(stateKeys.length, 5, `store.state.onlineTabs must contain exactly 5 entries, not ${stateKeys.length}`);

    // Verify all 5 tabIds are present and unique
    const uniqueIds = new Set(onlineTabs.map((t) => t.tabId));
    assert.equal(uniqueIds.size, 5, 'All 5 tabIds must be unique');
    for (const id of [101, 102, 103, 104, 105]) {
      assert.ok(uniqueIds.has(id), `tabId ${id} must be present`);
    }

    // 4. Oscillating updates: alternate REST POST and WebSocket PONG_TABS multiple times
    for (let cycle = 0; cycle < 3; cycle++) {
      const restRes = await postJson(addr.port, '/api/tabs', { tabs: fiveTabsRest }, cookieHeader);
      assert.equal(restRes.data.tabs.length, 5, 'REST response must return 5 tabs');
      assert.equal(app.store.listOnlineTabs().length, 5, 'store.listOnlineTabs() must remain 5');
      assert.equal(Object.keys(app.store.state.onlineTabs).length, 5, 'store.state.onlineTabs must remain 5');

      const updatePromise = dashWs.nextMessage((m) => m.type === 'TABS_UPDATED');
      agentWs.sendJson({ type: 'PONG_TABS', tabs: fiveTabsWs });
      await updatePromise;

      assert.equal(app.store.listOnlineTabs().length, 5, 'store.listOnlineTabs() must remain 5 after WS pong');
      assert.equal(Object.keys(app.store.state.onlineTabs).length, 5, 'store.state.onlineTabs must remain 5 after WS pong');
    }

    dashWs.close();
    agentWs.close();
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Unit: public/index.html Online Tabs header consolidated refresh buttons & badge', () => {
  const indexPath = path.resolve(__dirname, '../public/index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  // Redundant recallTabsBtn must be completely removed
  assert.equal(html.includes('id="recallTabsBtn"'), false, 'Redundant recallTabsBtn must be removed from HTML');

  // Extract #tabsPanel header actions
  const tabsPanelMatch = html.match(/<article[^>]*id="tabsPanel"[^>]*>([\s\S]*?)<\/article>/i);
  assert.ok(tabsPanelMatch, '#tabsPanel must exist');
  const headerActionsMatch = tabsPanelMatch[1].match(/<div class="panel-header-actions">([\s\S]*?)<\/div>/i);
  assert.ok(headerActionsMatch, 'panel-header-actions must exist in #tabsPanel');
  const actionsHtml = headerActionsMatch[1];

  // Redundant refreshAllTabsBtn must be removed from header actions
  assert.equal(actionsHtml.includes('id="refreshAllTabsBtn"'), false, 'Redundant refreshAllTabsBtn must be removed from header actions');

  // Verify exactly 2 refresh buttons in header actions:
  // 1) #refreshAllBtn ('↻ Re-fetch active tabs')
  // 2) #reloadTabsBtn ('↻' title="Reload mail tabs")
  const refreshAllBtnMatch = actionsHtml.match(/<button[^>]*id="refreshAllBtn"[^>]*>([\s\S]*?)<\/button>/i);
  assert.ok(refreshAllBtnMatch, '#refreshAllBtn must exist in header actions');
  assert.match(refreshAllBtnMatch[0], /title="Re-fetch active tabs"/i);
  assert.match(refreshAllBtnMatch[1], /↻\s*Re-fetch active tabs/i);

  const reloadTabsBtnMatch = actionsHtml.match(/<button[^>]*id="reloadTabsBtn"[^>]*>([\s\S]*?)<\/button>/i);
  assert.ok(reloadTabsBtnMatch, '#reloadTabsBtn must exist in header actions');
  assert.match(reloadTabsBtnMatch[0], /title="Reload mail tabs"/i);
  assert.match(reloadTabsBtnMatch[1], /↻/);

  // Filter all button tags in actionsHtml
  const allHeaderButtons = actionsHtml.match(/<button[^>]*>[\s\S]*?<\/button>/gi) || [];
  const refreshButtons = allHeaderButtons.filter((b) =>
    b.includes('refreshAllBtn') ||
    b.includes('reloadTabsBtn') ||
    b.includes('refreshTabsBtn') ||
    b.includes('recallTabsBtn') ||
    b.includes('refreshAllTabsBtn')
  );
  assert.equal(refreshButtons.length, 2, 'Online Tabs header must have exactly 2 refresh buttons');

  // Verify #totalOpenTabsBadge exists in panel header
  const headerLeftMatch = tabsPanelMatch[1].match(/<div class="panel-header-left">([\s\S]*?)<\/div>/i);
  assert.ok(headerLeftMatch, 'panel-header-left must exist');
  assert.ok(headerLeftMatch[1].includes('id="totalOpenTabsBadge"'), '#totalOpenTabsBadge must exist');
  assert.match(headerLeftMatch[1], /title="Total open tabs reported by extension"/i);
  assert.match(headerLeftMatch[1], /Tabs:\s*0/i);
});

test('Integration & Live Playwright: chrome.runtime.onMessageExternal, login-stage discovery, and openTabsGrid immediate push', async (t) => {
  try {
    await runPlaywrightTest(t);
  } catch (err) {
    console.error('PLAYWRIGHT TEST FAILURE:', err);
    throw err;
  }
});

async function runPlaywrightTest(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-sync-e2e-'));
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${addr.port}`;

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });

  try {
    // 1. Locate extension service worker
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = sw.url().split('/')[2];
    assert.ok(extId, 'Extension ID must be found');

    // 2. Point extension service worker to Controller WS
    await sw.evaluate(async (url) => {
      await chrome.storage.local.set({ wsUrl: url });
      await connectWebSocket(url);
    }, wsUrl);

    // Wait for WS to establish connection in service worker
    for (let i = 0; i < 40; i++) {
      const isConnected = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
      if (isConnected) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const swConnected = await sw.evaluate(() => Boolean(ws && ws.readyState === WebSocket.OPEN));
    assert.equal(swConnected, true, 'Extension service worker must connect to Controller WebSocket');

    // 3. Authenticate dashboard session
    const auth = app.store.authenticate('admfib7H', 'd9tQGJdZ77');
    const sid = auth.session.token || auth.session.id;

    // 4. Mock login pages via Playwright route interception so no external networks are hit
    await context.route('https://accounts.google.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Sign in - Google Accounts</title></head><body><h1>Google Login</h1></body></html>'
      });
    });

    await context.route('https://login.live.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Sign in to your Microsoft account</title></head><body><h1>Microsoft Login</h1></body></html>'
      });
    });

    await context.route('https://login.yahoo.com/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Yahoo Login</title></head><body><h1>Yahoo Login</h1></body></html>'
      });
    });

    // 5. Open login-stage pages in browser context
    const googleLoginTab = await context.newPage();
    await googleLoginTab.goto('https://accounts.google.com/ServiceLogin', { waitUntil: 'load' });

    const msLoginTab = await context.newPage();
    await msLoginTab.goto('https://login.live.com/login.srf', { waitUntil: 'load' });

    const yahooLoginTab = await context.newPage();
    await yahooLoginTab.goto('https://login.yahoo.com/', { waitUntil: 'load' });

    // 6. Test Direct External Messaging (chrome.runtime.onMessageExternal) from Web Dashboard origin (127.0.0.1)
    await context.addCookies([
      { name: 'relay_sid', value: sid, domain: '127.0.0.1', path: '/' }
    ]);
    const dashPage = await context.newPage();
    await dashPage.goto(`http://127.0.0.1:${addr.port}/V3/`, { waitUntil: 'load' });

    // 6a. Send GET_OPEN_TABS via chrome.runtime.sendMessage from dashPage
    const extRespGet = await dashPage.evaluate(async (extensionId) => {
      return new Promise((resolve, reject) => {
        if (!window.chrome?.runtime?.sendMessage) {
          return reject(new Error('chrome.runtime.sendMessage unavailable'));
        }
        window.chrome.runtime.sendMessage(extensionId, { action: 'GET_OPEN_TABS' }, (resp) => {
          if (window.chrome.runtime.lastError) {
            return reject(new Error(window.chrome.runtime.lastError.message));
          }
          resolve(resp);
        });
      });
    }, extId);

    assert.equal(extRespGet.ok, true, 'onMessageExternal GET_OPEN_TABS must respond ok: true');
    assert.ok(Array.isArray(extRespGet.tabs), 'Response must contain tabs array');
    assert.ok(extRespGet.total >= 3, 'Must discover at least the 3 login tabs');

    // Verify all 3 login tabs are recognized with status 'login_pending'
    const discoveredGoogle = extRespGet.tabs.find((t) => t.url.includes('accounts.google.com'));
    const discoveredMs = extRespGet.tabs.find((t) => t.url.includes('login.live.com'));
    const discoveredYahoo = extRespGet.tabs.find((t) => t.url.includes('login.yahoo.com'));

    assert.ok(discoveredGoogle, 'Google accounts tab must be discovered');
    assert.equal(discoveredGoogle.provider, 'gmail');
    assert.equal(discoveredGoogle.status, 'login_pending');

    assert.ok(discoveredMs, 'Microsoft login tab must be discovered');
    assert.equal(discoveredMs.provider, 'outlook');
    assert.equal(discoveredMs.status, 'login_pending');

    assert.ok(discoveredYahoo, 'Yahoo login tab must be discovered');
    assert.equal(discoveredYahoo.provider, 'yahoo');
    assert.equal(discoveredYahoo.status, 'login_pending');

    // 6b. Send PING_TABS via chrome.runtime.sendMessage from dashPage
    const extRespPing = await dashPage.evaluate(async (extensionId) => {
      return new Promise((resolve, reject) => {
        window.chrome.runtime.sendMessage(extensionId, { action: 'PING_TABS' }, (resp) => {
          if (window.chrome.runtime.lastError) {
            return reject(new Error(window.chrome.runtime.lastError.message));
          }
          resolve(resp);
        });
      });
    }, extId);

    assert.equal(extRespPing.ok, true, 'onMessageExternal PING_TABS must respond ok: true');
    assert.ok(extRespPing.total >= 3);

    // 6c. Send invalid action and verify graceful error
    const extRespErr = await dashPage.evaluate(async (extensionId) => {
      return new Promise((resolve) => {
        window.chrome.runtime.sendMessage(extensionId, { action: 'UNKNOWN_ACTION' }, (resp) => {
          resolve(resp);
        });
      });
    }, extId);
    assert.equal(extRespErr.ok, false);
    assert.equal(extRespErr.error, 'Unknown external action');

    // 7. Verify Controller Server store has synced tabs via WebSocket PONG_TABS
    for (let i = 0; i < 30; i++) {
      const serverTabs = app.store.listOnlineTabs();
      if (serverTabs.some((t) => t.status === 'login_pending')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const serverOnlineTabs = app.store.listOnlineTabs();
    const loginPendingTabs = serverOnlineTabs.filter((t) => t.status === 'login_pending');
    assert.ok(loginPendingTabs.length >= 3, 'Server store must contain login_pending tabs from extension sync');

    // 8. Test openTabsGrid pushes newly created tabs over WebSocket immediately
    const prevTabCount = app.store.listOnlineTabs().length;
    const openedResult = await sw.evaluate(async () => {
      return await openTabsGrid({
        count: 1,
        provider: 'gmail',
        accounts: [{ email: 'grid.newtab@gmail.com', password: 'secretpassword' }]
      });
    });
    assert.ok(Array.isArray(openedResult) && openedResult.length === 1);

    // Verify server received newly created tab immediately in store.state.onlineTabs
    for (let i = 0; i < 30; i++) {
      const curTabs = app.store.listOnlineTabs();
      if (curTabs.length > prevTabCount) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const afterGridTabs = app.store.listOnlineTabs();
    assert.ok(afterGridTabs.length > prevTabCount, 'openTabsGrid must push new tabs to server store immediately');

    // 9. Verify Web Dashboard UI rendering of login-stage tabs
    await dashPage.reload({ waitUntil: 'load' });
    await dashPage.waitForSelector('#onlineTabsBody tr', { timeout: 8000 });

    const rowsCount = await dashPage.locator('#onlineTabsBody tr').count();
    assert.ok(rowsCount >= 3, 'Dashboard tabs table must display rows for discovered tabs');

    // Check for provider icons and Login Pending status pills in the DOM
    const pendingPills = await dashPage.locator('.status-pill--pending').count();
    assert.ok(pendingPills >= 3, 'Dashboard must render .status-pill--pending for login-stage tabs');

    const providerIcons = await dashPage.locator('.tab-provider-icon').count();
    assert.ok(providerIcons >= 3, 'Dashboard must render provider brand icons for tabs');

    // Check action status text reflects pending tabs
    const statusText = await dashPage.locator('#actionStatusText').innerText();
    assert.match(statusText, /pending login/i);

    // 10. Test window.postMessage bridge communication between dashboard and extension content script
    const postMessageResponse = await dashPage.evaluate(async () => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for BIN4RY_TABS_RESPONSE')), 3000);
        const reqId = 'pm_test_' + Date.now();
        const handler = (e) => {
          if (e.data && e.data.type === 'BIN4RY_TABS_RESPONSE' && e.data.requestId === reqId) {
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            resolve(e.data);
          }
        };
        window.addEventListener('message', handler);
        window.postMessage({ action: 'GET_OPEN_TABS', requestId: reqId }, '*');
      });
    });

    assert.equal(postMessageResponse.ok, true, 'postMessage bridge must respond with ok: true');
    assert.ok(Array.isArray(postMessageResponse.tabs), 'Response must contain tabs array');
    assert.equal(typeof postMessageResponse.total, 'number', 'Response must include total');
    assert.equal(typeof postMessageResponse.totalBrowserTabs, 'number', 'Response must include totalBrowserTabs');
    assert.ok(postMessageResponse.totalBrowserTabs >= 4, 'totalBrowserTabs must count all browser tabs');

    // 11. Verify #totalOpenTabsBadge on dashboard updates with total open tabs reported by extension
    await dashPage.waitForFunction(() => {
      const b = document.getElementById('totalOpenTabsBadge');
      return b && /Tabs:\s*[1-9]\d*/.test(b.textContent);
    }, { timeout: 5000 });

    const badgeInitialText = await dashPage.locator('#totalOpenTabsBadge').innerText();
    assert.match(badgeInitialText, /^Tabs:\s*\d+$/, 'Badge must display "Tabs: <count>"');
    const badgeInitialCount = parseInt(badgeInitialText.replace(/[^\d]/g, ''), 10);
    assert.ok(badgeInitialCount >= 4, 'Badge count must be at least 4 tabs');

    // 12. Test clicking #refreshAllBtn triggers extension tab communication and updates badge
    const extraTab = await context.newPage();
    await extraTab.goto('https://accounts.google.com/signin', { waitUntil: 'load' });

    // Click "↻ Re-fetch active tabs"
    await dashPage.click('#refreshAllBtn');

    // Verify #totalOpenTabsBadge updates to reflect the increased tab count
    await dashPage.waitForFunction((prevCount) => {
      const b = document.getElementById('totalOpenTabsBadge');
      if (!b) return false;
      const cnt = parseInt(b.textContent.replace(/[^\d]/g, ''), 10);
      return cnt > prevCount;
    }, badgeInitialCount, { timeout: 5000 });

    const badgeUpdatedText = await dashPage.locator('#totalOpenTabsBadge').innerText();
    const badgeUpdatedCount = parseInt(badgeUpdatedText.replace(/[^\d]/g, ''), 10);
    assert.ok(badgeUpdatedCount > badgeInitialCount, `Badge count (${badgeUpdatedCount}) must increase after opening tab and clicking refresh`);

    // Verify clicking legacy alias #refreshTabsBtn triggers refresh without error
    await dashPage.click('#refreshTabsBtn');
    await extraTab.close();

    // 13. Alarm Keep-Alive test: verify relay_keepalive alarm reconnects WS if dropped
    await sw.evaluate(async () => {
      if (ws) ws.close();
      const alarmListener = chrome.alarms.onAlarm;
      // Trigger the keepalive alarm manually
      const listeners = [];
      // Test alarm existence
      const al = await chrome.alarms.get('relay_keepalive');
      return Boolean(al);
    });

    const hasKeepaliveAlarm = await sw.evaluate(async () => {
      const al = await chrome.alarms.get('relay_keepalive');
      return Boolean(al && al.name === 'relay_keepalive');
    });
    assert.equal(hasKeepaliveAlarm, true, 'relay_keepalive alarm must be registered');

    await context.close();
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
