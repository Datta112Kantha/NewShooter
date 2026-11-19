'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { createServer } = require('../src/server/app');
const { decodeFrames } = require('../src/server/wsHub');

/**
 * Encode an RFC 6455 client-to-server WebSocket masked text frame.
 */
function encodeMaskedClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + opcode 1 (text)
    header[1] = 0x80 | payload.length; // MASK bit set + length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    masked[i] ^= mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * Connect a raw RFC 6455 WebSocket client to the server and handle upgrade.
 */
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
        const statusLine = head.split('\r\n')[0];
        if (!statusLine.includes('101 Switching Protocols')) {
          sock.destroy();
          const err = new Error(`WS upgrade failed: ${statusLine}`);
          err.statusLine = statusLine;
          err.statusCode = Number(statusLine.split(' ')[1]) || 0;
          reject(err);
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
              const t = setTimeout(() => rej(new Error(`WS message timeout after ${timeoutMs}ms`)), timeoutMs);
              waiters.push({
                predicate,
                resolve(m) {
                  clearTimeout(t);
                  res(m);
                }
              });
            });
          },
          close() {
            try {
              sock.destroy();
            } catch {}
          }
        });
      }

      if (upgraded && buf.length > 0) {
        const { frames, remaining } = decodeFrames(buf);
        buf = remaining;
        for (const f of frames) {
          if (f.opcode === 0x1) {
            try {
              const parsed = JSON.parse(f.payload.toString('utf8'));
              const wIdx = waiters.findIndex((w) => w.predicate(parsed));
              if (wIdx !== -1) {
                const w = waiters.splice(wIdx, 1)[0];
                w.resolve(parsed);
              } else {
                messages.push(parsed);
              }
            } catch {}
          }
        }
      }
    });

    sock.on('error', (err) => {
      if (!upgraded) reject(err);
    });
  });
}

