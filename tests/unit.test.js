'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { parseProxy, formatProxyUrl, redactProxyString, describeProxy } = require('../src/proxy/proxyParser');
const { ProxyBridge, probeProxyIp } = require('../src/proxy/proxyBridge');
const { generateTOTP, base32Decode } = require('../src/core/totp');
const {
  parseLoginLine,
  parseBulkCredentials,
  classifyErrorStatus,
  classifyLoginSegments,
  convertHtmlTableToPlainText,
  getTypingProfile
} = require('../src/core/credentials');
const { resolveSpintax, processTags, PREDEFINED_TAG_CATALOG } = require('../src/core/tagEngine');
const { VerificationPool } = require('../src/core/verificationPool');
const { startMockSocks5Server, startMockHttpProxy } = require('./helpers/mockProxies');

test('proxyParser parses URL, shorthand, bracketed IPv6, empty/direct, and redacts credentials', () => {
  assert.equal(parseProxy(''), null);
  assert.equal(parseProxy('direct'), null);
  assert.equal(parseProxy(null), null);

  const s5 = parseProxy('socks5://u1:secret:pw@10.0.0.2:1080');
  assert.equal(s5.protocol, 'socks5');
  assert.equal(s5.host, '10.0.0.2');
  assert.equal(s5.port, 1080);
  assert.equal(s5.username, 'u1');
  assert.equal(s5.password, 'secret:pw');
  assert.equal(formatProxyUrl(s5, { redact: true }), 'socks5://u1:***@10.0.0.2:1080');

  const short = parseProxy('192.168.1.50:8080:alice:p@ss:123');
  assert.equal(short.protocol, 'http');
  assert.equal(short.host, '192.168.1.50');
  assert.equal(short.port, 8080);
  assert.equal(short.username, 'alice');
  assert.equal(short.password, 'p@ss:123');

  const pipe = parseProxy('1.2.3.4|3128|bob|pw');
  assert.equal(pipe.host, '1.2.3.4');
  assert.equal(pipe.port, 3128);
  assert.equal(pipe.username, 'bob');

  const v6 = parseProxy('[::1]:9050');
  assert.equal(v6.host, '::1');
  assert.equal(v6.port, 9050);

  assert.equal(redactProxyString('socks5://alice:supersecret@1.2.3.4:1080'), 'socks5://alice:***@1.2.3.4:1080');
  assert.equal(describeProxy('socks5://alice:secret@1.2.3.4:1080').hasAuth, true);
  assert.throws(() => parseProxy('ftp://1.2.3.4:21'), /Unsupported proxy protocol/);
  assert.throws(() => parseProxy('1.2.3.4:99999'), /Invalid proxy port/);
});

