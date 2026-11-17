'use strict';

const http = require('node:http');
const net = require('node:net');

/**
 * Start a local SOCKS5 server (supports no-auth or username/password auth RFC 1929)
 * that optionally rewrites plain HTTP targets or simply tunnels TCP connections.
 */
function startMockSocks5Server({ username = '', password = '', hostMap = {} } = {}) {
  const sockets = new Set();
  const stats = { tunnelsOpened: 0, requestedHosts: [] };
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));

    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    let remote = null;

    client.on('data', (chunk) => {
      if (stage === 'tunnel' && remote) {
        remote.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const nMethods = buf[1];
        if (buf.length < 2 + nMethods) return;
        const methods = [...buf.subarray(2, 2 + nMethods)];
        buf = buf.subarray(2 + nMethods);
        if (username || password) {
          if (!methods.includes(0x02)) {
            client.end(Buffer.from([0x05, 0xff]));
            return;
          }
          stage = 'auth';
          client.write(Buffer.from([0x05, 0x02]));
        } else {
          stage = 'request';
          client.write(Buffer.from([0x05, 0x00]));
        }
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const u = buf.subarray(2, 2 + ulen).toString('utf8');
        const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
        buf = buf.subarray(3 + ulen + plen);

        if (u === username && p === password) {
          stage = 'request';
          client.write(Buffer.from([0x01, 0x00]));
        } else {
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }
      }

      if (stage === 'request') {
        if (buf.length < 4) return;
        const cmd = buf[1];
        const atyp = buf[3];
        let host = '';
        let pos = 4;
        if (atyp === 0x01) {
          if (buf.length < pos + 6) return;
          host = [...buf.subarray(pos, pos + 4)].join('.');
          pos += 4;
        } else if (atyp === 0x03) {
          if (buf.length < pos + 1) return;
          const len = buf[pos];
          if (buf.length < pos + 1 + len + 2) return;
          host = buf.subarray(pos + 1, pos + 1 + len).toString('utf8');
          pos += 1 + len;
        } else if (atyp === 0x04) {
          if (buf.length < pos + 18) return;
          const groups = [];
          for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(pos + i * 2).toString(16));
          host = groups.join(':');
          pos += 16;
        } else {
          client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buf.readUInt16BE(pos);
        const remaining = buf.subarray(pos + 2);
        if (cmd !== 0x01) {
          client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }

        stats.requestedHosts.push(`${host}:${port}`);
        const mappedHost = hostMap[host] || host;
        stage = 'connecting';
        remote = net.createConnection({ host: mappedHost, port }, () => {
          stage = 'tunnel';
          stats.tunnelsOpened += 1;
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (remaining.length > 0) remote.write(remaining);
          remote.pipe(client);
        });
        remote.on('error', () => {
          if (!client.destroyed) client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
        client.on('error', () => { if (remote && !remote.destroyed) remote.destroy(); });
        client.on('close', () => { if (remote && !remote.destroyed) remote.destroy(); });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        stats,
        close: () => new Promise((res) => {
          for (const s of sockets) s.destroy();
          server.close(() => res());
        })
      });
    });
  });
}

/**
 * Start a local HTTP + CONNECT proxy with optional Basic Auth.
 */
function startMockHttpProxy({ username = '', password = '', proxyTag = '', hostMap = {} } = {}) {
  const expectedAuth = (username || password)
    ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    : null;
  const stats = { requests: 0, authChallenges: 0, authedRequests: 0, requestedHosts: [] };

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) {
      stats.authChallenges += 1;
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      res.end('Proxy Authentication Required');
      return;
    }
    stats.authedRequests += 1;
    const targetUrl = new URL(req.url);
    stats.requestedHosts.push(targetUrl.host);
    const mappedHost = hostMap[targetUrl.hostname] || targetUrl.hostname;
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    if (proxyTag) headers['x-proxy-identity'] = proxyTag;

    const up = http.request({
      host: mappedHost,
      port: Number(targetUrl.port || 80),
      method: req.method,
      path: targetUrl.pathname + targetUrl.search,
      headers
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (e) => {
      res.writeHead(502);
      res.end(e.message);
    });
    req.pipe(up);
  });

  server.on('connect', (req, clientSock, head) => {
    stats.requests += 1;
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) {
      stats.authChallenges += 1;
      clientSock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    stats.authedRequests += 1;
    stats.requestedHosts.push(req.url);
    const [host, portStr] = req.url.split(':');
    const mappedHost = hostMap[host] || host;
    const remote = net.createConnection({ host: mappedHost, port: Number(portStr || 443) }, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) remote.write(head);
      remote.pipe(clientSock);
      clientSock.pipe(remote);
    });
    remote.on('error', () => clientSock.destroy());
    clientSock.on('error', () => remote.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        stats,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

module.exports = {
  startMockSocks5Server,
  startMockHttpProxy
};