test('E2E Feature 1: Server Session Concurrency Limits, Device Identification & Eviction', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-api-e2e-sess-'));
  const sessionLimit = 3;
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles'),
    sessionLimit
  });

  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 5 Distinct Simulated Devices with UA strings & unique VT fingerprints
    const devices = [
      {
        id: 'dev1-mac',
        name: 'Device 1',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        expectedLabel: 'macOS Chrome',
        ip: '198.51.100.10',
        vt_id: 'vt_mac_01',
        vt_fp: 'fp_mac_hash_01'
      },
      {
        id: 'dev2-win',
        name: 'Device 2',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        expectedLabel: 'Windows Chrome',
        ip: '198.51.100.20',
        vt_id: 'vt_win_02',
        vt_fp: 'fp_win_hash_02'
      },
      {
        id: 'dev3-linux',
        name: 'Device 3',
        ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        expectedLabel: 'Linux Chrome',
        ip: '198.51.100.30',
        vt_id: 'vt_lin_03',
        vt_fp: 'fp_lin_hash_03'
      },
      {
        id: 'dev4-headless',
        name: 'Device 4',
        ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/122.0.0.0 Safari/537.36',
        expectedLabel: 'Headless Chromium',
        ip: '198.51.100.40',
        vt_id: 'vt_head_04',
        vt_fp: 'fp_head_hash_04'
      },
      {
        id: 'dev5-mobile',
        name: 'Device 5',
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        expectedLabel: 'Web Browser',
        ip: '198.51.100.50',
        vt_id: 'vt_mob_05',
        vt_fp: 'fp_mob_hash_05'
      }
    ];

    const cookies = {};

    // 1. Devices 1, 2, and 3 log in successfully up to sessionLimit (3)
    for (let i = 0; i < 3; i++) {
      const dev = devices[i];
      const loginRes = await fetch(`${baseUrl}/Login.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': dev.ua,
          'X-Forwarded-For': dev.ip
        },
        body: JSON.stringify({
          usr: 'admfib7H',
          pas: 'd9tQGJdZ77',
          vt_id: dev.vt_id,
          vt_fp: dev.vt_fp
        })
      });
      assert.equal(loginRes.status, 200);
      const data = await loginRes.json();
      assert.equal(data.status, 'ok');
      assert.equal(data.username, 'admfib7H');
      assert.deepEqual(data.evicted, []);

      const setCookie = loginRes.headers.get('set-cookie');
      assert.ok(setCookie, `Cookie expected for ${dev.name}`);
      cookies[dev.id] = setCookie.split(';')[0];

      // Verify active session device label in store
      const sess = app.store.state.sessions.find((s) => setCookie.includes(s.token));
      assert.ok(sess);
      assert.equal(sess.deviceLabel, dev.expectedLabel);
      assert.equal(sess.vtId, dev.vt_id);

      // Verify authenticated API call succeeds
      const hb = await fetch(`${baseUrl}/V3/controller/heartbeat.php`, {
        headers: { Cookie: cookies[dev.id] }
      });
      assert.equal(hb.status, 200);
      assert.equal((await hb.json()).valid, true);
    }

    assert.equal(app.store.state.sessions.length, 3);

    // 2. Device 4 attempts login without forceEvict -> hits session limit
    const dev4 = devices[3];
    const blockedRes = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': dev4.ua
      },
      body: JSON.stringify({
        usr: 'admfib7H',
        pas: 'd9tQGJdZ77',
        vt_id: dev4.vt_id,
        vt_fp: dev4.vt_fp,
        force_evict: false
      })
    });
    assert.equal(blockedRes.status, 200);
    const blockedData = await blockedRes.json();
    assert.equal(blockedData.status, 'limit');
    assert.equal(blockedData.action_required, 'limit_reached');
    assert.equal(blockedData.limit, 3);
    assert.equal(blockedData.activeDevices.length, 3);

    // Check device labels in activeDevices prompt
    const labels = blockedData.activeDevices.map((d) => d.label);
    assert.ok(labels.some((l) => l.includes('macOS Chrome')));
    assert.ok(labels.some((l) => l.includes('Windows Chrome')));
    assert.ok(labels.some((l) => l.includes('Linux Chrome')));

    // Oldest device (Device 1) is flagged as willSignOut: true
    assert.equal(blockedData.activeDevices[0].willSignOut, true);
    assert.equal(blockedData.activeDevices[1].willSignOut, false);
    assert.equal(blockedData.activeDevices[2].willSignOut, false);

    // Confirm Devices 1, 2, 3 remain valid
    for (let i = 0; i < 3; i++) {
      const hb = await fetch(`${baseUrl}/V3/controller/heartbeat.php`, {
        headers: { Cookie: cookies[devices[i].id] }
      });
      assert.equal(hb.status, 200);
    }

    // 3. Device 4 logs in with force_evict: true -> Oldest (Device 1) is evicted
    const evictRes = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': dev4.ua
      },
      body: JSON.stringify({
        usr: 'admfib7H',
        pas: 'd9tQGJdZ77',
        vt_id: dev4.vt_id,
        vt_fp: dev4.vt_fp,
        force_evict: true
      })
    });
    assert.equal(evictRes.status, 200);
    const evictData = await evictRes.json();
    assert.equal(evictData.status, 'ok');
    assert.equal(evictData.evicted.length, 1);
    cookies[dev4.id] = evictRes.headers.get('set-cookie').split(';')[0];

    // Device 1's cookie is now evicted and receives 401
    const dev1HbAfter = await fetch(`${baseUrl}/V3/controller/heartbeat.php`, {
      headers: { Cookie: cookies[devices[0].id] }
    });
    assert.equal(dev1HbAfter.status, 401);

    // Devices 2, 3, and 4 are now the 3 active sessions (all 200)
    for (const devId of [devices[1].id, devices[2].id, dev4.id]) {
      const hb = await fetch(`${baseUrl}/V3/controller/heartbeat.php`, {
        headers: { Cookie: cookies[devId] }
      });
      assert.equal(hb.status, 200);
    }

    // 4. Device 5 logs in with forceEvict: true -> Device 2 is evicted
    const dev5 = devices[4];
    const evictRes2 = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': dev5.ua
      },
      body: JSON.stringify({
        usr: 'admfib7H',
        pas: 'd9tQGJdZ77',
        vt_id: dev5.vt_id,
        vt_fp: dev5.vt_fp,
        forceEvict: true
      })
    });
    assert.equal(evictRes2.status, 200);
    const evictData2 = await evictRes2.json();
    assert.equal(evictData2.status, 'ok');
    assert.equal(evictData2.evicted.length, 1);
    cookies[dev5.id] = evictRes2.headers.get('set-cookie').split(';')[0];

    // Device 2's cookie now receives 401
    const dev2HbAfter = await fetch(`${baseUrl}/V3/controller/heartbeat.php`, {
      headers: { Cookie: cookies[devices[1].id] }
    });
    assert.equal(dev2HbAfter.status, 401);

    // Active sessions are now Devices 3, 4, 5
    for (const devId of [devices[2].id, dev4.id, dev5.id]) {
      const hb = await fetch(`${baseUrl}/V3/controller/heartbeat.php`, {
        headers: { Cookie: cookies[devId] }
      });
      assert.equal(hb.status, 200);
    }

    // 5. Device 5 explicitly logs out -> Session removed, cookies expired with Max-Age=0
    const logoutRes = await fetch(`${baseUrl}/logout`, {
      method: 'GET',
      headers: { Cookie: cookies[dev5.id] },
      redirect: 'manual'
    });
    assert.equal(logoutRes.status, 302);
    assert.equal(logoutRes.headers.get('location'), '/Login.php');
    const logoutCookies = logoutRes.headers.get('set-cookie');
    assert.ok(logoutCookies.includes('Max-Age=0'));

    // Device 5 cookie now receives 401
    const dev5HbAfter = await fetch(`${baseUrl}/V3/controller/heartbeat.php`, {
      headers: { Cookie: cookies[dev5.id] }
    });
    assert.equal(dev5HbAfter.status, 401);

    // Active sessions count is now 2 (below limit 3)
    assert.equal(app.store.state.sessions.length, 2);

    // 6. Device 1 logs back in without forceEvict -> succeeds immediately
    const reLoginRes = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': devices[0].ua
      },
      body: JSON.stringify({
        usr: 'admfib7H',
        pas: 'd9tQGJdZ77'
      })
    });
    assert.equal(reLoginRes.status, 200);
    assert.equal((await reLoginRes.json()).status, 'ok');
    assert.equal(app.store.state.sessions.length, 3);
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Feature 2: Dynamic Extension Packaging (/download/extension.zip) & Archive Integrity', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-api-e2e-zip-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data')
  });

  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Test HEAD /download/extension.zip
    const headRes = await fetch(`${baseUrl}/download/extension.zip`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), 'application/zip');
    const reportedLength = Number(headRes.headers.get('content-length'));
    assert.ok(reportedLength > 1000, `Expected content length > 1000, got ${reportedLength}`);

    // 2. Test GET /download/extension.zip and /api/download-extension
    const endpoints = ['/download/extension.zip', '/api/download-extension'];
    for (const ep of endpoints) {
      const getRes = await fetch(`${baseUrl}${ep}`);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.headers.get('content-type'), 'application/zip');
      assert.ok(getRes.headers.get('content-disposition').includes('bin4ry-relay-extension.zip'));

      const arrayBuf = await getRes.arrayBuffer();
      const zipBuffer = Buffer.from(arrayBuf);
      assert.equal(zipBuffer.length, reportedLength);

      // 3. Verify End of Central Directory (EOCD) signature (0x06054b50)
      const eocdSig = 0x06054b50;
      let eocdOffset = -1;
      for (let i = zipBuffer.length - 22; i >= 0; i--) {
        if (zipBuffer.readUInt32LE(i) === eocdSig) {
          eocdOffset = i;
          break;
        }
      }
      assert.ok(eocdOffset !== -1, 'Valid ZIP End of Central Directory record not found');

      const cdEntriesCount = zipBuffer.readUInt16LE(eocdOffset + 8);
      const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
      const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
      assert.ok(cdEntriesCount > 0, 'ZIP must contain at least 1 file');
      assert.ok(cdOffset < eocdOffset, 'Central directory offset must precede EOCD');

      // 4. Parse Central Directory headers (0x02014b50) and verify each file
      const filesFound = new Map();
      let pos = cdOffset;
      for (let i = 0; i < cdEntriesCount; i++) {
        const sig = zipBuffer.readUInt32LE(pos);
        assert.equal(sig, 0x02014b50, `Invalid Central Directory header at index ${i}`);

        const compression = zipBuffer.readUInt16LE(pos + 10);
        const crc32Expected = zipBuffer.readUInt32LE(pos + 16);
        const compSize = zipBuffer.readUInt32LE(pos + 20);
        const uncompSize = zipBuffer.readUInt32LE(pos + 24);
        const nameLen = zipBuffer.readUInt16LE(pos + 28);
        const extraLen = zipBuffer.readUInt16LE(pos + 30);
        const commentLen = zipBuffer.readUInt16LE(pos + 32);
        const localHeaderOffset = zipBuffer.readUInt32LE(pos + 42);

        const fileName = zipBuffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
        pos += 46 + nameLen + extraLen + commentLen;

        // Verify corresponding Local File Header (0x04034b50)
        const lfhSig = zipBuffer.readUInt32LE(localHeaderOffset);
        assert.equal(lfhSig, 0x04034b50, `Invalid Local File Header signature for ${fileName}`);
        const lfhNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
        const lfhExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;

        const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compSize);
        assert.equal(compressedData.length, compSize);

        // Decompress Deflated stream (RFC 1951 raw deflate)
        let uncompressedData;
        if (compression === 8) {
          uncompressedData = zlib.inflateRawSync(compressedData);
        } else if (compression === 0) {
          uncompressedData = compressedData;
        } else {
          assert.fail(`Unsupported compression method ${compression} for ${fileName}`);
        }

        assert.equal(uncompressedData.length, uncompSize, `Uncompressed size mismatch for ${fileName}`);

        // Compute and verify CRC-32 checksum
        const actualCrc = zlib.crc32(uncompressedData);
        assert.equal(actualCrc, crc32Expected, `CRC32 checksum mismatch for ${fileName}`);

        filesFound.set(fileName, uncompressedData.toString('utf8'));
      }

      // 5. Validate Complete Extension File Set
      const requiredFiles = [
        'manifest.json',
        'background/service-worker.js',
        'popup/popup.html',
        'popup/popup.css',
        'popup/popup.js',
        'content/gmail-driver.js',
        'content/outlook-driver.js',
        'content/yahoo-driver.js',
        'content/dom-utils.js'
      ];

      for (const reqFile of requiredFiles) {
        assert.ok(filesFound.has(reqFile), `Required extension file missing from ZIP: ${reqFile}`);
        assert.ok(filesFound.get(reqFile).length > 0, `File is empty in ZIP: ${reqFile}`);
      }

      // 6. Validate manifest.json specifics
      const manifest = JSON.parse(filesFound.get('manifest.json'));
      assert.equal(manifest.manifest_version, 3);
      assert.ok(manifest.name.includes('Control Browser') || manifest.name.includes('Relay') || manifest.name.includes('BIN4RY'));
      assert.equal(manifest.action?.default_popup, undefined, 'default_popup must NOT be in manifest.json (B01 requirement)');
      assert.ok(manifest.action?.default_title, 'action.default_title should exist');
      assert.ok(Array.isArray(manifest.externally_connectable?.matches), 'externally_connectable.matches must be an array');
      assert.ok(manifest.permissions.includes('storage'));
      assert.ok(manifest.permissions.includes('cookies'));

      // 7. Validate background worker contains event listeners and batch controls
      const bgCode = filesFound.get('background/service-worker.js');
      assert.ok(bgCode.includes('chrome.action.onClicked.addListener'));
      assert.ok(bgCode.includes('PING_TABS'));
      assert.ok(bgCode.includes('REORDER_TABS'));
      assert.ok(bgCode.includes('RELOAD_ALL_TABS'));
      assert.ok(bgCode.includes('LOGOUT_ALL_ACCOUNTS'));
    }
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Feature 3: Complete REST API CRUD Testing (/api/accounts, /api/tabs, /api/tags, /api/files, /api/settings, /api/shoot)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-api-e2e-crud-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });

  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Authenticate admin session
    const loginRes = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admfib7H', pas: 'd9tQGJdZ77' })
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];
    const authHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };

    // ──────────────────────────────────────────────────────────────────────────
    // 1. /api/accounts CRUD
    // ──────────────────────────────────────────────────────────────────────────
    // Unauth check
    const unauthAcc = await fetch(`${baseUrl}/api/accounts`);
    assert.equal(unauthAcc.status, 401);

    // List initially
    const listInit = await (await fetch(`${baseUrl}/api/accounts`, { headers: authHeaders })).json();
    assert.equal(listInit.ok, true);
    assert.ok(Array.isArray(listInit.accounts));

    // CREATE single account
    const createSingle = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        email: 'crud-solo@gmail.com',
        password: 'passSolo123!',
        recovery: 'recovSolo@gmail.com',
        twoFa: 'JBSWY3DPEHPK3PXP',
        provider: 'gmail',
        proxy: 'socks5://127.0.0.1:1080'
      })
    })).json();
    assert.equal(createSingle.ok, true);
    assert.equal(createSingle.account.email, 'crud-solo@gmail.com');
    assert.equal(createSingle.account.proxy, 'socks5://127.0.0.1:1080');
    assert.equal(createSingle.account.ipStatus, 'unverified');
    const soloAccId = createSingle.account.id;

    // CREATE bulk accounts
    const createBulk = await (await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        bulk: 'bulk1@yahoo.com passB1 recovB1@yahoo.com 2FASECRET1 http://127.0.0.1:8081\nbulk2@outlook.com passB2 recovB2@outlook.com 2FASECRET2 http://127.0.0.1:8082'
      })
    })).json();
    assert.equal(createBulk.ok, true);
    assert.equal(createBulk.count, 2);
    assert.equal(createBulk.invalid.length, 0);

    // READ single account
    const readSingle = await (await fetch(`${baseUrl}/api/accounts/${soloAccId}`, { headers: authHeaders })).json();
    assert.equal(readSingle.ok, true);
    assert.equal(readSingle.account.id, soloAccId);
    assert.equal(readSingle.account.email, 'crud-solo@gmail.com');

    // READ non-existent account returns 404
    const notFoundAcc = await fetch(`${baseUrl}/api/accounts/non_existent_999`, { headers: authHeaders });
    assert.equal(notFoundAcc.status, 404);

    // UPDATE account (PUT / PATCH)
    const updateSingle = await (await fetch(`${baseUrl}/api/accounts/${soloAccId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        proxy: 'http://127.0.0.1:9090',
        recovery: 'updated-recov@gmail.com'
      })
    })).json();
    assert.equal(updateSingle.ok, true);
    assert.equal(updateSingle.account.proxy, 'http://127.0.0.1:9090');
    assert.equal(updateSingle.account.recovery, 'updated-recov@gmail.com');

    // DELETE single account
    const delSingle = await (await fetch(`${baseUrl}/api/accounts/${soloAccId}`, {
      method: 'DELETE',
      headers: authHeaders
    })).json();
    assert.equal(delSingle.ok, true);
    assert.ok(!delSingle.accounts.some((a) => a.id === soloAccId));

    // ──────────────────────────────────────────────────────────────────────────
    // 2. /api/tabs CRUD
    // ──────────────────────────────────────────────────────────────────────────
    // Unauth check
    const unauthTabs = await fetch(`${baseUrl}/api/tabs`);
    assert.equal(unauthTabs.status, 401);

    // List tabs initially
    const listTabsInit = await (await fetch(`${baseUrl}/api/tabs`, { headers: authHeaders })).json();
    assert.equal(listTabsInit.ok, true);
    assert.ok(Array.isArray(listTabsInit.tabs));

    // CREATE tab
    const createTab = await (await fetch(`${baseUrl}/api/tabs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tabKey: 'tab_test_acc:101',
        tabId: 101,
        accountId: 'tab_test_acc',
        email: 'tab-worker@gmail.com',
        provider: 'gmail',
        tabName: 'Gmail Driver #1',
        status: 'Idle',
        inbox: 14,
        draft: 2,
        sent: 88,
        spam: 0,
        proxy: 'http://127.0.0.1:8080'
      })
    })).json();
    assert.equal(createTab.ok, true);
    assert.equal(createTab.tab.key, 'tab_test_acc:101');
    assert.equal(createTab.tab.inbox, 14);

    // READ single tab
    const readTab = await (await fetch(`${baseUrl}/api/tabs/tab_test_acc:101`, { headers: authHeaders })).json();
    assert.equal(readTab.ok, true);
    assert.equal(readTab.tab.email, 'tab-worker@gmail.com');

    // READ non-existent tab returns 404
    const notFoundTab = await fetch(`${baseUrl}/api/tabs/missing:999`, { headers: authHeaders });
    assert.equal(notFoundTab.status, 404);

    // UPDATE tab (PATCH)
    const updateTab = await (await fetch(`${baseUrl}/api/tabs/tab_test_acc:101`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        status: 'Sending (12/50)',
        dataAllocated: 'target1@domain.com, target2@domain.com',
        pinned: true,
        inbox: 16
      })
    })).json();
    assert.equal(updateTab.ok, true);
    assert.equal(updateTab.tab.status, 'Sending (12/50)');
    assert.equal(updateTab.tab.pinned, true);
    assert.equal(updateTab.tab.inbox, 16);

    // Tab reload trigger
    const reloadTab = await (await fetch(`${baseUrl}/api/tabs/tab_test_acc:101/reload`, {
      method: 'POST',
      headers: authHeaders
    })).json();
    assert.equal(reloadTab.ok, true);
    assert.equal(reloadTab.reloaded, true);

    // DELETE tab
    const delTab = await (await fetch(`${baseUrl}/api/tabs/tab_test_acc:101`, {
      method: 'DELETE',
      headers: authHeaders
    })).json();
    assert.equal(delTab.ok, true);
    assert.ok(!delTab.tabs.some((t) => t.key === 'tab_test_acc:101'));

    // ──────────────────────────────────────────────────────────────────────────
    // 3. /api/tags CRUD
    // ──────────────────────────────────────────────────────────────────────────
    // Unauth check
    const unauthTags = await fetch(`${baseUrl}/api/tags`);
    assert.equal(unauthTags.status, 401);

    // READ tags (custom + predefined catalog)
    const readTags = await (await fetch(`${baseUrl}/api/tags`, { headers: authHeaders })).json();
    assert.equal(readTags.ok, true);
    assert.ok(readTags.tags);
    assert.equal(readTags.predefined.length, 63);

    // CREATE custom tag
    const createTag = await (await fetch(`${baseUrl}/api/tags`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'invoiceCode',
        values: ['INV-2026-A', 'INV-2026-B', 'INV-2026-C'],
        type: 'sequential'
      })
    })).json();
    assert.equal(createTag.ok, true);
    assert.equal(createTag.created.key, '{invoiceCode}');
    assert.equal(createTag.created.tag.type, 'sequential');
    assert.deepEqual(createTag.created.tag.values, ['INV-2026-A', 'INV-2026-B', 'INV-2026-C']);

    // READ single tag
    const getTag = await (await fetch(`${baseUrl}/api/tags/invoiceCode`, { headers: authHeaders })).json();
    assert.equal(getTag.ok, true);
    assert.equal(getTag.key, '{invoiceCode}');
    assert.equal(getTag.tag.type, 'sequential');

    // UPDATE tag
    const updateTag = await (await fetch(`${baseUrl}/api/tags/invoiceCode`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        values: ['INV-RAND-1', 'INV-RAND-2'],
        type: 'random'
      })
    })).json();
    assert.equal(updateTag.ok, true);
    assert.equal(updateTag.created.tag.type, 'random');
    assert.deepEqual(updateTag.created.tag.values, ['INV-RAND-1', 'INV-RAND-2']);

    // DELETE tag
    const delTag = await (await fetch(`${baseUrl}/api/tags/invoiceCode`, {
      method: 'DELETE',
      headers: authHeaders
    })).json();
    assert.equal(delTag.ok, true);
    assert.equal(delTag.tags['{invoiceCode}'], undefined);

    // GET deleted tag returns 404
    const getDelTag = await fetch(`${baseUrl}/api/tags/invoiceCode`, { headers: authHeaders });
    assert.equal(getDelTag.status, 404);

    // ──────────────────────────────────────────────────────────────────────────
    // 4. /api/files CRUD
    // ──────────────────────────────────────────────────────────────────────────
    // Unauth check
    const unauthFiles = await fetch(`${baseUrl}/api/files`);
    assert.equal(unauthFiles.status, 401);

    // READ files list
    const listFiles = await (await fetch(`${baseUrl}/api/files`, { headers: authHeaders })).json();
    assert.equal(listFiles.ok, true);
    assert.ok(Array.isArray(listFiles.files));

    // UPLOAD file
    const fileHtml = '<h1>Statement for {name}</h1><p>Amount: {price}</p>';
    const uploadRes = await (await fetch(`${baseUrl}/api/files/upload`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        filename: 'statement-template.html',
        base64: Buffer.from(fileHtml, 'utf8').toString('base64'),
        mimeType: 'text/html'
      })
    })).json();
    assert.equal(uploadRes.ok, true);
    assert.equal(uploadRes.file.originalName, 'statement-template.html');
    assert.equal(uploadRes.file.size, Buffer.byteLength(fileHtml));
    const fileId = uploadRes.file.id;

    // READ single file metadata
    const readFileMeta = await (await fetch(`${baseUrl}/api/files/${fileId}`, { headers: authHeaders })).json();
    assert.equal(readFileMeta.ok, true);
    assert.equal(readFileMeta.file.id, fileId);

    // DOWNLOAD file content
    const downloadRes = await fetch(`${baseUrl}/api/files/${fileId}?download=1`, { headers: authHeaders });
    assert.equal(downloadRes.status, 200);
    const downloadedText = await downloadRes.text();
    assert.equal(downloadedText, fileHtml);

    // DELETE file
    const delFile = await (await fetch(`${baseUrl}/api/files/${fileId}`, {
      method: 'DELETE',
      headers: authHeaders
    })).json();
    assert.equal(delFile.ok, true);
    assert.ok(!delFile.files.some((f) => f.id === fileId));

    // GET deleted file returns 404
    const getDelFile = await fetch(`${baseUrl}/api/files/${fileId}`, { headers: authHeaders });
    assert.equal(getDelFile.status, 404);

    // ──────────────────────────────────────────────────────────────────────────
    // 5. /api/settings CRUD
    // ──────────────────────────────────────────────────────────────────────────
    // Unauth check
    const unauthSettings = await fetch(`${baseUrl}/api/settings`);
    assert.equal(unauthSettings.status, 401);

    // READ current settings
    const readSettings = await (await fetch(`${baseUrl}/api/settings`, { headers: authHeaders })).json();
    assert.equal(readSettings.ok, true);
    assert.ok(readSettings.shootSettings);
    assert.ok(readSettings.automationSettings);
    assert.ok(readSettings.shootQuota);

    // UPDATE settings (shoot delays, layout, forceStart, dailyLimit)
    const updateSettings = await (await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        shootSettings: {
          gmail: 4,
          yahoo: 6,
          outlook: 7,
          layout: 'one-col',
          forceStart: true
        },
        dailyLimit: 55000,
        automationSettings: {
          humanTyping: true,
          typingSpeed: 'fast'
        },
        compose: {
          subject: 'Global Subject Tpl',
          body: '<p>Global Body Tpl</p>',
          senderName: 'Compliance Dept'
        }
      })
    })).json();
    assert.equal(updateSettings.ok, true);
    assert.equal(updateSettings.shootSettings.gmail, 4);
    assert.equal(updateSettings.shootSettings.yahoo, 6);
    assert.equal(updateSettings.shootSettings.outlook, 7);
    assert.equal(updateSettings.shootSettings.layout, 'one-col');
    assert.equal(updateSettings.shootSettings.forceStart, true);
    assert.equal(updateSettings.shootQuota.dailyLimit, 55000);
    assert.equal(updateSettings.automationSettings.humanTyping, true);

    // Verify GET persists updated settings
    const verifySettings = await (await fetch(`${baseUrl}/api/settings`, { headers: authHeaders })).json();
    assert.equal(verifySettings.shootSettings.gmail, 4);
    assert.equal(verifySettings.shootSettings.forceStart, true);
    assert.equal(verifySettings.shootQuota.dailyLimit, 55000);
    assert.equal(verifySettings.compose.senderName, 'Compliance Dept');

    // ──────────────────────────────────────────────────────────────────────────
    // 6. /api/shoot Dispatch & Abort Lifecycle
    // ──────────────────────────────────────────────────────────────────────────
    // Unauth check
    const unauthShoot = await fetch(`${baseUrl}/api/shoot`);
    assert.equal(unauthShoot.status, 401);

    // READ initial shoot status
    const shootInit = await (await fetch(`${baseUrl}/api/shoot`, { headers: authHeaders })).json();
    assert.equal(shootInit.ok, true);
    assert.equal(shootInit.shootState.active, false);

    // Add online tab to allow dispatch
    await fetch(`${baseUrl}/api/tabs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tabKey: 'shoot_tab_acc:1',
        tabId: 1,
        accountId: 'shoot_tab_acc',
        email: 'sender@bin4ry.test',
        provider: 'gmail',
        tabName: 'Sender 1',
        isActive: true,
        isBlocked: false,
        status: 'Idle'
      })
    });

    // DISPATCH test shoot via /api/shoot
    const dispatchRes = await (await fetch(`${baseUrl}/api/shoot`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        isTest: true,
        email: 'client@recipient.test',
        subject: 'Invoice #{orderno} for {company}',
        body: '<p>Dear {name}, here is your statement.</p>'
      })
    })).json();
    assert.equal(dispatchRes.ok, true);
    assert.ok(dispatchRes.shootId);
    assert.equal(dispatchRes.queuedTasks, 1);

    // READ status while shoot is active
    const shootRunning = await (await fetch(`${baseUrl}/api/shoot`, { headers: authHeaders })).json();
    assert.equal(shootRunning.ok, true);
    assert.equal(shootRunning.shootState.active, true);
    assert.equal(shootRunning.shootState.shootId, dispatchRes.shootId);

    // ABORT shoot via DELETE /api/shoot
    const abortRes = await (await fetch(`${baseUrl}/api/shoot`, {
      method: 'DELETE',
      headers: authHeaders
    })).json();
    assert.equal(abortRes.ok, true);
    assert.equal(abortRes.abortedShootId, dispatchRes.shootId);

    // Confirm shoot is inactive
    const shootAfterAbort = await (await fetch(`${baseUrl}/api/shoot`, { headers: authHeaders })).json();
    assert.equal(shootAfterAbort.ok, true);
    assert.equal(shootAfterAbort.shootState.active, false);

    // Secondary abort endpoint POST /api/shoot/abort
    const abortPost = await (await fetch(`${baseUrl}/api/shoot/abort`, {
      method: 'POST',
      headers: authHeaders
    })).json();
    assert.equal(abortPost.ok, true);
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E Feature 4: WebSocket Security, Cross-Origin Protection (CSWSH) & Auth Upgrades', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-api-e2e-ws-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data')
  });

  const addr = await app.start(0, '127.0.0.1');
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 1. Cross-Origin Protection (CSWSH) - Rejection of Unauthorized Origins (403)
    // ──────────────────────────────────────────────────────────────────────────
    const unauthorizedOrigins = [
      'https://evil-attacker.com',
      'https://hacker.io',
      'http://malicious.org:8080',
      'https://phishing.site',
      `http://127.0.0.1:${port + 1}`, // different port
      'https://victim.bank.com'
    ];

    for (const origin of unauthorizedOrigins) {
      // Direct agent path /
      await assert.rejects(
        () => connectRawWs(port, '/', { Origin: origin }),
        (err) => {
          assert.equal(err.statusCode, 403, `Expected 403 for unauthorized origin ${origin}`);
          assert.ok(err.statusLine.includes('403 Forbidden'));
          return true;
        }
      );

      // Dashboard path /ws/dashboard
      await assert.rejects(
        () => connectRawWs(port, '/ws/dashboard', { Origin: origin }),
        (err) => {
          assert.equal(err.statusCode, 403, `Expected 403 for unauthorized origin ${origin}`);
          assert.ok(err.statusLine.includes('403 Forbidden'));
          return true;
        }
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Dashboard WebSocket Authentication - Rejection of Unauthenticated Sockets (401)
    // ──────────────────────────────────────────────────────────────────────────
    const validOrigin = `http://127.0.0.1:${port}`;

    // No cookie provided
    await assert.rejects(
      () => connectRawWs(port, '/ws/dashboard', { Origin: validOrigin }),
      (err) => {
        assert.equal(err.statusCode, 401, 'Expected 401 for missing dashboard session cookie');
        assert.ok(err.statusLine.includes('401 Unauthorized'));
        return true;
      }
    );

    // Invalid / fake cookie provided
    await assert.rejects(
      () => connectRawWs(port, '/ws/dashboard', {
        Origin: validOrigin,
        Cookie: 'relay_sid=completely_fake_token_1234567890'
      }),
      (err) => {
        assert.equal(err.statusCode, 401, 'Expected 401 for invalid session cookie');
        assert.ok(err.statusLine.includes('401 Unauthorized'));
        return true;
      }
    );

    // Evicted / expired cookie provided
    const expiredSid = 'expired_session_token_abc';
    await assert.rejects(
      () => connectRawWs(port, '/ws/dashboard', {
        Origin: validOrigin,
        Cookie: `PHPSESSID=${expiredSid}`
      }),
      (err) => {
        assert.equal(err.statusCode, 401, 'Expected 401 for expired session cookie');
        return true;
      }
    );

    // ──────────────────────────────────────────────────────────────────────────
    // 3. Successful Upgrade for Authenticated Dashboard Socket
    // ──────────────────────────────────────────────────────────────────────────
    const loginRes = await fetch(`${baseUrl}/Login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usr: 'admfib7H', pas: 'd9tQGJdZ77' })
    });
    assert.equal(loginRes.status, 200);
    const authCookie = loginRes.headers.get('set-cookie').split(';')[0];

    const dashWs = await connectRawWs(port, '/ws/dashboard', {
      Origin: validOrigin,
      Cookie: authCookie
    });

    // Server immediately sends DASHBOARD_SYNC and HELLO
    const syncMsg = await dashWs.nextMessage((m) => m.type === 'DASHBOARD_SYNC');
    assert.equal(syncMsg.role, 'dashboard');
    assert.ok(Array.isArray(syncMsg.onlineTabs));

    const helloMsg = await dashWs.nextMessage((m) => m.type === 'HELLO');
    assert.equal(helloMsg.role, 'dashboard');

    // ──────────────────────────────────────────────────────────────────────────
    // 4. Successful Upgrade for Chrome Extension & Loopback Clients
    // ──────────────────────────────────────────────────────────────────────────
    // A) Chrome extension origin
    const extWs = await connectRawWs(port, '/', {
      Origin: 'chrome-extension://hhaemdfpkcpmnhkhclblhbhcepphgbda'
    });

    // Register extension agent
    extWs.sendJson({
      type: 'REGISTER_AGENT',
      accountId: 'acc_ext_agent_01',
      email: 'chrome.agent@bin4ry.test',
      provider: 'gmail',
      proxy: 'socks5://127.0.0.1:9050'
    });

    const regAck = await extWs.nextMessage((m) => m.type === 'REGISTER_SUCCESS');
    assert.equal(regAck.ok, true);
    assert.equal(regAck.accountId, 'acc_ext_agent_01');
    assert.equal(regAck.provider, 'gmail');
    assert.ok(regAck.automationSettings);

    // Dashboard socket receives live TABS_UPDATED event
    const tabUpdateOnDash = await dashWs.nextMessage((m) => m.type === 'TABS_UPDATED');
    assert.ok(tabUpdateOnDash.onlineTabs.some((t) => t.accountId === 'acc_ext_agent_01'));

    // B) Extension signals INBOX_READY
    extWs.sendJson({
      type: 'AGENT_INBOX_READY',
      accountId: 'acc_ext_agent_01',
      tabId: 303,
      email: 'chrome.agent@bin4ry.test',
      provider: 'gmail',
      inboxCount: 25,
      draftCount: 3,
      sentCount: 120,
      spamCount: 1
    });

    // Dashboard receives updated tab stats
    const dashInboxReady = await dashWs.nextMessage((m) => m.type === 'TABS_UPDATED');
    const updatedTab = dashInboxReady.onlineTabs.find((t) => t.accountId === 'acc_ext_agent_01');
    assert.ok(updatedTab);
    assert.equal(updatedTab.inbox, 25);
    assert.equal(updatedTab.sent, 120);

    // C) Agent Heartbeat Protocol
    extWs.sendJson({
      type: 'HEARTBEAT',
      tabId: 303,
      inbox: 27
    });
    const hbAck = await extWs.nextMessage((m) => m.type === 'HEARTBEAT_ACK');
    assert.ok(hbAck.ts > 0);

    // D) Loopback CLI Client (No Origin Header or localhost)
    const loopbackWs = await connectRawWs(port, '/', {
      Host: `127.0.0.1:${port}`
    });

    loopbackWs.sendJson({
      type: 'HELLO',
      tabName: 'CLI Worker',
      email: 'cli.worker@bin4ry.test'
    });
    const helloAck = await loopbackWs.nextMessage((m) => m.type === 'hello_ack');
    assert.equal(helloAck.ok, true);

    // E) Server Broadcast PING_TABS reaches all connected agents
    app.wsHub.broadcastAgents({ type: 'PING_TABS' });
    const extPing = await extWs.nextMessage((m) => m.type === 'PING_TABS');
    assert.equal(extPing.type, 'PING_TABS');
    const cliPing = await loopbackWs.nextMessage((m) => m.type === 'PING_TABS');
    assert.equal(cliPing.type, 'PING_TABS');

    // F) Close Dashboard Session on Logout
    // Trigger logout for the dashboard session
    await fetch(`${baseUrl}/logout`, {
      method: 'GET',
      headers: { Cookie: authCookie },
      redirect: 'manual'
    });

    // Check that dashboard WS socket is terminated by server
    await new Promise((resolve) => {
      if (dashWs.sock.destroyed) return resolve();
      dashWs.sock.on('close', resolve);
      setTimeout(resolve, 800);
    });
    assert.ok(dashWs.sock.destroyed || !dashWs.sock.writable);

    extWs.close();
    loopbackWs.close();
    dashWs.close();
  } finally {
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
