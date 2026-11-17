'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const { createServer } = require('../src/server/app');
const { decodeFrames } = require('../src/server/wsHub');

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
        resolve({
          sock,
          sendJson(obj) {
            sock.write(encodeMaskedClientFrame(JSON.stringify(obj)));
          },
          nextMessage(predicate = () => true, timeoutMs = 4000) {
            const existingIdx = messages.findIndex(predicate);
            if (existingIdx !== -1) {
              return Promise.resolve(messages.splice(existingIdx, 1)[0]);
            }
            return new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('WS message timeout')), timeoutMs);
              waiters.push({
                predicate,
                resolve(m) { clearTimeout(t); res(m); }
              });
            });
          },
          close() {
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
              const w = waiters.splice(wIdx, 1)[0];
              w.resolve(parsed);
            } else {
              messages.push(parsed);
            }
          }
        }
      }
    });

    sock.on('error', reject);
  });
}

test('Integration: auth, concurrent session limit eviction, tags/data APIs, WS dispatch, and Playwright HTML->PDF/PNG conversion', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-int-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles'),
    sessionLimit: 2
  });

  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Unauthenticated /V3/ redirects to /Login.php
    const unauth = await fetch(`${baseUrl}/V3/`, { redirect: 'manual' });
    assert.equal(unauth.status, 302);
    assert.equal(unauth.headers.get('location'), '/Login.php');

    // Wrong password returns 401
    const badLogin = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admfib7H', pas: 'wrong-pass' })
    });
    assert.equal(badLogin.status, 401);

    // Login #1 and #2 succeed
    const login1 = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admfib7H', pas: 'd9tQGJdZ77' })
    });
    assert.equal((await login1.json()).status, 'ok');
    const cookie1 = login1.headers.get('set-cookie').split(';')[0];

    const login2 = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admfib7H', pas: 'd9tQGJdZ77' })
    });
    assert.equal((await login2.json()).status, 'ok');
    const cookie2 = login2.headers.get('set-cookie').split(';')[0];

    // Login #3 hits concurrent limit=2
    const login3Blocked = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admfib7H', pas: 'd9tQGJdZ77' })
    });
    const limitData = await login3Blocked.json();
    assert.equal(limitData.status, 'limit');
    assert.equal(limitData.limit, 2);
    assert.equal(limitData.activeDevices.length, 2);

    // Login #3 with force_evict evicts Session #1
    const login3Evict = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admfib7H', pas: 'd9tQGJdZ77', force_evict: true })
    });
    const evictData = await login3Evict.json();
    assert.equal(evictData.status, 'ok');
    assert.equal(evictData.evicted.length, 1);
    const cookie3 = login3Evict.headers.get('set-cookie').split(';')[0];

    // Verify cookie1 was evicted (401), while cookie2 and cookie3 work (200)
    assert.equal((await fetch(`${baseUrl}/V3/controller/heartbeat.php`, { headers: { Cookie: cookie1 } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/V3/controller/heartbeat.php`, { headers: { Cookie: cookie2 } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/V3/controller/heartbeat.php`, { headers: { Cookie: cookie3 } })).status, 200);

    // Verify CSWSH Origin protection and /ws/dashboard session cookie auth
    await assert.rejects(
      () => connectRawWs(addr.port, '/', { Origin: 'https://evil.example' }),
      /403 Forbidden/
    );
    await assert.rejects(
      () => connectRawWs(addr.port, '/ws/dashboard', { Origin: `http://127.0.0.1:${addr.port}` }),
      /401 Unauthorized/
    );
    const dashWs = await connectRawWs(addr.port, '/ws/dashboard', {
      Origin: `http://127.0.0.1:${addr.port}`,
      Cookie: cookie3
    });
    const dashSync = await dashWs.nextMessage((m) => m.type === 'DASHBOARD_SYNC');
    assert.ok(Array.isArray(dashSync.onlineTabs));
    dashWs.close();

    // Connect real RFC 6455 WS Extension Client
    const wsClient = await connectRawWs(addr.port, '/');
    try {
      wsClient.sendJson({
        type: 'REGISTER_AGENT',
        accountId: 'acc_ws_1',
        email: 'ws-sender@gmail.com',
        provider: 'gmail',
        proxy: 'socks5://127.0.0.1:9050'
      });
      const regAck = await wsClient.nextMessage((m) => m.type === 'REGISTER_SUCCESS');
      assert.equal(regAck.accountId, 'acc_ws_1');

      wsClient.sendJson({
        type: 'AGENT_INBOX_READY',
        accountId: 'acc_ws_1',
        tabId: 101,
        email: 'ws-sender@gmail.com',
        provider: 'gmail',
        inboxCount: 12,
        sentCount: 44
      });

      // Add verification pool and claim via WS
      await fetch(`${baseUrl}/api/verification/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({ raw: '+15557778888|https://sms.local/1' })
      });
      wsClient.sendJson({ type: 'SMS_POOL_REQUEST', requestId: 'req_1', email: 'ws-sender@gmail.com' });
      const smsResp = await wsClient.nextMessage((m) => m.type === 'SMS_POOL_RESPONSE');
      assert.equal(smsResp.item.phone, '+15557778888');

      // Custom Tags + Recipient Data + Compose + HTML->PDF Conversion + Shoot Dispatch
      await fetch(`${baseUrl}/V3/tags/tags.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({ name: 'planCode', values: ['PRO-99'], type: 'sequential' })
      });

      await fetch(`${baseUrl}/V3/relayCommandApi.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({ action: 'addData', data: 'victim@example.org' })
      });

      await fetch(`${baseUrl}/V3/relayCommandApi.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({
          action: 'saveCompose',
          subject: '{Hi|Hi} {user} {planCode}',
          body: '<p>Amount {10-10}</p>'
        })
      });

      // Wait for AGENT_INBOX_READY persistence & verify placeholder :0 merged into :101 (1 row, not duplicate!)
      await new Promise((r) => setTimeout(r, 80));
      const wsTabs = app.store.listOnlineTabs().filter((t) => t.accountId === 'acc_ws_1');
      assert.equal(wsTabs.length, 1);
      assert.equal(wsTabs[0].tabId, 101);
      assert.equal(wsTabs[0].isDup, false);
      const shootResp = await (await fetch(`${baseUrl}/V3/relayCommandApi.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({ action: 'shoot' })
      })).json();
      assert.equal(shootResp.ok, true);
      assert.equal(shootResp.queuedTasks, 1);

      const dispatch = await wsClient.nextMessage((m) => m.type === 'EXECUTE_DISPATCH');
      assert.equal(dispatch.recipientEmail, 'victim@example.org');
      assert.equal(dispatch.subject, 'Hi victim PRO-99');
      assert.equal(dispatch.body, '<p>Amount 10</p>');

      // Test local HTML -> PDF & PNG conversion endpoints
      const pdfConv = await (await fetch(`${baseUrl}/api/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({ html: '<h1>Invoice PDF</h1>', format: 'pdf', filename: 'inv', watermark: 'PAID' })
      })).json();
      assert.equal(pdfConv.ok, true);
      assert.equal(pdfConv.filename, 'inv.pdf');
      assert.ok(Buffer.from(pdfConv.base64, 'base64').subarray(0, 5).toString('ascii').startsWith('%PDF-'));

      const pngConv = await (await fetch(`${baseUrl}/api/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({ html: '<h1>PNG Card</h1>', format: 'png', filename: 'card' })
      })).json();
      assert.equal(pngConv.ok, true);
      const pngBytes = Buffer.from(pngConv.base64, 'base64');
      assert.deepEqual([...pngBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

      // Enforce daily send limit unless forceStart=true
      app.store.state.shootQuota.sentToday = app.store.state.shootQuota.dailyLimit;
      app.store.save();
      const blockedShoot = await (await fetch(`${baseUrl}/V3/relayCommandApi.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie3 },
        body: JSON.stringify({ action: 'shoot' })
      })).json();
      assert.equal(blockedShoot.ok, false);
      assert.match(blockedShoot.error, /Daily send limit/i);

      // Verify GET /V3/vt/vt.js & evict_oldest=1 & PHPSESSID alias
      const vtJsResp = await fetch(`${baseUrl}/V3/vt/vt.js`);
      assert.equal(vtJsResp.status, 200);
      assert.match(await vtJsResp.text(), /navigator\.sendBeacon\('\/V3\/vt\/c'/);

      const evictOldest = await fetch(`${baseUrl}/Login.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'usr=admfib7H&pas=d9tQGJdZ77&evict_oldest=1'
      });
      const evOldJson = await evictOldest.json();
      assert.equal(evOldJson.status, 'ok');
      assert.equal(evOldJson.redirect_url, '/V3/');
      const rawCookies = evictOldest.headers.getSetCookie ? evictOldest.headers.getSetCookie() : [evictOldest.headers.get('set-cookie')];
      const phpSessCookie = rawCookies.find((c) => c.startsWith('PHPSESSID='))?.split(';')[0];
      assert.ok(phpSessCookie, 'Expected PHPSESSID Set-Cookie alias alongside relay_sid');

      // Verify multipart/form-data key-only actions work on /V3/relayCommandApi.php via PHPSESSID
      const boundary = '----NewShooterBoundary789';
      const multipartBody = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="getShootDetail"',
        '',
        '1',
        `--${boundary}--`,
        ''
      ].join('\r\n');
      const mpResp = await (await fetch(`${baseUrl}/V3/relayCommandApi.php`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          Cookie: phpSessCookie
        },
        body: multipartBody
      })).json();
      assert.equal(mpResp.ok, true);
      assert.ok(mpResp.quota && mpResp.settings);

      // Verify /rpa-bootstrap omits rpa_* params from next target
      const bsResp = await fetch(`${baseUrl}/rpa-bootstrap?rpa_account=acc_x&rpa_email=u@gmail.com&next=${encodeURIComponent('https://accounts.google.com/ServiceLogin?service=mail')}`, {
        headers: { Cookie: phpSessCookie }
      });
      const bsHtml = await bsResp.text();
      assert.ok(bsHtml.includes('https://accounts.google.com/ServiceLogin?service=mail'));
      assert.ok(!bsHtml.includes('target = "https://accounts.google.com/ServiceLogin?service=mail&rpa_'));

      // Verify GMASS domain filtering + htmlOnly + Pause abort
      const gmSend = await (await fetch(`${baseUrl}/api/gmass/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: phpSessCookie },
        body: JSON.stringify({
          emails: 't1@example.org\nt2@example.org\nt3@example.org',
          subject: 'Hi {user}',
          message: '<p>Hello</p>',
          pdfHtml: '<h1>No PDF</h1>',
          convertPdf: true,
          htmlOnly: true,
          staggerMs: 250
        })
      })).json();
      assert.equal(gmSend.ok, true);
      assert.equal(gmSend.count, 3);

      const gmPause = await (await fetch(`${baseUrl}/api/gmass/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: phpSessCookie },
        body: '{}'
      })).json();
      assert.equal(gmPause.ok, true);
      assert.equal(gmPause.paused, true);

      const abortEvt = await wsClient.nextMessage((m) => m.type === 'ABORT_DISPATCH');
      assert.equal(abortEvt.campaignId, gmSend.gmassId);
    } finally {
      wsClient.close();
    }
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Offline tab reload re-opens browser window and attempts shoot when inbox is ready', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newshooter-offline-reload-'));
  let launchAccountCalled = false;
  let launchedAccountId = null;

  const mockBrowserManager = {
    getRunningSession: () => null, // offline!
    launchAccount: async (accId) => {
      launchAccountCalled = true;
      launchedAccountId = accId;
    },
    stopAccount: async () => {},
    stopAll: async () => {},
    setServerPort: () => {}
  };

  const app = createServer({
    dataDir: tmpDir,
    adminUser: 'admTest',
    adminPass: 'passTest123!',
    browserManager: mockBrowserManager
  });

  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Seed an account and tab with dataAllocated
    const acc = app.store.upsertAccount({
      email: 'offline_user@gmail.com',
      password: 'password123',
      provider: 'gmail'
    });
    app.store.upsertOnlineTab({
      tabKey: `${acc.id}:0`,
      tabId: 0,
      accountId: acc.id,
      email: acc.email,
      provider: 'gmail',
      tabName: 'Gmail #1',
      dataAllocated: 'target_recip@example.com',
      status: 'Offline',
      isActive: false
    });
    app.store.state.compose = {
      subject: 'Subject for {name}',
      body: 'Hello {name}'
    };
    app.store.state.shootSettings.gmail = 0;
    app.store.save();

    // Authenticate
    const loginResp = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admTest', pas: 'passTest123!' })
    });
    const setCookie = loginResp.headers.get('set-cookie');
    const cookieMatch = setCookie.match(/relay_sid=([^;]+)/);
    const sid = cookieMatch[1];

    // 2. Trigger reloadTab on offline account
    const reloadResp = await (await fetch(`${baseUrl}/V3/relayCommandApi.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `relay_sid=${sid}` },
      body: JSON.stringify({ action: 'reloadTab', accountId: acc.id, tabId: 0 })
    })).json();

    assert.equal(reloadResp.ok, true);
    assert.equal(reloadResp.reopened, true);
    assert.equal(launchAccountCalled, true);
    assert.equal(launchedAccountId, acc.id);

    // Tab status should be 'Reopening...'
    const tabDuringLaunch = app.store.state.onlineTabs[`${acc.id}:0`];
    assert.equal(tabDuringLaunch.status, 'Reopening...');

    // 3. Connect as agent WS client and simulate AGENT_INBOX_READY
    const wsClient = await connectRawWs(addr.port, '/', { Origin: 'chrome-extension://test' });
    try {
      wsClient.sendJson({
        type: 'AGENT_HELLO',
        accountId: acc.id,
        email: acc.email,
        version: '4.1.0'
      });
      await new Promise((r) => setTimeout(r, 100));

      // Send AGENT_INBOX_READY
      wsClient.sendJson({
        type: 'AGENT_INBOX_READY',
        accountId: acc.id,
        email: acc.email,
        tabId: 0,
        provider: 'gmail',
        inboxCount: 5
      });

      // 4. Verify EXECUTE_DISPATCH is received to attempt shoot!
      const dispatchMsg = await wsClient.nextMessage((m) => m.type === 'EXECUTE_DISPATCH', 3000);
      assert.equal(dispatchMsg.recipientEmail, 'target_recip@example.com');
      assert.equal(dispatchMsg.accountId, acc.id);
      assert.ok(dispatchMsg.subject.includes('Subject for'));
    } finally {
      wsClient.close();
    }
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Extension download endpoints return valid zip archive containing manifest.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ext-download-'));
  const app = createServer({
    dataDir: tmpDir,
    headless: true
  });
  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. GET /api/download-extension
    const res = await fetch(`${baseUrl}/api/download-extension`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.ok(res.headers.get('content-disposition').includes('bin4ry-relay-extension.zip'));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000);

    // Verify zip contains manifest.json and service-worker.js
    const bufStr = buf.toString('latin1');
    assert.ok(bufStr.includes('manifest.json'));
    assert.ok(bufStr.includes('background/service-worker.js'));

    // 2. HEAD /api/download-extension
    const headRes = await fetch(`${baseUrl}/api/download-extension`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), 'application/zip');

    // 3. Static asset /downloads/bin4ry-relay-extension.zip
    const staticRes = await fetch(`${baseUrl}/downloads/bin4ry-relay-extension.zip`);
    assert.equal(staticRes.status, 200);
    assert.equal(staticRes.headers.get('content-type'), 'application/zip');
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