test('ProxyBridge tunnels through authenticated SOCKS5 and HTTP upstream proxies and rejects bad auth', async () => {
  // Target HTTP echo server
  const echoServer = http.createServer((req, res) => {
    if (req.url.startsWith('/ip')) {
      const idHeader = req.headers['x-proxy-identity'] || 'direct-or-socks5';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query: '198.51.100.77', identity: idHeader }));
      return;
    }
    if (req.url.startsWith('/echo-post')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, received: raw }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok:' + req.url);
  });
  await new Promise((r) => echoServer.listen(0, '127.0.0.1', r));
  const echoPort = echoServer.address().port;

  const socks5 = await startMockSocks5Server({ username: 'suser', password: 'spass' });
  const httpProxy = await startMockHttpProxy({ username: 'huser', password: 'hpass', proxyTag: 'HTTP-AUTH-OK' });

  try {
    // 1. Valid SOCKS5 auth via probeProxyIp
    const s5Probe = await probeProxyIp(`socks5://suser:spass@127.0.0.1:${socks5.port}`, {
      checkUrl: `http://127.0.0.1:${echoPort}/ip`
    });
    assert.equal(s5Probe.ok, true);
    assert.equal(s5Probe.ip, '198.51.100.77');

    // 2. Wrong SOCKS5 password must fail cleanly
    const s5Bad = await probeProxyIp(`socks5://suser:WRONG@127.0.0.1:${socks5.port}`, {
      checkUrl: `http://127.0.0.1:${echoPort}/ip`
    });
    assert.equal(s5Bad.ok, false);

    // 3. Valid HTTP Proxy with Basic auth + CONNECT tunnel test
    const hBridge = new ProxyBridge(`http://huser:hpass@127.0.0.1:${httpProxy.port}`);
    const localUrl = await hBridge.start();
    try {
      const pUrl = new URL(localUrl);
      const resBody = await new Promise((resolve, reject) => {
        const req = http.request({
          host: pUrl.hostname,
          port: Number(pUrl.port),
          method: 'GET',
          path: `http://127.0.0.1:${echoPort}/ip`
        }, (res) => {
          let d = '';
          res.on('data', (c) => d += c);
          res.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(resBody.identity, 'HTTP-AUTH-OK');

      // 4. CONNECT tunnel over authenticated HTTP proxy
      const connectHttpOut = await new Promise((resolve, reject) => {
        const req = http.request({
          host: pUrl.hostname,
          port: Number(pUrl.port),
          method: 'CONNECT',
          path: `127.0.0.1:${echoPort}`
        });
        req.on('connect', (res, sock) => {
          assert.equal(res.statusCode, 200);
          sock.write(`GET /connect-http HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\nConnection: close\r\n\r\n`);
          let raw = '';
          sock.on('data', (c) => { raw += c.toString('utf8'); });
          sock.on('end', () => resolve(raw));
        });
        req.on('error', reject);
        req.end();
      });
      assert.match(connectHttpOut, /ok:\/connect-http/);
    } finally {
      await hBridge.stop();
    }

    // 5. CONNECT tunnel + HTTP POST body forwarding over authenticated SOCKS5 proxy
    const s5Bridge = new ProxyBridge(`socks5://suser:spass@127.0.0.1:${socks5.port}`);
    const s5Local = new URL(await s5Bridge.start());
    try {
      const connectS5Out = await new Promise((resolve, reject) => {
        const req = http.request({
          host: s5Local.hostname,
          port: Number(s5Local.port),
          method: 'CONNECT',
          path: `127.0.0.1:${echoPort}`
        });
        req.on('connect', (res, sock) => {
          assert.equal(res.statusCode, 200);
          sock.write(`GET /connect-socks5 HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\nConnection: close\r\n\r\n`);
          let raw = '';
          sock.on('data', (c) => { raw += c.toString('utf8'); });
          sock.on('end', () => resolve(raw));
        });
        req.on('error', reject);
        req.end();
      });
      assert.match(connectS5Out, /ok:\/connect-socks5/);

      const postPayload = JSON.stringify({ hello: 'socks5-post', seq: [1, 2, 3] });
      const postOut = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HTTP POST over SOCKS5 timed out (body drop regression)')), 3000);
        const req = http.request({
          host: s5Local.hostname,
          port: Number(s5Local.port),
          method: 'POST',
          path: `http://127.0.0.1:${echoPort}/echo-post`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postPayload)
          }
        }, (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => { clearTimeout(timer); resolve(JSON.parse(d)); });
        });
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.end(postPayload);
      });
      assert.equal(postOut.method, 'POST');
      assert.equal(postOut.received, postPayload);
    } finally {
      await s5Bridge.stop();
    }
  } finally {
    await socks5.close();
    await httpProxy.close();
    await new Promise((r) => echoServer.close(r));
  }
});

test('totp matches RFC 6238 test vectors and validates inputs', () => {
  // RFC 6238 SHA1 secret "12345678901234567890" -> Base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  // T=59s -> 8 digits in RFC is 94287082, 6 digits is 287082
  assert.equal(generateTOTP(secret, { timestampMs: 59 * 1000, digits: 6 }), '287082');
  assert.equal(generateTOTP('gezd gnbv-gy3t qojq GEZD GNBV GY3T QOJQ', { timestampMs: 59 * 1000, digits: 8 }), '94287082');
  assert.equal(generateTOTP(`otpauth://totp/Google:test@gmail.com?secret=${secret}&issuer=Google`, { timestampMs: 59 * 1000 }), '287082');

  assert.throws(() => base32Decode(''), /empty/i);
  assert.throws(() => base32Decode('INVALID!189'), /Invalid Base32/i);
});

