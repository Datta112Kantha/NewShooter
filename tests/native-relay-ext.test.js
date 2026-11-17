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

function connectRawWs(port, pathName = '/') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${pathName} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ];
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
            const foundIdx = messages.findIndex(predicate);
            if (foundIdx !== -1) {
              const [msg] = messages.splice(foundIdx, 1);
              return Promise.resolve(msg);
            }
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                const i = waiters.findIndex((w) => w.resolve === res);
                if (i !== -1) waiters.splice(i, 1);
                rej(new Error('Timed out waiting for WS message'));
              }, timeoutMs);
              waiters.push({ predicate, resolve: res, timer });
            });
          },
          close() {
            sock.end();
          }
        });
      }

      if (upgraded && buf.length > 0) {
        const { frames, remaining } = decodeFrames(buf);
        buf = remaining;
        for (const frame of frames) {
          if (frame.opcode === 0x1) {
            try {
              const parsed = JSON.parse(frame.payload.toString('utf8'));
              const waiterIdx = waiters.findIndex((w) => w.predicate(parsed));
              if (waiterIdx !== -1) {
                const [w] = waiters.splice(waiterIdx, 1);
                clearTimeout(w.timer);
                w.resolve(parsed);
              } else {
                messages.push(parsed);
              }
            } catch {}
          }
        }
      }
    });

    sock.on('error', reject);
  });
}

test('Native Relay-EXT Handshake and WebSocket Protocol Support', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-native-test-'));
  const app = createServer({
    dataDir: tmpDir,
    profilesRoot: path.join(tmpDir, 'profiles')
  });

  const addr = await app.start(0, '127.0.0.1');
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await app.stop();
  });

  // 1. Test /V3/relay.php (Native Extension Handshake)
  const relayRes = await fetch(`${baseUrl}/V3/relay.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hash: '4844bebbae247aec829a83f519a26951a5a05470688035c9d55f31dc1a59ee24',
      relayVersion: '4.0.3',
      isSingle: true,
      extID: 'test_ext_1'
    })
  });
  assert.equal(relayRes.status, 200);
  const relayData = await relayRes.json();
  assert.equal(relayData.success, true);
  assert.equal(relayData.status, 'active');
  assert.ok(relayData.wsGateway.startsWith('ws://'));
  assert.ok(typeof relayData.tags === 'object');

  // 2. Test /V3/signal_V6.php (HTTP Signal Fallback)
  const signalRes = await fetch(`${baseUrl}/V3/signal_V6.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tabId: 101,
      inbox: 15,
      draft: 3,
      sent: 42
    })
  });
  assert.equal(signalRes.status, 200);
  const signalData = await signalRes.json();
  assert.equal(signalData.success, true);

  // 3. Test WebSocket connection matching RelayWsClient.js
  const ws = await connectRawWs(port);

  // Send RelayWsClient 'hello' frame
  ws.sendJson({
    type: 'hello',
    hash: '4844bebbae247aec829a83f519a26951a5a05470688035c9d55f31dc1a59ee24',
    tabId: 999,
    email: 'realuser@gmail.com',
    isYahoo: false,
    isIcloud: false,
    extID: 'ext_native_999'
  });

  // Expect hello_ack
  const ackMsg = await ws.nextMessage((m) => m.type === 'hello_ack');
  assert.equal(ackMsg.ok, true);
  assert.equal(ackMsg.email, 'realuser@gmail.com');

  // Verify tab is registered as Online in Store
  const tabs = app.store.listOnlineTabs();
  const onlineTab = tabs.find((t) => t.tabId === 999 || t.email === 'realuser@gmail.com');
  assert.ok(onlineTab, 'Tab must be registered in online tabs');
  assert.equal(onlineTab.email, 'realuser@gmail.com');
  assert.equal(onlineTab.isActive, true);

  // Send RelayWsClient single-tab 'heartbeat' frame
  ws.sendJson({
    type: 'heartbeat',
    tabId: 999,
    inbox: 25,
    draft: 4,
    sent: 100,
    spam: 1
  });

  await new Promise((r) => setTimeout(r, 100));
  const updatedTab = app.store.listOnlineTabs().find((t) => t.tabId === 999);
  assert.equal(updatedTab.inbox, 25);
  assert.equal(updatedTab.draft, 4);
  assert.equal(updatedTab.sent, 100);

  // Send RelayWsClient 'progress' frame
  ws.sendJson({
    type: 'progress',
    tabId: 999,
    sent: 10,
    total: 50,
    done: false
  });

  await new Promise((r) => setTimeout(r, 100));
  const progressTab = app.store.listOnlineTabs().find((t) => t.tabId === 999);
  assert.equal(progressTab.status, 'Sending (10/50)');

  ws.close();
});
