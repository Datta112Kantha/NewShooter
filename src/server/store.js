'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VerificationPool } = require('../core/verificationPool');
const { DEFAULT_AUTOMATION_SETTINGS, detectProviderFromEmail } = require('../core/credentials');
const { parseProxy, describeProxy } = require('../proxy/proxyParser');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hex] = storedHash.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const target = Buffer.from(hex, 'hex');
  if (candidate.length !== target.length) return false;
  return crypto.timingSafeEqual(candidate, target);
}

const DEFAULT_CUSTOM_TAGS = {
  '{status}': {
    type: 'random',
    values: ['Completed', 'Pending Review', 'Confirmed', 'Dispatched']
  },
  '{price}': {
    type: 'random',
    values: ['$149.00', '$289.50', '$420.00', '$89.99']
  }
};

class RelayStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), '.data');
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.uploadsDir = path.join(this.dataDir, 'uploads');
    this.convertsDir = path.join(this.dataDir, 'converted');
    this.sessionLimit = Number(options.sessionLimit ?? 2);
    this.adminUser = options.adminUser || process.env.NEWSHOOTER_USER || 'admfib7H';
    this.adminPass = options.adminPass || process.env.NEWSHOOTER_PASS || 'd9tQGJdZ77';

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    fs.mkdirSync(this.convertsDir, { recursive: true });

    this.state = this._loadOrInit();
    this.verificationPool = VerificationPool.fromJSON(this.state.verificationItems || []);
    this.loginCsrfSet = new Set();
  }

  issueLoginCsrf() {
    if (!this.loginCsrfSet) this.loginCsrfSet = new Set();
    const token = crypto.randomBytes(24).toString('hex');
    this.loginCsrfSet.add(token);
    if (this.loginCsrfSet.size > 500) {
      const first = this.loginCsrfSet.values().next().value;
      this.loginCsrfSet.delete(first);
    }
    return token;
  }

  verifyLoginCsrf(token, consume = false) {
    if (!token || !this.loginCsrfSet || !this.loginCsrfSet.has(token)) return false;
    if (consume) {
      this.loginCsrfSet.delete(token);
    }
    return true;
  }

  _defaultState() {
    return {
      version: 1,
      users: {
        [this.adminUser]: {
          username: this.adminUser,
          passwordHash: hashPassword(this.adminPass),
          role: 'admin',
          createdAt: new Date().toISOString()
        },
        akashraj: {
          username: 'akashraj',
          passwordHash: hashPassword('Akash@15'),
          role: 'admin',
          createdAt: new Date().toISOString()
        }
      },
      sessions: [],
      vtEvents: [],
      accounts: [],
      onlineTabs: {},
      dataList: [],
      dataCursor: 0,
      recordsPerTab: 5,
      testRecipients: [],
      testCursor: 0,
      customTags: structuredClone(DEFAULT_CUSTOM_TAGS),
      tagCounters: {},
      compose: {
        subject: '',
        body: '',
        senderName: '',
        updatedAt: new Date().toISOString()
      },
      attachmentConfig: {
        format: 'html',
        filename: 'statement_{orderno}',
        watermark: '',
        htmlSource: '',
        selectedFiles: [],
        updatedAt: new Date().toISOString()
      },
      uploadedFiles: [],
      shootSettings: {
        gmail: 3,
        yahoo: 5,
        outlook: 5,
        layout: 'two-col',
        forceStart: false
      },
      shootQuota: {
        dailyLimit: 60000,
        sentToday: 0,
        expiryHours: 3,
        updatedAt: new Date().toISOString()
      },
      shootState: {
        active: false,
        shootId: null,
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        startedAt: null
      },
      automationSettings: { ...DEFAULT_AUTOMATION_SETTINGS },
      verificationItems: [],
      messages: [
        {
          id: 1,
          sender: 'System',
          text: 'Bin4ry Relay self-hosted controller initialized. Connect Chrome Extension tabs or launch proxied browser profiles to begin.',
          createdAt: new Date().toISOString(),
          read: false
        }
      ],
      gmass: {
        mode: 'gmass2',
        domains: ['gmail.com'],
        fromName: '',
        subject: '',
        message: '',
        pdfHtml: '',
        convertPdf: false,
        watermark: '',
        filename: 'invoice_{orderno}',
        emails: [],
        sentLog: [],
        running: false,
        paused: false
      },
      updatesVersion: '4.1.0-selfhosted'
    };
  }

  _loadOrInit() {
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        const base = this._defaultState();
        const mergedUsers = { ...base.users, ...(raw.users || {}) };
        if (!mergedUsers.akashraj || !verifyPassword('Akash@15', mergedUsers.akashraj.passwordHash)) {
          mergedUsers.akashraj = {
            username: 'akashraj',
            passwordHash: hashPassword('Akash@15'),
            role: 'admin',
            createdAt: new Date().toISOString()
          };
        }
        return {
          ...base,
          ...raw,
          users: mergedUsers,
          compose: { ...base.compose, ...(raw.compose || {}) },
          attachmentConfig: { ...base.attachmentConfig, ...(raw.attachmentConfig || {}) },
          shootSettings: { ...base.shootSettings, ...(raw.shootSettings || {}) },
          shootQuota: { ...base.shootQuota, ...(raw.shootQuota || {}) },
          automationSettings: { ...base.automationSettings, ...(raw.automationSettings || {}) },
          gmass: { ...base.gmass, ...(raw.gmass || {}) }
        };
      } catch {
        // fallback cleanly if corrupted
      }
    }
    const fresh = this._defaultState();
    this._writeRaw(fresh);
    return fresh;
  }

  _writeRaw(stateObj) {
    stateObj.verificationItems = this.verificationPool ? this.verificationPool.toJSON() : (stateObj.verificationItems || []);
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stateObj, null, 2), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  save() {
    this._writeRaw(this.state);
  }

  // ── Authentication & Sessions (with Concurrent Limit Eviction) ────────────
  authenticate(username, password, meta = {}) {
    if (meta.csrfValid === false || meta.csrfError) {
      return { ok: false, error: 'Security token expired. Please refresh the page' };
    }
    if (meta.csrfToken !== undefined) {
      const token = String(meta.csrfToken || '').trim();
      const isValid = Boolean(
        (this.loginCsrfSet && this.loginCsrfSet.has(token)) ||
        (meta.validCsrfTokens && meta.validCsrfTokens.has(token)) ||
        (meta.expectedCsrf && meta.expectedCsrf === token)
      );
      if (!token || !isValid) {
        return { ok: false, error: 'Security token expired. Please refresh the page' };
      }
    }

    const rawUser = username != null ? String(username) : '';
    const trimmedUser = rawUser.trim();
    if (!trimmedUser) {
      return { ok: false, error: 'Please enter your username' };
    }

    if (password === undefined || password === null || password === '') {
      return { ok: false, error: 'Please enter your password' };
    }

    const user = this.state.users[trimmedUser];
    if (!user) {
      return { ok: false, error: `No account found matching username '${username}'` };
    }

    if (!verifyPassword(password, user.passwordHash)) {
      return { ok: false, error: 'Incorrect password entered' };
    }

    const now = Date.now();
    // Prune expired (>24h idle)
    this.state.sessions = this.state.sessions.filter(
      (s) => s.username !== user.username || (now - new Date(s.lastSeen).getTime() < 24 * 3600 * 1000)
    );

    const userSessions = this.state.sessions
      .filter((s) => s.username === user.username)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (userSessions.length >= this.sessionLimit && !meta.forceEvict) {
      return {
        ok: false,
        limitExceeded: true,
        limit: this.sessionLimit,
        activeDevices: userSessions.map((s, idx) => ({
          id: s.id,
          label: `${s.deviceLabel || 'Browser'} (${s.ip || '127.0.0.1'})`,
          createdAt: s.createdAt,
          willSignOut: idx <= (userSessions.length - this.sessionLimit)
        }))
      };
    }

    const evicted = [];
    if (userSessions.length >= this.sessionLimit && meta.forceEvict) {
      const toRemoveCount = userSessions.length - this.sessionLimit + 1;
      for (let i = 0; i < toRemoveCount; i++) {
        evicted.push(userSessions[i].id);
      }
      this.state.sessions = this.state.sessions.filter((s) => !evicted.includes(s.id));
    }

    const token = crypto.randomBytes(24).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const session = {
      id: `sess_${crypto.randomBytes(8).toString('hex')}`,
      token,
      csrfToken,
      username: user.username,
      ip: meta.ip || '127.0.0.1',
      userAgent: meta.userAgent || 'Browser',
      deviceLabel: parseDeviceLabel(meta.userAgent || ''),
      vtId: meta.vtId || '',
      vtFp: meta.vtFp || '',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };

    if (meta.csrfToken && this.loginCsrfSet) {
      this.loginCsrfSet.delete(meta.csrfToken);
    }

    this.state.sessions.push(session);
    this.save();
    return { ok: true, session, evicted };
  }

  getSession(token) {
    if (!token) return null;
    const sess = this.state.sessions.find((s) => s.token === token || s.id === token);
    if (!sess) return null;
    sess.lastSeen = new Date().toISOString();
    return sess;
  }

  destroySession(token) {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((s) => s.token !== token && s.id !== token);
    if (this.state.sessions.length !== before) this.save();
  }

  recordVtEvent(payload) {
    this.state.vtEvents.push({ ...payload, ts: new Date().toISOString() });
    if (this.state.vtEvents.length > 200) {
      this.state.vtEvents = this.state.vtEvents.slice(-200);
    }
    this.save();
  }

  // ── Accounts & Per-Account Proxy Management ───────────────────────────────
  listAccounts({ includeSecrets = false } = {}) {
    return this.state.accounts.map((acc) => ({
      id: acc.id,
      email: acc.email,
      ...(includeSecrets ? { password: acc.password, recovery: acc.recovery, twoFa: acc.twoFa } : {}),
      hasRecovery: Boolean(acc.recovery),
      hasTwoFa: Boolean(acc.twoFa),
      provider: acc.provider,
      proxy: acc.proxy || '',
      proxyInfo: acc.proxy ? safeDescribeProxy(acc.proxy) : null,
      outboundIp: acc.outboundIp || '',
      ipStatus: acc.ipStatus || (acc.proxy ? 'unverified' : 'direct'),
      ipLatencyMs: acc.ipLatencyMs || null,
      ipCheckedAt: acc.ipCheckedAt || null,
      status: acc.status || 'Offline',
      launched: Boolean(acc.launched),
      createdAt: acc.createdAt
    }));
  }

  getAccount(idOrEmail) {
    const raw = String(idOrEmail || '');
    const lower = raw.toLowerCase();
    return this.state.accounts.find((a) => a.id === raw || String(a.email || '').toLowerCase() === lower) || null;
  }

  upsertAccount(input) {
    const email = String(input.email || '').trim();
    if (!email) throw new Error('Account email is required');

    let normalizedProxy = '';
    if (input.proxy && String(input.proxy).trim()) {
      parseProxy(input.proxy); // validates syntax
      normalizedProxy = String(input.proxy).trim();
    }

    const existing = this.state.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      if (input.password !== undefined) existing.password = String(input.password);
      if (input.recovery !== undefined) existing.recovery = String(input.recovery);
      if (input.twoFa !== undefined) existing.twoFa = String(input.twoFa);
      if (input.provider) existing.provider = input.provider;
      if (input.proxy !== undefined) {
        existing.proxy = normalizedProxy;
        existing.ipStatus = normalizedProxy ? 'unverified' : 'direct';
        existing.outboundIp = '';
      }
      if (input.userAgent !== undefined) existing.userAgent = String(input.userAgent);
      existing.updatedAt = new Date().toISOString();
      this.save();
      return existing;
    }

    const account = {
      id: input.id || `acc_${crypto.randomBytes(5).toString('hex')}`,
      email,
      password: String(input.password || ''),
      recovery: String(input.recovery || ''),
      twoFa: String(input.twoFa || ''),
      provider: input.provider || detectProviderFromEmail(email),
      proxy: normalizedProxy,
      outboundIp: '',
      ipStatus: normalizedProxy ? 'unverified' : 'direct',
      ipLatencyMs: null,
      ipCheckedAt: null,
      userAgent: String(input.userAgent || ''),
      status: 'Offline',
      launched: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.state.accounts.push(account);
    this.save();
    return account;
  }

  updateAccountIpStatus(accountId, probeResult) {
    const acc = this.getAccount(accountId);
    if (!acc) return null;
    acc.outboundIp = probeResult.ip || '';
    acc.ipStatus = probeResult.ok ? 'verified' : 'error';
    acc.ipLatencyMs = probeResult.latencyMs ?? null;
    acc.ipCheckedAt = new Date().toISOString();
    acc.ipError = probeResult.error || '';

    // Also mirror to matching onlineTabs rows
    for (const tab of Object.values(this.state.onlineTabs)) {
      if (tab.accountId === acc.id || tab.email === acc.email) {
        tab.ip = acc.outboundIp || tab.ip;
        tab.proxy = acc.proxy;
        tab.ipStatus = acc.ipStatus;
      }
    }
    this.save();
    return acc;
  }

  deleteAccount(id) {
    const before = this.state.accounts.length;
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id && a.email !== id);
    if (this.state.accounts.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  // ── Online Tabs Registry ──────────────────────────────────────────────────
  upsertOnlineTab(tabData) {
    const key = String(tabData.tabKey || tabData.key || tabData.tabId || tabData.accountId || tabData.email);
    const prev = this.state.onlineTabs[key] || {};
    const linkedAcc = tabData.accountId
      ? this.getAccount(tabData.accountId)
      : (tabData.email ? this.getAccount(tabData.email) : null);

    const record = {
      key,
      tabId: tabData.tabId ?? prev.tabId ?? 0,
      accountId: tabData.accountId ?? prev.accountId ?? (linkedAcc ? linkedAcc.id : key),
      email: tabData.email ?? prev.email ?? (linkedAcc ? linkedAcc.email : ''),
      provider: tabData.provider ?? prev.provider ?? (linkedAcc ? linkedAcc.provider : 'gmail'),
      tabName: tabData.tabName ?? prev.tabName ?? `Tab ${tabData.tabId || 1}`,
      dataAllocated: tabData.dataAllocated ?? prev.dataAllocated ?? '',
      inbox: Number(tabData.inbox ?? prev.inbox ?? 0),
      draft: Number(tabData.draft ?? prev.draft ?? 0),
      sent: Number(tabData.sent ?? prev.sent ?? 0),
      spam: Number(tabData.spam ?? prev.spam ?? 0),
      sentToday: Number(tabData.sentToday ?? prev.sentToday ?? 0),
      status: tabData.status ?? prev.status ?? 'Idle',
      progress: tabData.progress ?? prev.progress ?? null,
      isBlocked: Boolean(tabData.isBlocked ?? prev.isBlocked ?? false),
      isActive: tabData.isActive !== undefined ? Boolean(tabData.isActive) : true,
      pinned: Boolean(tabData.pinned ?? prev.pinned ?? false),
      ip: tabData.ip || prev.ip || (linkedAcc ? linkedAcc.outboundIp : '') || '127.0.0.1',
      proxy: tabData.proxy !== undefined ? tabData.proxy : (prev.proxy || (linkedAcc ? linkedAcc.proxy : '')),
      ipStatus: tabData.ipStatus || prev.ipStatus || (linkedAcc ? linkedAcc.ipStatus : 'direct'),
      blacklistHits: Number(tabData.blacklistHits ?? prev.blacklistHits ?? 0),
      replies: Array.isArray(tabData.replies) ? tabData.replies : (prev.replies || []),
      lastSeen: new Date().toISOString()
    };

    this.state.onlineTabs[key] = record;
    this.save();
    return record;
  }

  listOnlineTabs() {
    const rows = Object.values(this.state.onlineTabs);
    // Annotate duplicate emails (`isDup`) cleanly
    const emailCounts = new Map();
    for (const r of rows) {
      const em = String(r.email || '').toLowerCase().trim();
      if (!em) continue;
      emailCounts.set(em, (emailCounts.get(em) || 0) + 1);
    }
    return rows.map((r, idx) => {
      const em = String(r.email || '').toLowerCase().trim();
      const linked = this.getAccount(r.accountId) || this.getAccount(r.email);
      return {
        ...r,
        index: idx + 1,
        isDup: em ? (emailCounts.get(em) || 0) > 1 : false,
        proxyInfo: (r.proxy || linked?.proxy) ? safeDescribeProxy(r.proxy || linked.proxy) : null
      };
    });
  }

  removeOnlineTab(keyOrTabId) {
    const keyStr = String(keyOrTabId);
    let removed = false;
    for (const [k, v] of Object.entries(this.state.onlineTabs)) {
      if (k === keyStr || String(v.tabId) === keyStr || v.accountId === keyStr) {
        delete this.state.onlineTabs[k];
        removed = true;
      }
    }
    if (removed) this.save();
    return removed;
  }

  // ── Recipient Data & Test Data Pools ──────────────────────────────────────
  addData(rawEmails) {
    const incoming = String(rawEmails || '')
      .split(/[\r\n,;]+/)
      .map((s) => s.trim())
      .filter((s) => s && s.includes('@'));

    const existing = new Set(this.state.dataList.map((e) => e.toLowerCase()));
    let added = 0;
    for (const em of incoming) {
      if (!existing.has(em.toLowerCase())) {
        existing.add(em.toLowerCase());
        this.state.dataList.push(em);
        added++;
      }
    }
    this.save();
    return { added, total: this.state.dataList.length };
  }

  clearData() {
    this.state.dataList = [];
    this.state.dataCursor = 0;
    this.save();
  }

  allocateDataForTabs(recordsPerTab) {
    const perTab = Math.max(1, Number(recordsPerTab || this.state.recordsPerTab || 5));
    this.state.recordsPerTab = perTab;
    const tabs = this.listOnlineTabs().filter((t) => !t.isBlocked && t.isActive);
    const total = this.state.dataList.length;
    const allocations = [];
    let cursor = this.state.dataCursor;

    for (const tab of tabs) {
      if (cursor >= total) break;
      const slice = this.state.dataList.slice(cursor, cursor + perTab);
      cursor += slice.length;
      if (slice.length > 0) {
        this.state.onlineTabs[tab.key].dataAllocated = slice.join(', ');
        allocations.push({ tab, recipients: slice });
      }
    }
    this.state.dataCursor = cursor;
    this.save();
    return { allocations, remaining: Math.max(0, total - cursor), cursor };
  }

  addTestRecipients(raw) {
    const incoming = String(raw || '')
      .split(/[\r\n,;]+/)
      .map((s) => s.trim())
      .filter((s) => s && s.includes('@'));
    const existing = new Set(this.state.testRecipients.map((e) => e.toLowerCase()));
    for (const em of incoming) {
      if (!existing.has(em.toLowerCase())) {
        existing.add(em.toLowerCase());
        this.state.testRecipients.push(em);
      }
    }
    this.save();
    return this.state.testRecipients;
  }

  removeTestRecipient(email) {
    this.state.testRecipients = this.state.testRecipients.filter(
      (e) => e.toLowerCase() !== String(email || '').toLowerCase()
    );
    this.save();
    return this.state.testRecipients;
  }

  // ── Custom Tags CRUD ──────────────────────────────────────────────────────
  getTags() {
    return this.state.customTags;
  }

  upsertTag(name, values, type = 'sequential') {
    let key = String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!key) throw new Error('Tag name is required');
    key = `{${key}}`;
    const cleanValues = Array.isArray(values)
      ? values.map((v) => String(v).trim()).filter(Boolean)
      : String(values || '').split(/[\r\n,]+/).map((v) => v.trim()).filter(Boolean);
    if (cleanValues.length === 0) throw new Error('At least one tag value is required');

    this.state.customTags[key] = {
      type: ['random', 'static'].includes(type) ? type : 'sequential',
      values: cleanValues
    };
    this.save();
    return { key, tag: this.state.customTags[key] };
  }

  deleteTag(name) {
    let key = String(name || '').trim();
    if (!key.startsWith('{')) key = `{${key}}`;
    if (!(key in this.state.customTags)) return false;
    delete this.state.customTags[key];
    this.save();
    return true;
  }

  // ── SMS Pool Sync ─────────────────────────────────────────────────────────
  syncVerificationString(raw) {
    const result = this.verificationPool.syncFromString(raw);
    this.save();
    return result;
  }
}

function safeDescribeProxy(proxyStr) {
  try {
    return describeProxy(proxyStr);
  } catch {
    return { protocol: 'http', host: proxyStr, port: 0, hasAuth: false, display: proxyStr };
  }
}

function parseDeviceLabel(ua) {
  if (/Macintosh/i.test(ua)) return 'macOS Chrome';
  if (/Windows/i.test(ua)) return 'Windows Chrome';
  if (/Linux/i.test(ua)) return 'Linux Chrome';
  if (/HeadlessChrome/i.test(ua)) return 'Headless Chromium';
  return 'Web Browser';
}

module.exports = {
  RelayStore,
  hashPassword,
  verifyPassword
};