test('credentials parser, table paste converter, segment classifier, error classifier, and typing profiles', () => {
  const full = parseLoginLine('john@gmail.com MyPass99 rec@yahoo.com ABCD EFGH IJKL socks5://u:p@1.2.3.4:1080');
  assert.equal(full.email, 'john@gmail.com');
  assert.equal(full.password, 'MyPass99');
  assert.equal(full.recovery, 'rec@yahoo.com');
  assert.equal(full.twoFa, 'ABCDEFGHIJKL');
  assert.equal(full.proxy, 'socks5://u:p@1.2.3.4:1080');
  assert.equal(full.provider, 'gmail');

  const outlook = parseLoginLine('sales@outlook.com Pass123! proxy:10.0.0.1:8080:u:p');
  assert.equal(outlook.provider, 'outlook');
  assert.equal(outlook.proxy, '10.0.0.1:8080:u:p');

  const badProto = parseLoginLine('u@gmail.com Pass1 ftp://1.2.3.4:21');
  assert.equal(badProto.twoFa, '');
  assert.match(badProto.proxyError, /Unsupported proxy protocol/i);
  const badUrlPort = parseLoginLine('u@gmail.com Pass1 socks5://1.2.3.4:99999');
  assert.equal(badUrlPort.twoFa, '');
  assert.match(badUrlPort.proxyError, /Invalid proxy URL/i);
  const badShortPort = parseLoginLine('u@gmail.com Pass1 1.2.3.4:99999');
  assert.equal(badShortPort.twoFa, '');
  assert.match(badShortPort.proxyError, /Invalid proxy port/i);

  const bulk = parseBulkCredentials('a@gmail.com p1\n\nbadline\nc@yahoo.com p2');
  assert.equal(bulk.accounts.length, 2);
  assert.equal(bulk.accounts[1].provider, 'yahoo');
  assert.equal(bulk.invalid.length, 1);

  assert.equal(classifyErrorStatus('Wrong password. Try again.'), 'gid-err-fatal');
  assert.equal(classifyErrorStatus('Please add recovery mail to continue'), 'gid-err-action');
  assert.equal(classifyErrorStatus('Temporary captcha challenge'), 'gid-err-retry');

  const segs = classifyLoginSegments('a@b.com pass123 rec@x.com JBSW http://1.2.3.4:80');
  assert.deepEqual(segs.filter((s) => s.type !== 'space').map((s) => s.type), ['email', 'password', 'recovery', '2fa', 'proxy']);

  const plain = convertHtmlTableToPlainText('<table><tr><td>u@gmail.com</td><td>pw</td><td>rec@y.com</td></tr></table>');
  assert.equal(plain, 'u@gmail.com\tpw\trec@y.com');

  const instant = getTypingProfile({ typingSpeed: 'instant', humanizeTyping: true });
  assert.equal(instant.base, 0);
  const steady = getTypingProfile({ typingSpeed: 'normal', humanizeTyping: false });
  assert.equal(steady.variation, 0);
});

test('tagEngine resolves nested spintax, protects CSS style blocks, evaluates 63 tags, ranges, and detects circular custom tags', () => {
  assert.equal(PREDEFINED_TAG_CATALOG.length, 63);

  // Nested spintax
  const spun = resolveSpintax('{Hello {world|there}|Hi friend}');
  assert.ok(['Hello world', 'Hello there', 'Hi friend'].includes(spun));

  // Protect <style> CSS from tag/spintax mangling
  const cssHtml = '<style>body { color: #111; margin: 0; } .a { font-weight: bold; }</style><p>{Hi|Hello} {name}, order #{100-100}</p>';
  const out = processTags('alex@example.com', cssHtml);
  assert.ok(out.includes('<style>body { color: #111; margin: 0; } .a { font-weight: bold; }</style>'));
  assert.ok(out.includes('order #100'));

  // Swapped bounds range {50-50} and sequential custom tags + cache consistency across fields
  const counters = {};
  const customTags = {
    '{tier}': { type: 'sequential', values: ['Gold', 'Silver'] },
    '{loopA}': { type: 'sequential', values: ['{loopB}'] },
    '{loopB}': { type: 'sequential', values: ['{loopA}'] }
  };

  const cache1 = {};
  const msg1 = processTags('user1@demo.com', {
    subject: '{name} - {tier} - {user}',
    body: 'Repeat {name} in {tier}, loop={loopA}, rand={10-20}'
  }, { customTags, tagCounters: counters, cache: cache1 });

  // Verify cache kept {name} identical between subject and body
  const subjName = msg1.subject.split(' - ')[0];
  assert.ok(msg1.body.includes(`Repeat ${subjName} in Gold`));
  assert.ok(msg1.subject.endsWith('user1'));
  assert.ok(msg1.body.includes('loop={loopA}') || msg1.body.includes('loop={loopB}'));

  const msg2 = processTags('user2@demo.com', { subject: '{tier}' }, { customTags, tagCounters: counters });
  assert.equal(msg2.subject, 'Silver');
});

test('VerificationPool manages lifecycle, double-claim, releaseByEmail, and serialization', () => {
  const pool = new VerificationPool();
  const s1 = pool.syncFromString('+15550001|https://sms.test/1\n+15550002\thttps://sms.test/2');
  assert.equal(s1.total, 2);
  assert.equal(s1.added, 2);

  const c1 = pool.getNextAvailable('a@gmail.com');
  assert.equal(c1.phone, '+15550001');
  // Re-claiming by same account returns same item
  assert.equal(pool.getNextAvailable('a@gmail.com').phone, '+15550001');

  const c2 = pool.getNextAvailable('b@gmail.com');
  assert.equal(c2.phone, '+15550002');
  // Exhausted returns null
  assert.equal(pool.getNextAvailable('c@gmail.com'), null);

  pool.markVerified('+15550001');
  pool.releaseByEmail('b@gmail.com');
  assert.deepEqual(pool.getStats(), { total: 2, available: 1, in_use: 0, verified: 1, permanent_error: 0 });

  pool.markPermanentError('+15550002', 'Blocked');
  assert.equal(pool.resetPermanentErrors(), 1);

  const restored = VerificationPool.fromJSON(pool.toJSON());
  assert.equal(restored.getStats().verified, 1);
  assert.equal(restored.getStats().available, 1);
});
