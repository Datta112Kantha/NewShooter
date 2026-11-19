'use strict';

const crypto = require('node:crypto');
const { parseBulkCredentials, detectProviderFromEmail } = require('../core/credentials');

function extractEmail(str) {
  if (!str) return '';
  const match = String(str).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : '';
}

function detectProvider(email, url = '', provider = '') {
  if (provider && provider !== 'gmail') return provider;
  const pFromEmail = detectProviderFromEmail(email);
  if (pFromEmail && pFromEmail !== 'gmail') return pFromEmail;
  const lowerUrl = String(url || '').toLowerCase();
  if (lowerUrl.includes('outlook.') || lowerUrl.includes('live.com') || lowerUrl.includes('office365')) return 'outlook';
  if (lowerUrl.includes('yahoo.') || lowerUrl.includes('ymail.')) return 'yahoo';
  if (lowerUrl.includes('icloud.')) return 'icloud';
  return pFromEmail || provider || 'gmail';
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createAcceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(`${secWebSocketKey}${WS_GUID}`).digest('base64');
}

function encodeFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(String(payloadBuf || ''), 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }

  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let pos = offset + 2;

    if (payloadLen === 126) {
      if (pos + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (payloadLen === 127) {
      if (pos + 8 > buffer.length) break;
      const hi = buffer.readUInt32BE(pos);
      const lo = buffer.readUInt32BE(pos + 4);
      payloadLen = hi * 0x100000000 + lo;
      pos += 8;
    }

    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + payloadLen > buffer.length) break;

    let maskKey = null;
    if (masked) {
      maskKey = buffer.subarray(pos, pos + 4);
      pos += 4;
    }

    const rawPayload = Buffer.from(buffer.subarray(pos, pos + payloadLen));
    if (masked && maskKey) {
      for (let i = 0; i < rawPayload.length; i++) {
        rawPayload[i] ^= maskKey[i % 4];
      }
    }

    frames.push({ fin, opcode, payload: rawPayload });
    offset = pos + payloadLen;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

class WsClient {
  constructor(socket, role, meta = {}) {
    this.id = `ws_${crypto.randomBytes(6).toString('hex')}`;
    this.socket = socket;
    this.role = role; // 'agent' | 'dashboard'
    this.meta = meta;
    this.accountId = null;
    this.email = null;
    this.tabId = null;
    this.alive = true;
    this.closed = false;
  }

  sendJson(obj) {
    if (this.closed || this.socket.destroyed) return false;
    try {
      const frame = encodeFrame(0x1, JSON.stringify(obj));
      this.socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  ping() {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
    } catch {
      // ignore
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const reasonBuf = Buffer.from(reason, 'utf8');
      const buf = Buffer.alloc(2 + reasonBuf.length);
      buf.writeUInt16BE(code, 0);
      reasonBuf.copy(buf, 2);
      this.socket.end(encodeFrame(0x8, buf));
    } catch {
      this.socket.destroy();
    }
  }
}

/**
 * Zero-dependency RFC 6455 WebSocket Hub routing Extension Agents & Admin Dashboards.
 */
class WsHub {
  constructor(store, options = {}) {
    this.store = store;
    this.browserManager = options.browserManager || null;
    this.clients = new Set();
    this.agentsByAccount = new Map(); // accountId -> WsClient
    this.onTaskEvent = options.onTaskEvent || (() => {});
    this._pingTimer = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.close(1001, 'Heartbeat timeout');
          this.clients.delete(c);
          continue;
        }
        c.alive = false;
        c.ping();
      }
    }, 25000);
    this._pingTimer.unref();
  }

  _isOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (/^chrome-extension:\/\//i.test(origin)) return true;
    try {
      const originUrl = new URL(origin);
      const hostHeader = String(req.headers.host || '');
      if (hostHeader && originUrl.host.toLowerCase() === hostHeader.toLowerCase()) {
        return true;
      }
      const reqPort = hostHeader.includes(':') ? hostHeader.split(':').pop() : '';
      const isLoopbackOrigin = originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost';
      const isLoopbackReq = hostHeader.startsWith('127.0.0.1') || hostHeader.startsWith('localhost');
      if (isLoopbackOrigin && isLoopbackReq && (!reqPort || originUrl.port === reqPort)) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  _getDashboardSessionId(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      const v = decodeURIComponent(part.slice(eq + 1).trim());
      if ((k === 'relay_sid' || k === 'PHPSESSID') && v && this.store.getSession(v)) {
        return v;
      }
    }
    return null;
  }

  _hasValidDashboardSession(req) {
    return Boolean(this._getDashboardSessionId(req));
  }

  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgradeHeader !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    if (!this._isOriginAllowed(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const reqUrl = new URL(req.url || '/', 'http://localhost');
    const role = reqUrl.pathname.startsWith('/ws/dashboard') ? 'dashboard' : 'agent';
    const sid = role === 'dashboard' ? this._getDashboardSessionId(req) : null;
    if (role === 'dashboard' && !sid) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }

    const accept = createAcceptKey(key);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n');
    socket.write(responseHeaders);

    const client = new WsClient(socket, role, {
      ip: req.socket.remoteAddress || '127.0.0.1',
      url: req.url,
      sid
    });
    client.sessionId = sid;
    this.clients.add(client);

    let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let fragmentedChunks = [];
    let fragmentedOpcode = 0;

    socket.on('data', (chunk) => {
      client.alive = true;
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, remaining } = decodeFrames(buffer);
      buffer = remaining;

      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          client.close(1000);
          this._removeClient(client);
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0xa) {
          client.alive = true;
          continue;
        }

        if (frame.opcode === 0x0) {
          fragmentedChunks.push(frame.payload);
          if (frame.fin) {
            const full = Buffer.concat(fragmentedChunks);
            const op = fragmentedOpcode;
            fragmentedChunks = [];
            fragmentedOpcode = 0;
            if (op === 0x1) this._onTextMessage(client, full.toString('utf8'));
          }
          continue;
        }

        if (!frame.fin) {
          fragmentedOpcode = frame.opcode;
          fragmentedChunks = [frame.payload];
          continue;
        }

        if (frame.opcode === 0x1) {
          this._onTextMessage(client, frame.payload.toString('utf8'));
        }
      }
    });

    socket.on('close', () => this._removeClient(client));
    socket.on('error', () => this._removeClient(client));

    if (role === 'dashboard') {
      client.sendJson({
        type: 'DASHBOARD_SYNC',
        role: 'dashboard',
        onlineTabs: this.store.listOnlineTabs(),
        shootState: this.store.state.shootState
      });
      client.sendJson({
        type: 'HELLO',
        role: 'dashboard'
      });
    }
  }

  _removeClient(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    if (client.accountId && this.agentsByAccount.get(client.accountId) === client) {
      this.agentsByAccount.delete(client.accountId);
      const tab = Object.values(this.store.state.onlineTabs).find((t) => t.accountId === client.accountId);
      if (tab) {
        this.store.upsertOnlineTab({ ...tab, isActive: false, status: 'Offline' });
        this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
      }
    }
  }

  _updateTabsFromAgent(client, tabsList) {
    if (!Array.isArray(tabsList)) return;
    for (const t of tabsList) {
      const extractedEmail = extractEmail(t.email) || extractEmail(t.title) || extractEmail(t.url) || extractEmail(t.tabName) || extractEmail(client.email) || '';
      const isLoginStage = t.status === 'login_pending'
        || /login|pending|unauth/i.test(String(t.status || ''))
        || /login|pending|unauth/i.test(String(t.email || ''))
        || /(?:accounts\.google\.com|login\.(?:live|yahoo|microsoftonline)\.com)/i.test(String(t.url || ''));

      const rawEmail = extractedEmail || (isLoginStage ? (t.email || 'Login Pending') : (t.email || ''));
      const resolvedProvider = t.provider || detectProvider(extractedEmail || rawEmail, t.url, t.provider);
      const accId = t.accountId || (client.accountId && !client.accountId.startsWith('ext_') ? client.accountId : null) || (extractedEmail || `tab_${t.tabId || 0}`);
      if (extractedEmail && !client.email) {
        client.email = extractedEmail;
      }

      let account = null;
      if (extractedEmail) {
        account = this.store.getAccount(accId) || this.store.getAccount(extractedEmail);
        if (!account) {
          account = this.store.upsertAccount({
            id: accId,
            email: extractedEmail,
            provider: resolvedProvider,
            proxy: t.proxy || ''
          });
        }
      } else if (t.accountId) {
        account = this.store.getAccount(t.accountId);
      }

      const placeholderKeys = [`${accId}:0`, `${accId}:pw`];
      let inherited = {};
      for (const pk of placeholderKeys) {
        if (this.store.state.onlineTabs[pk]) {
          inherited = { ...this.store.state.onlineTabs[pk] };
          delete this.store.state.onlineTabs[pk];
        }
      }

      const finalEmail = extractedEmail || inherited.email || account?.email || (isLoginStage ? (t.email || 'Login Pending') : '');
      const finalProvider = resolvedProvider || inherited.provider || account?.provider || 'gmail';
      const finalStatus = isLoginStage ? (t.status || 'login_pending') : (t.status || 'Idle');

      const targetKey = t.key || t.tabKey || `${accId || 'ext'}:${t.tabId || 0}`;

      this.store.upsertOnlineTab({
        tabKey: targetKey,
        key: targetKey,
        tabId: t.tabId ?? 0,
        windowId: t.windowId ?? t.window ?? undefined,
        accountId: accId,
        email: finalEmail,
        provider: finalProvider,
        tabName: t.title || t.tabName || inherited.tabName || (isLoginStage ? `${finalProvider} (Login Pending #${t.tabId || 1})` : `${finalProvider} #${t.tabId || 1}`),
        status: finalStatus,
        url: t.url || inherited.url || '',
        dataAllocated: inherited.dataAllocated,
        ip: t.ip || inherited.ip || '127.0.0.1',
        proxy: t.proxy || inherited.proxy,
        pinned: inherited.pinned,
        inbox: t.inboxCount ?? t.inbox,
        draft: t.draftCount ?? t.draft,
        sent: t.sentCount ?? t.sent,
        spam: t.spamCount ?? t.spam,
        isBlocked: Boolean(t.isBlocked),
        isActive: true
      });
    }
    this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
  }

  _onTextMessage(client, rawText) {
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return;
    }
    const type = String(msg.type || '').toUpperCase();

    if (type === 'PING_TABS' || type === 'REFRESH_TABS') {
      this.broadcastAgents({ type: 'PING_TABS' });
      client.sendJson({
        type: 'TABS_UPDATED',
        onlineTabs: this.store.listOnlineTabs(),
        shootState: this.store.state.shootState
      });
      return;
    }

    if (type === 'PONG_TABS' || type === 'TAB_UPDATE' || type === 'TABS_UPDATE' || type === 'PING_TABS_RESPONSE' || type === 'PING_TABS_REPLY' || type === 'TABS_STATUS') {
      client.alive = true;
      if (Array.isArray(msg.tabs)) {
        this._updateTabsFromAgent(client, msg.tabs);
      } else if (msg.tab && typeof msg.tab === 'object') {
        this._updateTabsFromAgent(client, [msg.tab]);
      } else if (msg.tabId !== undefined) {
        this._updateTabsFromAgent(client, [msg]);
      }
      return;
    }

    if (type === 'REGISTER_AGENT' || type === 'HELLO') {
      const detectedEmail = msg.email || extractEmail(msg.tabName) || extractEmail(msg.title) || extractEmail(msg.url) || '';
      const provider = msg.isYahoo ? 'yahoo' : (msg.isIcloud ? 'icloud' : (msg.provider || detectProvider(detectedEmail, msg.url)));
      const accountId = msg.accountId || (detectedEmail || `ext_${client.id}`);
      client.accountId = accountId;
      client.email = detectedEmail || msg.email || '';
      client.tabId = msg.tabId ?? client.tabId;
      this.agentsByAccount.set(accountId, client);

      let account = this.store.getAccount(accountId) || (client.email ? this.store.getAccount(client.email) : null);
      if (!account && client.email) {
        account = this.store.upsertAccount({
          id: accountId,
          email: client.email,
          provider,
          proxy: msg.proxy || ''
        });
      }

      const resolvedAccId = account ? account.id : accountId;
      const finalEmail = client.email || (account ? account.email : '');
      const finalProvider = provider || (account ? account.provider : 'gmail');

      if (finalEmail || account || msg.tabId !== undefined) {
        const existingForAccount = Object.values(this.store.state.onlineTabs).find(
          (t) => t.accountId === resolvedAccId || t.accountId === accountId || (msg.tabId !== undefined && t.tabId === msg.tabId)
        );
        const targetKey = (!msg.tabId && existingForAccount)
          ? existingForAccount.key
          : `${resolvedAccId}:${msg.tabId || 0}`;
        this.store.upsertOnlineTab({
          tabKey: targetKey,
          tabId: msg.tabId ?? existingForAccount?.tabId ?? 0,
          accountId: resolvedAccId,
          email: finalEmail || existingForAccount?.email || '',
          provider: finalProvider || existingForAccount?.provider || 'gmail',
          tabName: msg.tabName || msg.profileName || existingForAccount?.tabName || `${finalProvider} #${msg.tabId || 1}`,
          status: msg.status || existingForAccount?.status || 'Idle',
          isActive: true,
          ip: msg.outboundIp || account?.outboundIp || existingForAccount?.ip || '127.0.0.1',
          proxy: msg.proxy || account?.proxy || existingForAccount?.proxy || ''
        });
      }

      client.sendJson({
        type: type === 'HELLO' ? 'hello_ack' : 'REGISTER_SUCCESS',
        ok: true,
        success: true,
        ts: Date.now(),
        accountId: account ? account.id : accountId,
        email: account?.email || finalEmail || '',
        password: account?.password || '',
        recovery: account?.recovery || '',
        twoFa: account?.twoFa || '',
        proxy: account?.proxy || '',
        provider: account?.provider || finalProvider,
        automationSettings: this.store.state.automationSettings
      });

      this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
      return;
    }

    if (type === 'HEARTBEAT') {
      client.alive = true;
      if (Array.isArray(msg.tabs)) {
        this._updateTabsFromAgent(client, msg.tabs);
      } else if (msg.tabId !== undefined) {
        // Native RelayWsClient single-tab heartbeat
        const tab = Object.values(this.store.state.onlineTabs).find(
          (t) => t.tabId === msg.tabId || (client.accountId && t.accountId === client.accountId)
        );
        if (tab) {
          if (msg.inbox !== undefined) tab.inbox = Number(msg.inbox) || 0;
          if (msg.draft !== undefined) tab.draft = Number(msg.draft) || 0;
          if (msg.sent !== undefined) tab.sent = Number(msg.sent) || 0;
          if (msg.spam !== undefined) tab.spam = Number(msg.spam) || 0;
          if (msg.status) tab.status = msg.status;
          if (msg.windowId !== undefined) tab.windowId = msg.windowId;
          const extracted = msg.email || extractEmail(msg.title) || extractEmail(msg.url);
          if (extracted && (!tab.email || tab.email.trim() === '' || tab.email.includes('Login Pending'))) {
            tab.email = extracted;
            tab.provider = msg.provider || detectProvider(extracted, msg.url);
            if (tab.status === 'login_pending') tab.status = 'Idle';
          }
          tab.isActive = true;
          this.store.upsertOnlineTab(tab);
          this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
        }
      }
      client.sendJson({ type: 'HEARTBEAT_ACK', ts: Date.now() });
      return;
    }

    if (type === 'PROGRESS') {
      const tab = Object.values(this.store.state.onlineTabs).find(
        (t) => t.tabId === msg.tabId || (client.accountId && t.accountId === client.accountId)
      );
      if (tab) {
        tab.sent = Number(msg.sent) || tab.sent;
        tab.status = msg.done ? 'Completed' : `Sending (${msg.sent}/${msg.total || '?'})`;
        if (msg.done) {
          this.store.state.shootQuota.sentToday += 1;
          this.store.state.shootState.completedTasks += 1;
        }
        this.store.upsertOnlineTab(tab);
        this.broadcastDashboards({
          type: 'TASK_STATUS_UPDATE',
          event: msg,
          onlineTabs: this.store.listOnlineTabs(),
          shootState: this.store.state.shootState
        });
      }
      return;
    }

    if (type === 'RECALL') {
      const tab = Object.values(this.store.state.onlineTabs).find(
        (t) => t.tabId === msg.tabId || (client.accountId && t.accountId === client.accountId)
      );
      if (tab && msg.data) {
        if (msg.data.status) tab.status = msg.data.status;
        this.store.upsertOnlineTab(tab);
        this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
      }
      return;
    }

    if (type === 'AGENT_INBOX_READY') {
      const linked = this.store.getAccount(msg.accountId || msg.email);
      const accountId = linked?.id || client.accountId || msg.accountId || msg.email || client.id;
      client.accountId = accountId;
      client.email = msg.email || linked?.email || client.email;
      client.tabId = msg.tabId ?? client.tabId;
      this.agentsByAccount.set(accountId, client);

      let inherited = {};
      if (msg.tabId) {
        for (const pk of [`${accountId}:0`, `${accountId}:pw`]) {
          if (this.store.state.onlineTabs[pk]) {
            inherited = { ...inherited, ...this.store.state.onlineTabs[pk] };
            delete this.store.state.onlineTabs[pk];
          }
        }
      }

      this.store.upsertOnlineTab({
        tabKey: `${accountId}:${msg.tabId || 0}`,
        tabId: msg.tabId || 0,
        accountId,
        email: msg.email || linked?.email || inherited.email || '',
        provider: msg.provider || linked?.provider || inherited.provider || 'gmail',
        tabName: msg.tabName || inherited.tabName || `${msg.provider || 'gmail'} #${msg.tabId || 1}`,
        dataAllocated: inherited.dataAllocated,
        pinned: inherited.pinned,
        sentToday: inherited.sentToday,
        inbox: msg.inboxCount ?? 0,
        draft: msg.draftCount ?? 0,
        sent: msg.sentCount ?? 0,
        spam: msg.spamCount ?? 0,
        isBlocked: Boolean(msg.isBlocked),
        status: msg.isBlocked ? 'Blocked' : 'Idle',
        isActive: true,
        ip: msg.outboundIp || linked?.outboundIp || inherited.ip || undefined,
        proxy: linked?.proxy || inherited.proxy
      });
      this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
      if (typeof this.onInboxReady === 'function') {
        try {
          const freshTab = this.store.state.onlineTabs[`${accountId}:${msg.tabId || 0}`]
            || Object.values(this.store.state.onlineTabs).find((t) => t.accountId === accountId);
          this.onInboxReady(accountId, freshTab);
        } catch (e) {
          console.error('Error in onInboxReady callback:', e);
        }
      }
      return;
    }

    if (type === 'TASK_STATUS_UPDATE' || type === 'DISPATCH_RESULT') {
      const targetAccId = msg.accountId || client.accountId;
      const targetEmail = String(msg.email || client.email || '').toLowerCase();
      const tab = Object.values(this.store.state.onlineTabs).find(
        (t) => (targetAccId && t.accountId === targetAccId)
          || (msg.tabId && t.tabId === msg.tabId)
          || (targetEmail && String(t.email || '').toLowerCase() === targetEmail)
      );
      if (tab) {
        const isDone = msg.status === 'SENT' || msg.status === 'COMPLETED';
        const isErr = msg.status === 'FAILED' || msg.status === 'ERROR' || msg.status === 'BLOCKED';
        this.store.upsertOnlineTab({
          ...tab,
          status: msg.step || msg.status || tab.status,
          sent: isDone ? tab.sent + 1 : tab.sent,
          sentToday: isDone ? tab.sentToday + 1 : tab.sentToday,
          isBlocked: msg.status === 'BLOCKED' ? true : tab.isBlocked
        });
        if (isDone) {
          this.store.state.shootQuota.sentToday += 1;
          this.store.state.shootState.completedTasks += 1;
        } else if (isErr) {
          this.store.state.shootState.failedTasks += 1;
        }
        this.store.save();
      }
      this.onTaskEvent(msg);
      this.broadcastDashboards({
        type: 'TASK_STATUS_UPDATE',
        event: msg,
        onlineTabs: this.store.listOnlineTabs(),
        shootState: this.store.state.shootState,
        shootQuota: this.store.state.shootQuota
      });
      return;
    }

    if (type === 'FOLDER_COUNTS_RESULT') {
      const targetAccId = msg.accountId || client.accountId;
      const targetEmail = String(msg.email || client.email || '').toLowerCase();
      const tab = Object.values(this.store.state.onlineTabs).find(
        (t) => (targetAccId && t.accountId === targetAccId)
          || (msg.tabId && t.tabId === msg.tabId)
          || (targetEmail && String(t.email || '').toLowerCase() === targetEmail)
      );
      if (tab) {
        this.store.upsertOnlineTab({
          ...tab,
          inbox: msg.inbox ?? tab.inbox,
          draft: msg.draft ?? tab.draft,
          sent: msg.sent ?? tab.sent,
          spam: msg.spam ?? tab.spam,
          isBlocked: Boolean(msg.isBlocked ?? tab.isBlocked),
          replies: Array.isArray(msg.replies) ? msg.replies : tab.replies
        });
        this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
      }
      return;
    }

    if (type === 'VERIFICATION_STATUS' || type === 'AGENT_ALERT') {
      const accountId = msg.accountId || client.accountId;
      const targetEmail = String(msg.email || client.email || '').toLowerCase();
      const tab = Object.values(this.store.state.onlineTabs).find(
        (t) => (accountId && t.accountId === accountId)
          || (msg.tabId && t.tabId === msg.tabId)
          || (targetEmail && String(t.email || '').toLowerCase() === targetEmail)
      );
      if (tab) {
        const fatal = msg.severity === 'fatal'
          || msg.severity === 'blocked'
          || /suspend|disable|wrong_password/i.test(String(msg.code || msg.statusText || msg.message || ''));
        this.store.upsertOnlineTab({
          ...tab,
          status: msg.statusText || msg.message || msg.status || tab.status,
          isBlocked: fatal ? true : tab.isBlocked
        });
      }
      this.broadcastDashboards({ type, event: msg, onlineTabs: this.store.listOnlineTabs() });
      return;
    }

    if (type === 'LAUNCH_ISOLATED_ACCOUNTS') {
      this._handleLaunchIsolatedAccounts(client, msg);
      return;
    }

    // SMS verification pool IPC directly over WS
    if (type === 'SMS_POOL_REQUEST') {
      const item = this.store.verificationPool.getNextAvailable(msg.email);
      this.store.save();
      client.sendJson({ type: 'SMS_POOL_RESPONSE', requestId: msg.requestId, item });
      this.broadcastDashboards({ type: 'SMS_POOL_UPDATED', stats: this.store.verificationPool.getStats() });
      return;
    }
    if (type === 'SMS_POOL_VERIFY') {
      this.store.verificationPool.markVerified(msg.phone);
      this.store.save();
      this.broadcastDashboards({ type: 'SMS_POOL_UPDATED', stats: this.store.verificationPool.getStats() });
      return;
    }
    if (type === 'SMS_POOL_ERROR') {
      this.store.verificationPool.markPermanentError(msg.phone, msg.error);
      this.store.save();
      this.broadcastDashboards({ type: 'SMS_POOL_UPDATED', stats: this.store.verificationPool.getStats() });
      return;
    }
    if (type === 'SMS_POOL_RELEASE') {
      if (msg.phone) this.store.verificationPool.release(msg.phone);
      else if (msg.email) this.store.verificationPool.releaseByEmail(msg.email);
      this.store.save();
      this.broadcastDashboards({ type: 'SMS_POOL_UPDATED', stats: this.store.verificationPool.getStats() });
    }
  }

  async _handleLaunchIsolatedAccounts(client, msg) {
    const requestId = msg.requestId;
    if (!this.browserManager) {
      client.sendJson({
        type: 'LAUNCH_ISOLATED_RESULT',
        requestId,
        ok: false,
        launched: 0,
        error: 'BrowserManager not available on controller'
      });
      return;
    }

    const defaultProxy = String(msg.defaultProxy || '').trim();
    let parsedAccounts = [];
    const errors = [];
    if (msg.bulk) {
      const res = parseBulkCredentials(msg.bulk);
      parsedAccounts = res.accounts || [];
      for (const inv of res.invalid || []) {
        errors.push({ email: inv.line || `line ${inv.lineNumber}`, error: `Invalid account line #${inv.lineNumber}` });
      }
    } else if (Array.isArray(msg.accounts)) {
      parsedAccounts = msg.accounts.filter((a) => a && a.email);
    }

    if (parsedAccounts.length === 0) {
      client.sendJson({
        type: 'LAUNCH_ISOLATED_RESULT',
        requestId,
        ok: false,
        launched: 0,
        errors,
        error: errors[0]?.error || 'No valid accounts provided'
      });
      return;
    }

    const results = [];
    for (const item of parsedAccounts) {
      try {
        if (item.proxyError) {
          throw new Error(item.proxyError);
        }
        const accountInput = {
          ...item,
          proxy: item.proxy || defaultProxy
        };
        const saved = this.store.upsertAccount(accountInput);
        const launchOpts = {};
        if (msg.headless !== undefined) launchOpts.headless = Boolean(msg.headless);
        if (msg.startUrl) launchOpts.startUrl = msg.startUrl;
        if (msg.ipCheckUrl) launchOpts.ipCheckUrl = msg.ipCheckUrl;
        const launched = await this.browserManager.launchAccount(saved.id, launchOpts);
        results.push({
          accountId: saved.id,
          email: saved.email,
          probe: launched.probe,
          navError: launched.navError,
          url: launched.url
        });
      } catch (err) {
        errors.push({ email: item.email, error: err.message });
      }
    }

    this.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: this.store.listOnlineTabs() });
    client.sendJson({
      type: 'LAUNCH_ISOLATED_RESULT',
      requestId,
      ok: results.length > 0,
      launched: results.length,
      results,
      errors,
      error: results.length === 0 ? (errors[0]?.error || 'Launch failed') : ''
    });
  }

  isAccountConnected(accountId) {
    if (!accountId) return false;
    const exact = this.agentsByAccount.get(accountId);
    if (exact && !exact.closed && !exact.socket?.destroyed) return true;
    const acc = this.store.getAccount(accountId);
    const accEmail = acc?.email ? acc.email.toLowerCase() : '';
    const targetLower = String(accountId).toLowerCase();
    for (const c of this.clients) {
      if (c.role !== 'agent' || c.closed || c.socket?.destroyed) continue;
      const cEmail = String(c.email || '').toLowerCase();
      if (
        c.accountId === accountId ||
        (targetLower && cEmail === targetLower) ||
        (accEmail && cEmail === accEmail)
      ) {
        return true;
      }
    }
    return false;
  }

  sendToAccount(accountId, payload) {
    const exact = this.agentsByAccount.get(accountId);
    if (exact && !exact.closed && !exact.socket.destroyed && exact.sendJson(payload)) return true;
    const acc = this.store.getAccount(accountId);
    const accEmail = acc?.email ? acc.email.toLowerCase() : '';
    const targetLower = String(accountId || '').toLowerCase();
    // Fallback: broadcast to connected agents matching email or accountId
    for (const c of this.clients) {
      if (c.role !== 'agent' || c.closed || c.socket.destroyed) continue;
      const cEmail = String(c.email || '').toLowerCase();
      if (
        c.accountId === accountId ||
        (targetLower && cEmail === targetLower) ||
        (accEmail && cEmail === accEmail)
      ) {
        if (c.sendJson(payload)) return true;
      }
    }
    return false;
  }

  broadcastAgents(payload) {
    let sent = 0;
    for (const c of this.clients) {
      if (c.role === 'agent' && c.sendJson(payload)) sent++;
    }
    return sent;
  }

  broadcastDashboards(payload) {
    for (const c of this.clients) {
      if (c.role === 'dashboard') c.sendJson(payload);
    }
  }

  closeDashboardSessions(sid = null) {
    for (const c of Array.from(this.clients)) {
      if (c.role === 'dashboard') {
        if (!sid || c.sessionId === sid || (c.meta && c.meta.sid === sid) || !this.store.getSession(c.sessionId)) {
          c.close(1000, 'Logged out');
          this._removeClient(c);
        }
      }
    }
  }

  closeAll() {
    clearInterval(this._pingTimer);
    for (const c of this.clients) {
      c.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.agentsByAccount.clear();
  }
}

module.exports = { WsHub, encodeFrame, decodeFrames, createAcceptKey };
