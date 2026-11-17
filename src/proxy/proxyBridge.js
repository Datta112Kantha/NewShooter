'use strict';

const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { parseProxy } = require('./proxyParser');

const CONNECT_TIMEOUT_MS = 15000;

/**
 * Connect via upstream SOCKS5 proxy (RFC 1928 + RFC 1929 user/pass auth).
 */
function connectViaSocks5(proxy, targetHost, targetPort, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    let settled = false;
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      fail(new Error(`SOCKS5 handshake timeout (${proxy.host}:${proxy.port})`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    }

    function onError(err) {
      fail(new Error(`SOCKS5 connection error: ${err.message}`));
    }

    function onClose() {
      if (!settled) fail(new Error('SOCKS5 upstream closed connection unexpectedly'));
    }

    function sendConnectRequest() {
      stage = 'connect';
      const portBuf = Buffer.allocUnsafe(2);
      portBuf.writeUInt16BE(targetPort, 0);

      let addrBuf;
      let atyp;
      const ipVer = net.isIP(targetHost);
      if (ipVer === 4) {
        atyp = 0x01;
        addrBuf = Buffer.from(targetHost.split('.').map(Number));
      } else if (ipVer === 6) {
        atyp = 0x04;
        addrBuf = encodeIPv6(targetHost);
      } else {
        atyp = 0x03;
        const hostBytes = Buffer.from(targetHost, 'utf8');
        if (hostBytes.length > 255) {
          return fail(new Error('Target hostname exceeds 255 bytes for SOCKS5'));
        }
        addrBuf = Buffer.concat([Buffer.from([hostBytes.length]), hostBytes]);
      }

      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, atyp]),
        addrBuf,
        portBuf
      ]);
      socket.write(req);
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);

      while (!settled) {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const ver = buffer[0];
          const method = buffer[1];
          buffer = buffer.subarray(2);

          if (ver !== 0x05) {
            return fail(new Error(`Invalid SOCKS5 version byte: ${ver}`));
          }
          if (method === 0xff) {
            return fail(new Error('SOCKS5 server rejected all authentication methods'));
          }
          if (method === 0x02) {
            if (!proxy.username && !proxy.password) {
              return fail(new Error('SOCKS5 proxy requires authentication but no credentials provided'));
            }
            const userBuf = Buffer.from(proxy.username || '', 'utf8');
            const passBuf = Buffer.from(proxy.password || '', 'utf8');
            if (userBuf.length > 255 || passBuf.length > 255) {
              return fail(new Error('SOCKS5 credentials exceed 255 bytes'));
            }
            stage = 'auth';
            socket.write(Buffer.concat([
              Buffer.from([0x01, userBuf.length]),
              userBuf,
              Buffer.from([passBuf.length]),
              passBuf
            ]));
            continue;
          }
          if (method === 0x00) {
            sendConnectRequest();
            continue;
          }
          return fail(new Error(`Unsupported SOCKS5 auth method selected: ${method}`));
        }

        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const ver = buffer[0];
          const status = buffer[1];
          buffer = buffer.subarray(2);
          if (ver !== 0x01 || status !== 0x00) {
            return fail(new Error(`SOCKS5 authentication failed (status ${status})`));
          }
          sendConnectRequest();
          continue;
        }

        if (stage === 'connect') {
          if (buffer.length < 4) return;
          const ver = buffer[0];
          const rep = buffer[1];
          const atyp = buffer[3];
          let addrLen;
          if (atyp === 0x01) {
            addrLen = 4;
          } else if (atyp === 0x04) {
            addrLen = 16;
          } else if (atyp === 0x03) {
            if (buffer.length < 5) return;
            addrLen = 1 + buffer[4];
          } else {
            return fail(new Error(`Unsupported SOCKS5 BND ATYP: ${atyp}`));
          }

          const totalLen = 4 + addrLen + 2;
          if (buffer.length < totalLen) return;

          if (ver !== 0x05) {
            return fail(new Error(`Invalid SOCKS5 connect response version: ${ver}`));
          }
          if (rep !== 0x00) {
            return fail(new Error(`SOCKS5 CONNECT rejected with code ${rep} (${socks5ErrorText(rep)})`));
          }

          const leftover = buffer.subarray(totalLen);
          settled = true;
          cleanup();
          if (leftover.length > 0) {
            socket.unshift(leftover);
          }
          resolve(socket);
          return;
        }
      }
    }

    socket.once('connect', () => {
      const hasCreds = Boolean(proxy.username || proxy.password);
      const greeting = hasCreds
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]);
      socket.write(greeting);
    });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function connectViaSocks4(proxy, targetHost, targetPort, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    let settled = false;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      fail(new Error(`SOCKS4 handshake timeout (${proxy.host}:${proxy.port})`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    }

    function onError(err) {
      fail(new Error(`SOCKS4 connection error: ${err.message}`));
    }

    function onClose() {
      if (!settled) fail(new Error('SOCKS4 upstream closed connection unexpectedly'));
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8) return;
      const cd = buffer[1];
      if (cd !== 0x5a) {
        return fail(new Error(`SOCKS4 CONNECT rejected with status 0x${cd.toString(16)}`));
      }
      const leftover = buffer.subarray(8);
      settled = true;
      cleanup();
      if (leftover.length > 0) socket.unshift(leftover);
      resolve(socket);
    }

    socket.once('connect', () => {
      const portBuf = Buffer.allocUnsafe(2);
      portBuf.writeUInt16BE(targetPort, 0);
      const userBuf = Buffer.from(proxy.username || '', 'utf8');
      if (net.isIPv4(targetHost)) {
        const ipBuf = Buffer.from(targetHost.split('.').map(Number));
        socket.write(Buffer.concat([
          Buffer.from([0x04, 0x01]),
          portBuf,
          ipBuf,
          userBuf,
          Buffer.from([0x00])
        ]));
      } else {
        // SOCKS4a domain resolution via 0.0.0.1
        const domainBuf = Buffer.from(targetHost, 'utf8');
        socket.write(Buffer.concat([
          Buffer.from([0x04, 0x01]),
          portBuf,
          Buffer.from([0x00, 0x00, 0x00, 0x01]),
          userBuf,
          Buffer.from([0x00]),
          domainBuf,
          Buffer.from([0x00])
        ]));
      }
    });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function connectViaHttpProxy(proxy, targetHost, targetPort, timeoutMs = CONNECT_TIMEOUT_MS, options = {}) {
  return new Promise((resolve, reject) => {
    const isTlsUpstream = proxy.protocol === 'https';
    const socket = isTlsUpstream
      ? tls.connect({
        host: proxy.host,
        port: proxy.port,
        servername: proxy.host,
        ...(options.rejectUnauthorized !== undefined ? { rejectUnauthorized: options.rejectUnauthorized } : {})
      })
      : net.createConnection({ host: proxy.host, port: proxy.port });

    let settled = false;
    let headerBuf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      fail(new Error(`HTTP proxy CONNECT timeout (${proxy.host}:${proxy.port})`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    }

    function onError(err) {
      fail(new Error(`Upstream HTTP proxy error: ${err.message}`));
    }

    function onClose() {
      if (!settled) fail(new Error('Upstream HTTP proxy closed connection before CONNECT established'));
    }

    function onData(chunk) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (headerBuf.length > 16384) fail(new Error('Upstream HTTP proxy response header too large'));
        return;
      }
      const head = headerBuf.subarray(0, idx).toString('latin1');
      const statusMatch = head.match(/^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?/i);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      if (statusCode < 200 || statusCode >= 300) {
        return fail(new Error(`Upstream HTTP proxy rejected CONNECT: ${head.split('\r\n')[0]}`));
      }
      const leftover = headerBuf.subarray(idx + 4);
      settled = true;
      cleanup();
      if (leftover.length > 0) socket.unshift(leftover);
      resolve(socket);
    }

    const readyEvent = isTlsUpstream ? 'secureConnect' : 'connect';
    socket.once(readyEvent, () => {
      const authority = targetHost.includes(':') ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
      const lines = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        'Proxy-Connection: keep-alive'
      ];
      if (proxy.username || proxy.password) {
        const token = Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64');
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function connectDirect(targetHost, targetPort, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: targetHost, port: targetPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Direct TCP connect timeout (${targetHost}:${targetPort})`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function openUpstreamTunnel(proxy, targetHost, targetPort, options = {}) {
  const timeoutMs = options.timeoutMs || CONNECT_TIMEOUT_MS;
  if (!proxy) return connectDirect(targetHost, targetPort, timeoutMs);
  if (proxy.protocol === 'socks5') return connectViaSocks5(proxy, targetHost, targetPort, timeoutMs);
  if (proxy.protocol === 'socks4') return connectViaSocks4(proxy, targetHost, targetPort, timeoutMs);
  if (proxy.protocol === 'http' || proxy.protocol === 'https') {
    return connectViaHttpProxy(proxy, targetHost, targetPort, timeoutMs, options);
  }
  throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
}

function parseAuthority(reqUrl, fallbackHostHeader) {
  const raw = String(reqUrl || '');
  // Bracketed IPv6 host:port
  const v6 = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) return { host: v6[1], port: Number(v6[2]) };

  const lastColon = raw.lastIndexOf(':');
  if (lastColon > 0) {
    const port = Number(raw.slice(lastColon + 1));
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { host: raw.slice(0, lastColon), port };
    }
  }
  if (fallbackHostHeader) {
    return { host: fallbackHostHeader.split(':')[0], port: 443 };
  }
  return { host: raw, port: 443 };
}

function socks5ErrorText(rep) {
  const map = {
    1: 'general SOCKS server failure',
    2: 'connection not allowed by ruleset',
    3: 'Network unreachable',
    4: 'Host unreachable',
    5: 'Connection refused',
    6: 'TTL expired',
    7: 'Command not supported',
    8: 'Address type not supported'
  };
  return map[rep] || 'unknown error';
}

function encodeIPv6(ip) {
  const clean = ip.split('%')[0];
  const halves = clean.split('::');
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = Math.max(0, 8 - (left.length + right.length));
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    out.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
  }
  return out;
}

/**
 * Local loopback HTTP/CONNECT forwarding bridge bound to 127.0.0.1:<ephemeralPort>.
 * Translates unauthenticated HTTP CONNECT / plain HTTP requests from Chromium
 * into upstream HTTP/HTTPS Basic Auth, SOCKS4, or SOCKS5 RFC 1929 authenticated tunnels.
 */
class ProxyBridge {
  constructor(proxyConfig, options = {}) {
    this.upstream = proxyConfig ? parseProxy(proxyConfig) : null;
    this.options = options;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.stats = { tunnelsOpened: 0, httpRequests: 0, errors: 0 };
  }

  async start() {
    if (this.server) return this.getLocalUrl();
    this.server = http.createServer((req, res) => this._handleHttpRequest(req, res));
    this.server.on('connect', (req, clientSocket, head) => this._handleConnect(req, clientSocket, head));
    this.server.on('connection', (sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        const addr = this.server.address();
        this.port = addr.port;
        resolve();
      });
    });

    return this.getLocalUrl();
  }

  getLocalUrl() {
    if (!this.port) return null;
    return `http://127.0.0.1:${this.port}`;
  }

  async _handleConnect(req, clientSocket, head) {
    const { host, port } = parseAuthority(req.url, req.headers.host);
    if (!host || !port) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    let upstreamSocket = null;
    try {
      upstreamSocket = await openUpstreamTunnel(this.upstream, host, port, this.options);
      this.sockets.add(upstreamSocket);
      upstreamSocket.on('close', () => this.sockets.delete(upstreamSocket));
      this.stats.tunnelsOpened += 1;

      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: NewShooter-ProxyBridge\r\n\r\n');
      if (head && head.length > 0) upstreamSocket.write(head);

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);

      const teardown = () => {
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
        if (!clientSocket.destroyed) clientSocket.destroy();
      };
      upstreamSocket.on('error', teardown);
      clientSocket.on('error', teardown);
    } catch (err) {
      this.stats.errors += 1;
      if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
      if (!clientSocket.destroyed) {
        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n${err.message}`);
      }
    }
  }

  async _handleHttpRequest(clientReq, clientRes) {
    // Pause synchronously before any await so POST/PUT/PATCH bodies are never lost while dialing upstream
    clientReq.pause();
    this.stats.httpRequests += 1;
    let parsedTarget;
    try {
      const targetStr = /^https?:\/\//i.test(clientReq.url)
        ? clientReq.url
        : `http://${clientReq.headers.host || 'localhost'}${clientReq.url}`;
      parsedTarget = new URL(targetStr);
    } catch {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad proxy request URL');
      return;
    }

    const upstream = this.upstream;
    // Upstream HTTP proxy: forward full absolute URL with Proxy-Authorization
    if (upstream && (upstream.protocol === 'http' || upstream.protocol === 'https')) {
      const fwdHeaders = { ...clientReq.headers };
      delete fwdHeaders['proxy-connection'];
      if (upstream.username || upstream.password) {
        const token = Buffer.from(`${upstream.username || ''}:${upstream.password || ''}`).toString('base64');
        fwdHeaders['proxy-authorization'] = `Basic ${token}`;
      }

      const opts = {
        host: upstream.host,
        port: upstream.port,
        method: clientReq.method,
        path: parsedTarget.href,
        headers: fwdHeaders,
        ...(upstream.protocol === 'https' && this.options.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: this.options.rejectUnauthorized }
          : {})
      };

      const proxyReq = (upstream.protocol === 'https'
        ? require('node:https')
        : http).request(opts, (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      });

      proxyReq.on('error', (err) => {
        this.stats.errors += 1;
        if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end(`Upstream proxy error: ${err.message}`);
      });

      clientReq.pipe(proxyReq);
      clientReq.resume();
      return;
    }

    // SOCKS or Direct: create socket via tunnel & dispatch HTTP over createConnection
    const targetHost = parsedTarget.hostname;
    const targetPort = Number(parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80));
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders['proxy-connection'];
    delete fwdHeaders['proxy-authorization'];
    fwdHeaders.host = parsedTarget.host;

    let tunneledSocket = null;
    try {
      tunneledSocket = await openUpstreamTunnel(upstream, targetHost, targetPort, this.options);
      this.sockets.add(tunneledSocket);
      tunneledSocket.on('close', () => this.sockets.delete(tunneledSocket));

      const isHttps = parsedTarget.protocol === 'https:';
      const reqModule = isHttps ? require('node:https') : http;
      const tlsOpts = this.options.rejectUnauthorized !== undefined
        ? { rejectUnauthorized: this.options.rejectUnauthorized }
        : {};
      class TunnelAgent extends reqModule.Agent {
        createConnection(opts, cb) {
          const s = isHttps ? tls.connect({ socket: tunneledSocket, servername: targetHost, ...tlsOpts }) : tunneledSocket;
          if (cb) cb(null, s);
          return s;
        }
      }
      const upstreamReq = reqModule.request({
        host: targetHost,
        port: targetPort,
        path: `${parsedTarget.pathname}${parsedTarget.search}`,
        method: clientReq.method,
        headers: fwdHeaders,
        agent: new TunnelAgent()
      }, (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      });

      upstreamReq.on('error', (err) => {
        this.stats.errors += 1;
        if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end(`Proxy tunnel request failed: ${err.message}`);
      });

      clientReq.on('aborted', () => {
        upstreamReq.destroy();
        if (tunneledSocket && !tunneledSocket.destroyed) tunneledSocket.destroy();
      });

      clientReq.pipe(upstreamReq);
      clientReq.resume();
    } catch (err) {
      this.stats.errors += 1;
      if (tunneledSocket && !tunneledSocket.destroyed) tunneledSocket.destroy();
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Proxy connect failed: ${err.message}`);
    }
  }

  async stop() {
    for (const sock of this.sockets) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

/**
 * Verify a proxy's connectivity & outbound IP via a lightweight HTTP request
 * routed through a temporary ProxyBridge.
 */
async function probeProxyIp(proxyInput, options = {}) {
  const startedAt = Date.now();
  const parsed = parseProxy(proxyInput);
  const checkUrl = options.checkUrl || 'http://ip-api.com/json/?fields=status,query,country,isp,message';
  const timeoutMs = options.timeoutMs || 10000;

  const bridgeOpts = options.rejectUnauthorized !== undefined
    ? { rejectUnauthorized: options.rejectUnauthorized }
    : {};
  const bridge = new ProxyBridge(parsed, bridgeOpts);
  try {
    const localProxyUrl = await bridge.start();
    const proxyParsed = new URL(localProxyUrl);
    const targetUrl = new URL(checkUrl);

    const payload = await new Promise((resolve, reject) => {
      const req = http.request({
        host: proxyParsed.hostname,
        port: Number(proxyParsed.port),
        method: 'GET',
        path: targetUrl.href,
        headers: { Host: targetUrl.host, Accept: 'application/json' },
        timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
      req.on('timeout', () => {
        req.destroy(new Error('Proxy IP probe timeout'));
      });
      req.on('error', reject);
      req.end();
    });

    if (payload.statusCode >= 400) {
      return { ok: false, error: `HTTP ${payload.statusCode}: ${payload.body.slice(0, 120)}`, latencyMs: Date.now() - startedAt };
    }

    let ip = payload.body.trim();
    let country = '';
    let isp = '';
    try {
      const json = JSON.parse(payload.body);
      ip = json.query || json.ip || json.origin || ip;
      country = json.country || json.country_name || '';
      isp = json.isp || json.org || '';
    } catch {
      // plain text IP response
    }

    return {
      ok: Boolean(ip),
      ip,
      country,
      isp,
      latencyMs: Date.now() - startedAt
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      latencyMs: Date.now() - startedAt
    };
  } finally {
    await bridge.stop();
  }
}

module.exports = {
  ProxyBridge,
  connectViaSocks5,
  connectViaSocks4,
  connectViaHttpProxy,
  openUpstreamTunnel,
  probeProxyIp
};
