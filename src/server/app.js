'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { RelayStore } = require('./store');
const { WsHub } = require('./wsHub');
const { BrowserManager } = require('./browserManager');
const { parseBulkCredentials } = require('../core/credentials');
const { processTags, PREDEFINED_TAG_CATALOG } = require('../core/tagEngine');
const { convertHtml } = require('../core/pdfConverter');
const { probeProxyIp } = require('../proxy/proxyBridge');
const proxyParser = require('../proxy/proxyParser');
const { buildExtensionZip } = require('./extensionPacker');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip'
};

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readRequestBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartFormData(buf, contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) return {};
  const boundary = match[1] || match[2];
  const delim = Buffer.from(`--${boundary}`);
  const out = {};
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // closing `--`
    const headerStart = buf[start] === 0x0d && buf[start + 1] === 0x0a ? start + 2 : start;
    const nextPos = buf.indexOf(delim, headerStart);
    if (nextPos === -1) break;
    const partBuf = buf.subarray(headerStart, nextPos);
    const sepIdx = partBuf.indexOf('\r\n\r\n');
    if (sepIdx !== -1) {
      const headerText = partBuf.subarray(0, sepIdx).toString('utf8');
      let bodyBuf = partBuf.subarray(sepIdx + 4);
      if (bodyBuf.length >= 2 && bodyBuf[bodyBuf.length - 2] === 0x0d && bodyBuf[bodyBuf.length - 1] === 0x0a) {
        bodyBuf = bodyBuf.subarray(0, bodyBuf.length - 2);
      }
      const nameMatch = headerText.match(/name="([^"]+)"/i);
      const fileMatch = headerText.match(/filename="([^"]*)"/i);
      if (nameMatch) {
        const fieldName = nameMatch[1];
        if (fileMatch && fileMatch[1]) {
          out[fieldName] = {
            filename: fileMatch[1],
            buffer: bodyBuf,
            base64: bodyBuf.toString('base64')
          };
        } else {
          out[fieldName] = bodyBuf.toString('utf8');
        }
      }
    }
    pos = nextPos;
  }
  return out;
}

async function parseBodyParams(req) {
  const buf = await readRequestBody(req);
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    return parseMultipartFormData(buf, req.headers['content-type']);
  }
  const str = buf.toString('utf8');
  if (ct.includes('application/json')) {
    return str ? JSON.parse(str) : {};
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const sp = new URLSearchParams(str);
    return Object.fromEntries(sp.entries());
  }
  // Fallback: try JSON then form-urlencoded
  if (str.trim().startsWith('{') || str.trim().startsWith('[')) {
    try {
      return JSON.parse(str);
    } catch {
      // fall through
    }
  }
  if (str.includes('=')) {
    return Object.fromEntries(new URLSearchParams(str).entries());
  }
  return { raw: str };
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(payload);
}

function sendRedirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

function serveFile(res, filePath, req) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  if (req && req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Create the complete self-hosted NewShooter HTTP + WebSocket Controller Server.
 */
function createServer(options = {}) {
  const publicDir = options.publicDir || path.resolve(__dirname, '../../public');
  const extensionDir = options.extensionDir || path.resolve(__dirname, '../../extension');
  const store = options.store || new RelayStore(options);
  const browserManager = options.browserManager || new BrowserManager(store, options);
  const wsHub = new WsHub(store, { browserManager });
  const shootTimers = new Set();
  const pendingShoots = new Set();
  const loginCsrfSet = new Set();

  function issueLoginCsrf() {
    const token = crypto.randomBytes(24).toString('hex');
    loginCsrfSet.add(token);
    if (loginCsrfSet.size > 500) {
      const first = loginCsrfSet.values().next().value;
      loginCsrfSet.delete(first);
    }
    return token;
  }

  function getAuthSession(req) {
    const cookies = parseCookies(req);
    return store.getSession(cookies.relay_sid || cookies.PHPSESSID);
  }

  function requireAuthApi(req, res) {
    const sess = getAuthSession(req);
    if (!sess) {
      sendJson(res, 401, { status: 'unauthorized', error: 'Authentication required' });
      return null;
    }
    return sess;
  }

  function buildDashboardSnapshot(sess) {
    const onlineTabs = store.listOnlineTabs();
    const accounts = store.listAccounts();
    const smsStats = store.verificationPool.getStats();
    return {
      user: { username: sess.username, csrfToken: sess.csrfToken },
      updatesVersion: store.state.updatesVersion,
      onlineTabs,
      accounts,
      predefinedTags: PREDEFINED_TAG_CATALOG,
      customTags: store.getTags(),
      dataCount: store.state.dataList.length,
      dataCursor: store.state.dataCursor,
      dataPreview: store.state.dataList.slice(0, 500),
      recordsPerTab: store.state.recordsPerTab,
      testRecipients: store.state.testRecipients,
      compose: store.state.compose,
      attachmentConfig: store.state.attachmentConfig,
      uploadedFiles: store.state.uploadedFiles,
      shootSettings: store.state.shootSettings,
      shootQuota: store.state.shootQuota,
      shootState: store.state.shootState,
      automationSettings: store.state.automationSettings,
      verification: {
        stats: smsStats,
        items: store.verificationPool.toJSON()
      },
      messages: store.state.messages,
      gmass: store.state.gmass
    };
  }

  async function dispatchShoot({ isTest = false, testEmail = '', overrideSubject, overrideBody, res }) {
    const quota = store.state.shootQuota;
    if (!isTest && !store.state.shootSettings.forceStart && quota.sentToday >= quota.dailyLimit) {
      return { ok: false, error: 'Daily send limit reached' };
    }

    const tabs = store.listOnlineTabs().filter((t) => {
      if (!t.isActive) return false;
      if (!store.state.shootSettings.forceStart && t.isBlocked) return false;
      return true;
    });

    if (tabs.length === 0) {
      return { ok: false, error: 'No online active tabs available to shoot' };
    }

    const subjectTpl = overrideSubject ?? store.state.compose.subject;
    const bodyTpl = overrideBody ?? store.state.compose.body;
    if (!String(subjectTpl || '').trim() && !String(bodyTpl || '').trim()) {
      return { ok: false, error: 'Compose subject or body is empty' };
    }

    // Prepare attachment conversion if requested
    const attCfg = store.state.attachmentConfig || {};
    const generatedAttachments = [];
    if (attCfg.format && attCfg.format !== 'html' && (attCfg.htmlSource || bodyTpl)) {
      const converted = await convertHtml({
        html: attCfg.htmlSource || bodyTpl,
        format: attCfg.format,
        filename: attCfg.filename || 'attachment',
        watermark: attCfg.watermark || ''
      });
      generatedAttachments.push({
        filename: converted.filename,
        mimeType: converted.mimeType,
        base64: converted.buffer.toString('base64'),
        size: converted.size
      });
    }
    for (const f of store.state.uploadedFiles || []) {
      if (attCfg.selectedFiles?.includes(f.id) && fs.existsSync(f.path)) {
        generatedAttachments.push({
          filename: f.originalName,
          mimeType: f.mimeType,
          base64: fs.readFileSync(f.path).toString('base64'),
          size: f.size
        });
      }
    }

    const shootId = `shoot_${crypto.randomBytes(6).toString('hex')}`;
    const tasks = [];

    if (isTest) {
      const recipients = testEmail
        ? [testEmail]
        : (store.state.testRecipients.length > 0 ? store.state.testRecipients : [tabs[0].email]);
      const targetTab = tabs[0];
      for (const recipient of recipients) {
        const cache = {};
        const resolved = processTags(
          recipient,
          { subject: subjectTpl, body: bodyTpl },
          {
            customTags: store.getTags(),
            tagCounters: store.state.tagCounters,
            senderName: store.state.compose.senderName,
            cache
          }
        );
        tasks.push({
          taskId: `task_${crypto.randomBytes(5).toString('hex')}`,
          shootId,
          isTest: true,
          tab: targetTab,
          recipientEmail: recipient,
          subject: resolved.subject,
          body: resolved.body,
          attachments: generatedAttachments
        });
      }
    } else {
      // Allocate from dataList if tabs have no assigned dataAllocated yet
      let anyMissing = tabs.some((t) => !t.dataAllocated);
      if (anyMissing && store.state.dataList.length > 0) {
        store.allocateDataForTabs(store.state.recordsPerTab);
      }

      const freshTabs = store.listOnlineTabs().filter((t) => t.isActive && (!t.isBlocked || store.state.shootSettings.forceStart));
      for (const t of freshTabs) {
        const recipients = String(t.dataAllocated || '')
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter((s) => s && s.includes('@'));

        for (const recipient of recipients) {
          const cache = {};
          const resolved = processTags(
            recipient,
            { subject: subjectTpl, body: bodyTpl },
            {
              customTags: store.getTags(),
              tagCounters: store.state.tagCounters,
              senderName: store.state.compose.senderName,
              cache
            }
          );
          tasks.push({
            taskId: `task_${crypto.randomBytes(5).toString('hex')}`,
            shootId,
            isTest: false,
            tab: t,
            recipientEmail: recipient,
            subject: resolved.subject,
            body: resolved.body,
            attachments: generatedAttachments
          });
        }
      }
    }

    if (tasks.length === 0) {
      return { ok: false, error: 'No recipient emails allocated to online tabs. Load DATA first.' };
    }

    store.state.shootState = {
      active: true,
      shootId,
      totalTasks: tasks.length,
      completedTasks: 0,
      failedTasks: 0,
      startedAt: new Date().toISOString()
    };
    store.save();
    wsHub.broadcastDashboards({ type: 'SHOOT_STARTED', shootState: store.state.shootState });

    // Stagger execution per provider delay timing without blocking HTTP response
    const perAccountOffset = new Map();
    for (const task of tasks) {
      const provider = task.tab.provider || 'gmail';
      const delaySec = Number(store.state.shootSettings[provider] || 3);
      const countSoFar = perAccountOffset.get(task.tab.accountId) || 0;
      const delayMs = isTest ? countSoFar * 300 : countSoFar * delaySec * 1000;
      perAccountOffset.set(task.tab.accountId, countSoFar + 1);

      const timer = setTimeout(() => {
        shootTimers.delete(timer);
        if (!store.state.shootState.active || store.state.shootState.shootId !== shootId) return;

        const payload = {
          type: 'EXECUTE_DISPATCH',
          taskId: task.taskId,
          campaignId: shootId,
          accountId: task.tab.accountId,
          tabId: task.tab.tabId,
          provider: task.tab.provider || 'gmail',
          recipientEmail: task.recipientEmail,
          subject: task.subject,
          body: task.body,
          isHtml: true,
          attachments: task.attachments
        };

        const delivered = wsHub.sendToAccount(task.tab.accountId, payload);
        if (delivered) {
          store.upsertOnlineTab({
            ...task.tab,
            tabKey: task.tab.key,
            status: `Sending ${Math.min(countSoFar + 1, perAccountOffset.get(task.tab.accountId))}/${perAccountOffset.get(task.tab.accountId)}`
          });
        } else {
          // Offline tab in local UI demo mode: mark simulated send complete cleanly if no WS client bound
          store.upsertOnlineTab({
            ...task.tab,
            tabKey: task.tab.key,
            status: 'Queued (No Ext)',
            sent: task.tab.sent,
            isBlocked: task.tab.isBlocked
          });
        }
        wsHub.broadcastDashboards({
          type: 'DISPATCH_EVENT',
          delivered,
          taskId: task.taskId,
          recipientEmail: task.recipientEmail,
          onlineTabs: store.listOnlineTabs()
        });
      }, delayMs);
      timer.unref();
      shootTimers.add(timer);
    }

    return { ok: true, shootId, queuedTasks: tasks.length, tasksPreview: tasks.map((t) => ({ taskId: t.taskId, to: t.recipientEmail, subject: t.subject })) };
  }

  function abortActiveShoot() {
    for (const timer of shootTimers) {
      clearTimeout(timer);
    }
    shootTimers.clear();
    const prevId = store.state.shootState.shootId;
    store.state.shootState.active = false;
    store.save();
    wsHub.broadcastAgents({ type: 'ABORT_DISPATCH', campaignId: prevId });
    wsHub.broadcastDashboards({ type: 'SHOOT_ABORTED', shootState: store.state.shootState });
    return { ok: true, abortedShootId: prevId };
  }

  async function attemptShootForTab(tab) {
    if (!tab) return { ok: false, error: 'Tab not found' };

    let recipients = String(tab.dataAllocated || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s && s.includes('@'));

    if (recipients.length === 0 && store.state.dataList.length > 0) {
      store.allocateDataForTabs(store.state.recordsPerTab || 5);
      const refreshed = store.state.onlineTabs[tab.key] || tab;
      recipients = String(refreshed.dataAllocated || '')
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => s && s.includes('@'));
    }

    if (recipients.length === 0 && store.state.testRecipients && store.state.testRecipients.length > 0) {
      recipients = [store.state.testRecipients[store.state.testCursor % store.state.testRecipients.length]];
      store.state.testCursor++;
    }

    if (recipients.length === 0) {
      return { ok: false, error: 'No recipient data allocated to tab' };
    }

    const subjectTpl = store.state.compose?.subject || '';
    const bodyTpl = store.state.compose?.body || '';
    if (!String(subjectTpl || '').trim() && !String(bodyTpl || '').trim()) {
      return { ok: false, error: 'Compose subject and body are empty' };
    }

    // Attachments
    const attCfg = store.state.attachmentConfig || {};
    const generatedAttachments = [];
    if (attCfg.format && attCfg.format !== 'html' && (attCfg.htmlSource || bodyTpl)) {
      try {
        const converted = await convertHtml({
          html: attCfg.htmlSource || bodyTpl,
          format: attCfg.format,
          filename: attCfg.filename || 'attachment',
          watermark: attCfg.watermark || ''
        });
        generatedAttachments.push({
          filename: converted.filename,
          mimeType: converted.mimeType,
          base64: converted.buffer.toString('base64'),
          size: converted.size
        });
      } catch (err) {
        console.error('Attachment conversion error in tab shoot:', err);
      }
    }
    for (const f of store.state.uploadedFiles || []) {
      if (attCfg.selectedFiles?.includes(f.id) && fs.existsSync(f.path)) {
        generatedAttachments.push({
          filename: f.originalName,
          mimeType: f.mimeType,
          base64: fs.readFileSync(f.path).toString('base64'),
          size: f.size
        });
      }
    }

    let shootId = store.state.shootState?.active
      ? store.state.shootState.shootId
      : `shoot_${crypto.randomBytes(6).toString('hex')}`;

    if (!store.state.shootState?.active) {
      store.state.shootState = {
        active: true,
        shootId,
        totalTasks: recipients.length,
        completedTasks: 0,
        failedTasks: 0,
        startedAt: new Date().toISOString()
      };
    } else {
      store.state.shootState.totalTasks = (store.state.shootState.totalTasks || 0) + recipients.length;
    }
    store.save();
    wsHub.broadcastDashboards({ type: 'SHOOT_STARTED', shootState: store.state.shootState });

    const provider = tab.provider || 'gmail';
    const delaySec = Number(store.state.shootSettings[provider] || 3);

    recipients.forEach((recipient, idx) => {
      const delayMs = idx * delaySec * 1000;
      const taskId = `task_${crypto.randomBytes(5).toString('hex')}`;
      const cache = {};
      const resolved = processTags(
        recipient,
        { subject: subjectTpl, body: bodyTpl },
        {
          customTags: store.getTags(),
          tagCounters: store.state.tagCounters,
          senderName: store.state.compose?.senderName,
          cache
        }
      );

      const timer = setTimeout(() => {
        shootTimers.delete(timer);
        if (!store.state.shootState?.active || store.state.shootState.shootId !== shootId) return;

        const payload = {
          type: 'EXECUTE_DISPATCH',
          taskId,
          campaignId: shootId,
          accountId: tab.accountId,
          tabId: tab.tabId,
          provider: tab.provider || 'gmail',
          recipientEmail: recipient,
          subject: resolved.subject,
          body: resolved.body,
          isHtml: true,
          attachments: generatedAttachments
        };

        const delivered = wsHub.sendToAccount(tab.accountId, payload);
        if (delivered) {
          store.upsertOnlineTab({
            ...tab,
            tabKey: tab.key,
            status: `Sending ${idx + 1}/${recipients.length}`
          });
        } else {
          store.upsertOnlineTab({
            ...tab,
            tabKey: tab.key,
            status: 'Queued (No Ext)'
          });
        }
        wsHub.broadcastDashboards({
          type: 'DISPATCH_EVENT',
          delivered,
          taskId,
          recipientEmail: recipient,
          onlineTabs: store.listOnlineTabs()
        });
      }, delayMs);
      timer.unref();
      shootTimers.add(timer);
    });

    return { ok: true, queuedTasks: recipients.length };
  }

  wsHub.onInboxReady = (accountId, tab) => {
    if (pendingShoots.has(accountId) || store.state.shootState?.active) {
      pendingShoots.delete(accountId);
      const targetTab = tab || Object.values(store.state.onlineTabs).find((t) => t.accountId === accountId);
      if (targetTab) {
        attemptShootForTab(targetTab).catch((err) => {
          console.error(`Error attempting shoot on inbox ready for ${accountId}:`, err);
        });
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = reqUrl.pathname;

      // ── Root Redirect ───────────────────────────────────────────────────────
      if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        const sess = getAuthSession(req);
        return sendRedirect(res, sess ? '/V3/' : '/Login.php');
      }

      // ── Login & Logout ──────────────────────────────────────────────────────
      if (pathname === '/Login.php') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const sess = getAuthSession(req);
          if (sess) return sendRedirect(res, '/V3/');
          return serveFile(res, path.join(publicDir, 'login.html'), req);
        }
        if (req.method === 'POST') {
          const body = await parseBodyParams(req);
          const usr = body.usr || body.username || '';
          const pas = body.pas || body.password || '';
          const forceEvict = body.force_evict === '1'
            || body.force_evict === true
            || body.forceEvict === true
            || body.evict_oldest === '1'
            || body.evict_oldest === true;

          const result = store.authenticate(usr, pas, {
            forceEvict,
            ip: req.socket.remoteAddress || '127.0.0.1',
            userAgent: req.headers['user-agent'] || '',
            vtId: body.vt_id || '',
            vtFp: body.vt_fp || ''
          });

          if (!result.ok && result.limitExceeded) {
            return sendJson(res, 200, {
              status: 'limit',
              action_required: 'limit_reached',
              limit: result.limit,
              activeDevices: result.activeDevices
            });
          }
          if (!result.ok) {
            return sendJson(res, 401, { status: 'error', error: result.error });
          }

          const encodedSid = encodeURIComponent(result.session.token);
          return sendJson(
            res,
            200,
            {
              status: 'ok',
              redirect: '/V3/',
              redirect_url: '/V3/',
              username: result.session.username,
              evicted: result.evicted
            },
            {
              'Set-Cookie': [
                `relay_sid=${encodedSid}; Path=/; HttpOnly; SameSite=Lax`,
                `PHPSESSID=${encodedSid}; Path=/; HttpOnly; SameSite=Lax`
              ]
            }
          );
        }
      }

      if (pathname === '/api/auth/csrf' && req.method === 'GET') {
        return sendJson(res, 200, { csrfToken: issueLoginCsrf() });
      }

      if (pathname === '/logout' || pathname === '/Logout.php') {
        const cookies = parseCookies(req);
        const sid = cookies.relay_sid || cookies.PHPSESSID;
        if (sid) store.destroySession(sid);
        res.writeHead(302, {
          Location: '/Login.php',
          'Set-Cookie': [
            'relay_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
            'PHPSESSID=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
          ]
        });
        return res.end();
      }

      // ── Telemetry (/V3/vt/vt.js & /V3/vt/c) ────────────────────────────────
      if (pathname === '/V3/vt/vt.js' && req.method === 'GET') {
        const vtScript = `(function(){
  try {
    var vid = localStorage.getItem('__vt_vid') || ('vt_' + Math.random().toString(36).slice(2, 12));
    localStorage.setItem('__vt_vid', vid);
    var fp = btoa([navigator.userAgent, navigator.language, screen.width + 'x' + screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone || ''].join('|')).slice(0, 32);
    window.__vt = { vid: vid, fp: fp };
    if (navigator.sendBeacon) {
      var blob = new Blob([JSON.stringify({ vid: vid, fp: fp, p: location.pathname })], { type: 'application/json' });
      navigator.sendBeacon('/V3/vt/c', blob);
    }
  } catch (e) {}
})();\n`;
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': Buffer.byteLength(vtScript, 'utf8'),
          'Cache-Control': 'no-cache'
        });
        return res.end(vtScript);
      }

      if (pathname === '/V3/vt/c' && req.method === 'POST') {
        const body = await parseBodyParams(req);
        store.recordVtEvent({ vid: body.vid, fp: body.fp, p: body.p });
        return sendJson(res, 200, { ok: true, id: body.vid || 'local' });
      }

      // ── Extension Bootstrap Handoff (prevents leaking rpa_* params) ─────────
      if (pathname === '/rpa-bootstrap' && req.method === 'GET') {
        const nextRaw = reqUrl.searchParams.get('next') || 'https://accounts.google.com/ServiceLogin?service=mail';
        let safeNext = 'https://accounts.google.com/ServiceLogin?service=mail';
        try {
          const parsedNext = new URL(nextRaw);
          if (parsedNext.protocol === 'http:' || parsedNext.protocol === 'https:') {
            safeNext = parsedNext.toString();
          }
        } catch {
          // fallback to default
        }
        const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Relay Bootstrap</title></head>
<body style="font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center">
    <div style="font-weight:700;font-size:15px">Initializing isolated browser session...</div>
    <div id="rpa-status" style="font-size:12px;color:#94a3b8;margin-top:6px">Connecting extension agent</div>
  </div>
  <script>
    (function () {
      var target = ${JSON.stringify(safeNext)};
      var redirected = false;
      function go() {
        if (redirected) return;
        redirected = true;
        window.location.replace(target);
      }
      if (document.documentElement.dataset.rpaBootstrapped === '1') {
        go();
      }
      window.addEventListener('rpa-bootstrapped', go, { once: true });
      setTimeout(go, 900);
    })();
  </script>
</body>
</html>`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html, 'utf8'),
          'Cache-Control': 'no-store'
        });
        return res.end(html);
      }

      // ── Authenticated Page Routes ───────────────────────────────────────────
      if (pathname === '/V3' || pathname === '/V3/') {
        if (!getAuthSession(req)) return sendRedirect(res, '/Login.php');
        return serveFile(res, path.join(publicDir, 'index.html'), req);
      }
      if (pathname === '/V3/tags' || pathname === '/V3/tags/') {
        if (!getAuthSession(req)) return sendRedirect(res, '/Login.php');
        return serveFile(res, path.join(publicDir, 'tags.html'), req);
      }
      if (pathname === '/V3/files' || pathname === '/V3/files/') {
        if (!getAuthSession(req)) return sendRedirect(res, '/Login.php');
        return serveFile(res, path.join(publicDir, 'files.html'), req);
      }
      if (pathname === '/gmass2' || pathname === '/gmass4') {
        if (!getAuthSession(req)) return sendRedirect(res, '/Login.php');
        return serveFile(res, path.join(publicDir, 'gmass.html'), req);
      }

      // ── Static Assets ───────────────────────────────────────────────────────
      if (
        pathname.startsWith('/assets/') ||
        pathname.startsWith('/css/') ||
        pathname.startsWith('/js/') ||
        pathname.startsWith('/downloads/')
      ) {
        const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
        const abs = path.resolve(publicDir, '.' + rel);
        if (!abs.startsWith(path.resolve(publicDir))) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        return serveFile(res, abs, req);
      }

      // ── Extension Download Endpoint ──────────────────────────────────────────
      if (
        pathname === '/api/download-extension' ||
        pathname === '/download-extension' ||
        pathname === '/download/extension.zip'
      ) {
        try {
          const zipBuf = buildExtensionZip(extensionDir);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="bin4ry-relay-extension.zip"',
            'Content-Length': zipBuf.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          });
          if (req.method === 'HEAD') return res.end();
          return res.end(zipBuf);
        } catch (err) {
          console.error('Error serving extension zip:', err);
          return sendJson(res, 500, { ok: false, error: 'Failed to build extension zip' });
        }
      }

      // ── Controller Compatibility APIs ───────────────────────────────────────
      if (pathname === '/V3/controller/heartbeat.php') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        return sendJson(res, 200, { ok: true, valid: true, username: sess.username, ts: Date.now() });
      }

      if (pathname === '/V3/controller/updatesApi.php') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        return sendJson(res, 200, {
          ok: true,
          version: store.state.updatesVersion,
          notes: 'Self-hosted NewShooter Relay Engine v4.1 with Per-Account Proxy Bridge'
        });
      }

      if (pathname === '/V3/controller/messagesApi.php') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        if (req.method === 'POST') {
          const body = await parseBodyParams(req);
          if (body.action === 'markRead') {
            for (const m of store.state.messages) m.read = true;
            store.save();
          } else if (body.text) {
            store.state.messages.push({
              id: Date.now(),
              sender: sess.username,
              text: String(body.text).trim(),
              createdAt: new Date().toISOString(),
              read: false
            });
            store.save();
            wsHub.broadcastDashboards({ type: 'CHAT_UPDATED', messages: store.state.messages });
          }
        }
        const unreadCount = store.state.messages.filter((m) => !m.read).length;
        return sendJson(res, 200, {
          ok: true,
          unreadCount,
          messages: store.state.messages
        });
      }

      if (pathname === '/V3/controller/ai/aiPromptsApi.php' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = await parseBodyParams(req);
        const prompt = String(body.prompt || '').trim();
        const mode = String(body.mode || 'template');

        // Optional external OpenAI-compatible API if user configured env var
        if (process.env.OPENAI_API_KEY) {
          try {
            const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
            const resp = await fetch(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
              },
              body: JSON.stringify({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: 'Generate clean transactional HTML email copy with spintax {opt1|opt2} and template tags like {name}, {orderno}, {grandtotal}, {company}. Return JSON {subject, html}.' },
                  { role: 'user', content: prompt || 'Order receipt confirmation' }
                ]
              })
            });
            if (resp.ok) {
              const data = await resp.json();
              const text = data.choices?.[0]?.message?.content || '';
              return sendJson(res, 200, { ok: true, mode, text, source: 'llm' });
            }
          } catch {
            // gracefully fall back to offline preset generator
          }
        }

        // Offline intelligent spintax/tag template generator
        const subject = `{Hi|Hello} {firstname}, {confirmation|summary|update} for {orderid} #{orderno}`;
        const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b;">
  <h2 style="color:#4361ee;margin-bottom:8px;">{company} · Notification</h2>
  <p>{greet} {name},</p>
  <p>${prompt ? prompt.replace(/</g, '&lt;') : 'Here is the latest update regarding your order summary.'}</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f8fafc;border:1px solid #e2e8f0;">
    <tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;"><strong>Reference</strong></td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">#{refno}</td></tr>
    <tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;"><strong>Product</strong></td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">{productname} (x{qty})</td></tr>
    <tr><td style="padding:8px 12px;"><strong>{total}</strong></td><td style="padding:8px 12px;"><strong>{grandtotal} {currency}</strong></td></tr>
  </table>
  <p>{closing},<br><strong>{senderName}</strong> · {department}</p>
</div>`;
        return sendJson(res, 200, { ok: true, mode, subject, html, source: 'local-preset' });
      }

      // ── Tags API (/V3/tags/tags.php) ────────────────────────────────────────
      if (pathname === '/V3/tags/tags.php') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, tags: store.getTags(), predefined: PREDEFINED_TAG_CATALOG });
        }
        const body = await parseBodyParams(req);
        if (req.method === 'DELETE' || body.action === 'delete') {
          const ok = store.deleteTag(body.name || body.tag);
          return sendJson(res, 200, { ok, tags: store.getTags() });
        }
        const created = store.upsertTag(body.name || body.tag, body.values, body.type);
        wsHub.broadcastDashboards({ type: 'TAGS_UPDATED', customTags: store.getTags() });
        return sendJson(res, 200, { ok: true, created, tags: store.getTags() });
      }

      // ── Native Relay Extension Handshake (/V3/relay.php) ──────────────────
      if (pathname === '/V3/relay.php') {
        const port = server?.address?.()?.port || browserManager?.serverPort || 8080;
        const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`;
        const isSecure = req.headers['x-forwarded-proto'] === 'https' || !host.startsWith('127.0.0.1') && !host.startsWith('localhost');
        const wsGateway = isSecure ? `wss://${host}` : `ws://127.0.0.1:${port}`;
        const tags = store.getTags() || [];
        return sendJson(res, 200, {
          success: true,
          status: 'active',
          message: 'Connected to Local Controller',
          wsGateway,
          tags,
          version: '4.0.3'
        });
      }

      // ── Native Relay Extension HTTP Signal Fallback (/V3/signal_V6.php) ────
      if (pathname === '/V3/signal_V6.php') {
        const body = req.method === 'POST' ? await parseBodyParams(req) : {};
        if (body.tabId) {
          const tab = Object.values(store.state.onlineTabs).find((t) => t.tabId === body.tabId);
          if (tab) {
            if (body.inbox !== undefined) tab.inbox = Number(body.inbox);
            if (body.draft !== undefined) tab.draft = Number(body.draft);
            if (body.sent !== undefined) tab.sent = Number(body.sent);
            if (body.spam !== undefined) tab.spam = Number(body.spam);
            store.upsertOnlineTab(tab);
            wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
          }
        }
        return sendJson(res, 200, {
          success: true,
          status: 'OK',
          data: null
        });
      }

      // ── Native Extension telemetry / index endpoint (/extension/index.php) ─
      if (pathname === '/extension/index.php') {
        return sendJson(res, 200, {
          success: true,
          status: 'active',
          license: 'valid',
          expires: '2099-12-31'
        });
      }

      // ── Relay Command API (/V3/relayCommandApi.php) ─────────────────────────
      if (pathname === '/V3/relayCommandApi.php') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = req.method === 'POST' ? await parseBodyParams(req) : Object.fromEntries(reqUrl.searchParams.entries());
        const KNOWN_FORM_ACTIONS = [
          'getDashboard', 'getShootDetail', 'saveShootSettings',
          'getData', 'addData', 'deleteData', 'allocateData',
          'getTestData', 'addTestData', 'deleteTestData',
          'getOnlinetabs', 'getAttachmentConfig', 'saveAttachmentConfig',
          'saveCompose', 'getFolders', 'reloadTab', 'reloadAll',
          'closeTab', 'closeAll', 'pinTab', 'shoot', 'testShoot', 'abortShoot'
        ];
        const action = body.action
          || reqUrl.searchParams.get('action')
          || KNOWN_FORM_ACTIONS.find((k) => body[k] !== undefined && body[k] !== '')
          || 'getDashboard';

        switch (action) {
          case 'getDashboard':
            return sendJson(res, 200, { ok: true, ...buildDashboardSnapshot(sess) });

          case 'getShootDetail':
            return sendJson(res, 200, {
              ok: true,
              quota: store.state.shootQuota,
              settings: store.state.shootSettings,
              shootState: store.state.shootState
            });

          case 'saveShootSettings': {
            const s = store.state.shootSettings;
            if (body.gmail != null) s.gmail = Math.max(1, Number(body.gmail));
            if (body.yahoo != null) s.yahoo = Math.max(1, Number(body.yahoo));
            if (body.outlook != null) s.outlook = Math.max(1, Number(body.outlook));
            if (['two-col', 'one-col', 'reversed'].includes(body.layout)) s.layout = body.layout;
            if (body.forceStart !== undefined) s.forceStart = Boolean(body.forceStart);
            store.save();
            return sendJson(res, 200, { ok: true, settings: s });
          }

          case 'getData':
            return sendJson(res, 200, {
              ok: true,
              total: store.state.dataList.length,
              cursor: store.state.dataCursor,
              recordsPerTab: store.state.recordsPerTab,
              data: store.state.dataList
            });

          case 'addData': {
            const resAdd = store.addData(body.data || body.emails || '');
            wsHub.broadcastDashboards({ type: 'DATA_UPDATED', total: resAdd.total });
            return sendJson(res, 200, { ok: true, ...resAdd, data: store.state.dataList });
          }

          case 'deleteData':
            store.clearData();
            wsHub.broadcastDashboards({ type: 'DATA_UPDATED', total: 0 });
            return sendJson(res, 200, { ok: true, total: 0 });

          case 'allocateData': {
            const alloc = store.allocateDataForTabs(body.recordsPerTab);
            wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
            return sendJson(res, 200, { ok: true, ...alloc, onlineTabs: store.listOnlineTabs() });
          }

          case 'getTestData':
            return sendJson(res, 200, { ok: true, testData: store.state.testRecipients });

          case 'addTestData': {
            const list = store.addTestRecipients(body.emails || body.email || '');
            return sendJson(res, 200, { ok: true, testData: list });
          }

          case 'deleteTestData': {
            const list = body.email ? store.removeTestRecipient(body.email) : (store.state.testRecipients = [], store.save(), []);
            return sendJson(res, 200, { ok: true, testData: list });
          }

          case 'getOnlinetabs':
            return sendJson(res, 200, { ok: true, onlineTabs: store.listOnlineTabs() });

          case 'getAttachmentConfig':
            return sendJson(res, 200, { ok: true, config: store.state.attachmentConfig });

          case 'saveAttachmentConfig': {
            const cfg = store.state.attachmentConfig;
            if (body.format !== undefined) cfg.format = String(body.format || 'html');
            if (body.filename !== undefined) cfg.filename = String(body.filename || '');
            if (body.watermark !== undefined) cfg.watermark = String(body.watermark || '');
            if (body.htmlSource !== undefined) cfg.htmlSource = String(body.htmlSource || '');
            if (Array.isArray(body.selectedFiles)) cfg.selectedFiles = body.selectedFiles;
            cfg.updatedAt = new Date().toISOString();
            store.save();
            return sendJson(res, 200, { ok: true, config: cfg });
          }

          case 'saveCompose': {
            if (body.subject !== undefined) store.state.compose.subject = String(body.subject);
            if (body.body !== undefined) store.state.compose.body = String(body.body);
            if (body.senderName !== undefined) store.state.compose.senderName = String(body.senderName);
            store.state.compose.updatedAt = new Date().toISOString();
            store.save();
            return sendJson(res, 200, { ok: true, compose: store.state.compose });
          }

          case 'getFolders': {
            if (body.accountId) {
              wsHub.sendToAccount(body.accountId, { type: 'FETCH_FOLDERS', tabId: body.tabId });
            } else {
              wsHub.broadcastAgents({ type: 'FETCH_FOLDERS' });
            }
            return sendJson(res, 200, { ok: true, requested: true });
          }

          case 'reloadTab': {
            let accountId = body.accountId;
            if (!accountId && body.key) {
              accountId = body.key.split(':')[0];
            }
            if (!accountId && body.email) {
              const acc = store.listAccounts().find((a) => a.email.toLowerCase() === String(body.email).toLowerCase());
              if (acc) accountId = acc.id;
            }

            const tabId = body.tabId !== undefined ? Number(body.tabId) : 0;
            let targetTab = (accountId && store.state.onlineTabs[`${accountId}:${tabId}`])
              || (body.key && store.state.onlineTabs[body.key])
              || store.listOnlineTabs().find((t) => t.accountId === accountId || (body.key && t.key === body.key) || (body.email && t.email === body.email));

            const isSessionRunning = accountId ? Boolean(browserManager.getRunningSession(accountId)) : false;
            const isWsConnected = accountId ? wsHub.isAccountConnected(accountId) : false;
            const isOffline = !isSessionRunning || !isWsConnected;

            if (isOffline) {
              // BROWSER IS OFFLINE: Re-open browser window and attempt shoot!
              if (accountId) {
                const account = store.getAccount(accountId);
                if (account) {
                  if (!targetTab) {
                    targetTab = store.upsertOnlineTab({
                      tabKey: `${accountId}:${tabId}`,
                      tabId,
                      accountId,
                      email: account.email,
                      provider: account.provider || 'gmail',
                      tabName: `${account.provider || 'gmail'} #${tabId + 1}`,
                      status: 'Reopening...',
                      isActive: true,
                      proxy: account.proxy
                    });
                  } else {
                    store.upsertOnlineTab({
                      ...targetTab,
                      status: 'Reopening...',
                      isActive: true
                    });
                  }
                  wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });

                  // Mark pending shoot so once browser opens and inbox is ready, it attempts shoot
                  pendingShoots.add(accountId);

                  // Launch browser window asynchronously without blocking HTTP response
                  browserManager.launchAccount(accountId).catch((err) => {
                    console.error(`Failed to re-open browser for ${accountId}:`, err);
                    pendingShoots.delete(accountId);
                    store.upsertOnlineTab({
                      ...targetTab,
                      status: `Launch Error: ${err.message}`,
                      isBlocked: true
                    });
                    wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
                  });

                  return sendJson(res, 200, { ok: true, reopened: true, accountId, status: 'Reopening...' });
                }
              }
            } else {
              // Browser is already online: send reload command to extension
              wsHub.sendToAccount(accountId, { type: 'RELOAD_TABS', tabIds: [tabId] });
              // If shoot is active or data allocated, attempt shoot
              if (targetTab && (store.state.shootState?.active || targetTab.dataAllocated)) {
                attemptShootForTab(targetTab).catch((err) => {
                  console.error('Error attempting shoot on online tab reload:', err);
                });
              }
              return sendJson(res, 200, { ok: true, reopened: false });
            }
            return sendJson(res, 200, { ok: true, reopened: false });
          }

          case 'reloadAll': {
            const tabs = store.listOnlineTabs();
            let reopenedCount = 0;
            const seenAccounts = new Set();

            for (const t of tabs) {
              const accId = t.accountId;
              if (!accId || seenAccounts.has(accId)) continue;
              seenAccounts.add(accId);

              const isSessionRunning = Boolean(browserManager.getRunningSession(accId));
              const isWsConnected = wsHub.isAccountConnected(accId);

              if (!isSessionRunning || !isWsConnected) {
                // Offline: Re-open browser window and queue shoot
                store.upsertOnlineTab({
                  ...t,
                  status: 'Reopening...',
                  isActive: true
                });
                pendingShoots.add(accId);
                browserManager.launchAccount(accId).catch((err) => {
                  console.error(`Failed to re-open browser for ${accId}:`, err);
                  pendingShoots.delete(accId);
                });
                reopenedCount++;
              } else {
                // Online: reload tab
                wsHub.sendToAccount(accId, { type: 'RELOAD_TABS', tabIds: [t.tabId] });
                if (store.state.shootState?.active || t.dataAllocated) {
                  attemptShootForTab(t).catch(() => {});
                }
              }
            }

            wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
            return sendJson(res, 200, { ok: true, reopenedCount });
          }

          case 'closeTab':
            if (body.accountId && browserManager.getRunningSession(body.accountId)) {
              await browserManager.stopAccount(body.accountId);
            } else {
              wsHub.sendToAccount(body.accountId, { type: 'CLOSE_TAB', tabId: body.tabId });
              store.removeOnlineTab(body.key || body.accountId || body.tabId);
            }
            wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
            return sendJson(res, 200, { ok: true, onlineTabs: store.listOnlineTabs() });

          case 'closeAll':
            await browserManager.stopAll();
            wsHub.broadcastAgents({ type: 'CLOSE_WINDOW' });
            store.state.onlineTabs = {};
            store.save();
            wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: [] });
            return sendJson(res, 200, { ok: true, onlineTabs: [] });

          case 'pinTab': {
            const t = store.state.onlineTabs[body.key];
            if (t) {
              t.pinned = !t.pinned;
              store.save();
              wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
            }
            return sendJson(res, 200, { ok: true, onlineTabs: store.listOnlineTabs() });
          }

          case 'shoot':
            return sendJson(res, 200, await dispatchShoot({ isTest: false, overrideSubject: body.subject, overrideBody: body.body }));

          case 'testShoot':
            return sendJson(res, 200, await dispatchShoot({ isTest: true, testEmail: body.email || '', overrideSubject: body.subject, overrideBody: body.body }));

          case 'abortShoot':
            return sendJson(res, 200, abortActiveShoot());

          default:
            return sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
        }
      }

      // ── Accounts & Per-Account Proxies REST API ─────────────────────────────
      if (pathname === '/api/accounts') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, accounts: store.listAccounts() });
        }
        if (req.method === 'POST') {
          const body = await parseBodyParams(req);
          if (body.bulk) {
            const { accounts: parsed, invalid } = parseBulkCredentials(body.bulk);
            const saved = [];
            for (const item of parsed) {
              if (body.defaultProxy && !item.proxy) item.proxy = body.defaultProxy;
              saved.push(store.upsertAccount(item));
            }
            return sendJson(res, 200, { ok: true, count: saved.length, invalid, accounts: store.listAccounts() });
          }
          const acc = store.upsertAccount(body);
          return sendJson(res, 200, { ok: true, account: acc, accounts: store.listAccounts() });
        }
      }

      if (pathname.startsWith('/api/accounts/')) {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const rest = pathname.slice('/api/accounts/'.length);
        const [accountId, subAction] = rest.split('/');

        if (req.method === 'DELETE' && !subAction) {
          await browserManager.stopAccount(accountId);
          const ok = store.deleteAccount(accountId);
          return sendJson(res, 200, { ok, accounts: store.listAccounts() });
        }

        if (req.method === 'POST' && subAction === 'launch') {
          const body = await parseBodyParams(req);
          const launched = await browserManager.launchAccount(accountId, {
            headless: body.headless,
            startUrl: body.startUrl,
            ipCheckUrl: body.ipCheckUrl
          });
          wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
          return sendJson(res, 200, { ok: true, ...launched, accounts: store.listAccounts() });
        }

        if (req.method === 'POST' && subAction === 'stop') {
          const stopped = await browserManager.stopAccount(accountId);
          wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
          return sendJson(res, 200, { ok: stopped, accounts: store.listAccounts() });
        }

        if (req.method === 'POST' && subAction === 'test-proxy') {
          const body = await parseBodyParams(req);
          const acc = store.getAccount(accountId);
          if (!acc) return sendJson(res, 404, { ok: false, error: 'Account not found' });
          if (!acc.proxy) return sendJson(res, 400, { ok: false, error: 'No proxy assigned to account' });
          const probe = await probeProxyIp(acc.proxy, { checkUrl: body.checkUrl });
          store.updateAccountIpStatus(acc.id, probe);
          wsHub.broadcastDashboards({ type: 'TABS_UPDATED', onlineTabs: store.listOnlineTabs() });
          return sendJson(res, 200, { ok: probe.ok, probe, accounts: store.listAccounts() });
        }
      }

      // ── Generic Proxy Probe ─────────────────────────────────────────────────
      if (pathname === '/api/proxies/test' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = await parseBodyParams(req);
        try {
          proxyParser.parseProxy(body.proxy);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        const probe = await probeProxyIp(body.proxy, { checkUrl: body.checkUrl });
        return sendJson(res, 200, { ok: probe.ok, probe });
      }

      // ── HTML -> PDF / Image Conversion API ──────────────────────────────────
      if (pathname === '/api/convert' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = await parseBodyParams(req);
        const result = await convertHtml({
          html: body.html || store.state.compose.body,
          format: body.format || 'pdf',
          filename: body.filename || 'document',
          watermark: body.watermark || ''
        });
        return sendJson(res, 200, {
          ok: true,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
          base64: result.buffer.toString('base64')
        });
      }

      // ── Uploaded Files API ──────────────────────────────────────────────────
      if (pathname === '/api/files') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        return sendJson(res, 200, { ok: true, files: store.state.uploadedFiles });
      }

      if (pathname === '/api/files/upload' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = await parseBodyParams(req);
        if (!body.filename || body.base64 === undefined) {
          return sendJson(res, 400, { ok: false, error: 'filename and base64 required' });
        }
        const buf = Buffer.from(String(body.base64), 'base64');
        const id = `file_${crypto.randomBytes(6).toString('hex')}`;
        const safeName = path.basename(String(body.filename)).replace(/[^a-zA-Z0-9._-]+/g, '_');
        const diskPath = path.join(store.uploadsDir, `${id}_${safeName}`);
        fs.writeFileSync(diskPath, buf);

        const rec = {
          id,
          originalName: safeName,
          mimeType: body.mimeType || MIME_TYPES[path.extname(safeName).toLowerCase()] || 'application/octet-stream',
          size: buf.length,
          path: diskPath,
          uploadedAt: new Date().toISOString()
        };
        store.state.uploadedFiles.push(rec);
        store.save();
        return sendJson(res, 200, { ok: true, file: rec, files: store.state.uploadedFiles });
      }

      if (pathname.startsWith('/api/files/') && req.method === 'DELETE') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const id = pathname.slice('/api/files/'.length);
        const rec = store.state.uploadedFiles.find((f) => f.id === id);
        if (rec && fs.existsSync(rec.path)) fs.unlinkSync(rec.path);
        store.state.uploadedFiles = store.state.uploadedFiles.filter((f) => f.id !== id);
        store.save();
        return sendJson(res, 200, { ok: true, files: store.state.uploadedFiles });
      }

      // ── SMS Verification Pool REST API ──────────────────────────────────────
      if (pathname === '/api/verification') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        return sendJson(res, 200, {
          ok: true,
          stats: store.verificationPool.getStats(),
          items: store.verificationPool.toJSON()
        });
      }

      if (pathname === '/api/verification/sync' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = await parseBodyParams(req);
        const result = store.syncVerificationString(body.raw || '');
        return sendJson(res, 200, {
          ok: true,
          result,
          stats: store.verificationPool.getStats(),
          items: store.verificationPool.toJSON()
        });
      }

      if (pathname === '/api/verification/clear' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        store.verificationPool.clear();
        store.save();
        return sendJson(res, 200, { ok: true, stats: store.verificationPool.getStats(), items: [] });
      }

      if (pathname === '/api/verification/reset-errors' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const count = store.verificationPool.resetPermanentErrors();
        store.save();
        return sendJson(res, 200, { ok: true, resetCount: count, stats: store.verificationPool.getStats(), items: store.verificationPool.toJSON() });
      }

      // ── GMASS-2 / GMASS-4 API ───────────────────────────────────────────────
      if (pathname === '/api/gmass' && req.method === 'GET') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        return sendJson(res, 200, { ok: true, gmass: store.state.gmass });
      }

      if (pathname === '/api/gmass/config' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = await parseBodyParams(req);
        if (Array.isArray(body.selectedDomains)) store.state.gmass.selectedDomains = body.selectedDomains;
        if (body.mode) store.state.gmass.mode = String(body.mode);
        if (body.htmlOnly !== undefined) store.state.gmass.htmlOnly = Boolean(body.htmlOnly);
        store.save();
        return sendJson(res, 200, { ok: true, gmass: store.state.gmass });
      }

      if (pathname === '/api/gmass/pause' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        for (const timer of shootTimers) {
          if (timer.__isGmass) {
            clearTimeout(timer);
            shootTimers.delete(timer);
          }
        }
        store.state.gmass.paused = true;
        store.state.gmass.active = false;
        store.state.gmass.statusText = 'Paused';
        store.save();
        wsHub.broadcastAgents({ type: 'ABORT_DISPATCH', campaignId: store.state.gmass.activeCampaignId || null });
        wsHub.broadcastDashboards({ type: 'GMASS_PAUSED', gmass: store.state.gmass });
        return sendJson(res, 200, { ok: true, paused: true, gmass: store.state.gmass });
      }

      if (pathname === '/api/gmass/send' && req.method === 'POST') {
        const sess = requireAuthApi(req, res);
        if (!sess) return;
        const body = await parseBodyParams(req);
        const emails = String(body.emails || '')
          .split(/[\r\n,;]+/)
          .map((s) => s.trim())
          .filter((s) => s && s.includes('@'));
        if (emails.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'At least one target email is required' });
        }

        const selectedDomains = Array.isArray(body.selectedDomains) ? body.selectedDomains : (store.state.gmass.selectedDomains || []);
        const allTabs = store.listOnlineTabs().filter((t) => t.isActive && !t.isBlocked);
        const tabs = selectedDomains.length > 0
          ? allTabs.filter((t) => selectedDomains.some((dom) => String(t.email || '').toLowerCase().endsWith(`@${dom.toLowerCase()}`)))
          : allTabs;
        if (tabs.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'No online sender tabs available for GMASS blast' });
        }

        const gmassId = `gmass_${crypto.randomBytes(5).toString('hex')}`;
        store.state.gmass.active = true;
        store.state.gmass.paused = false;
        store.state.gmass.activeCampaignId = gmassId;
        store.state.gmass.selectedDomains = selectedDomains;
        store.state.gmass.statusText = 'Sending';

        const uploadedAtts = [];
        for (const f of store.state.uploadedFiles || []) {
          if (Array.isArray(body.selectedFiles) && body.selectedFiles.includes(f.id) && fs.existsSync(f.path)) {
            uploadedAtts.push({
              filename: f.originalName,
              mimeType: f.mimeType,
              base64: fs.readFileSync(f.path).toString('base64'),
              size: f.size
            });
          }
        }

        const staggerMs = Math.max(0, Number(body.staggerMs || 0));
        const results = [];
        for (let i = 0; i < emails.length; i++) {
          const recipient = emails[i];
          const tab = tabs[i % tabs.length];
          const cache = {};
          const resolved = processTags(
            recipient,
            { subject: body.subject || '', message: body.message || '', pdfHtml: body.pdfHtml || '' },
            { customTags: store.getTags(), tagCounters: store.state.tagCounters, senderName: body.fromName || '', cache }
          );
          const attachments = [...uploadedAtts];
          const usePdf = Boolean(body.convertPdf) && !body.htmlOnly;
          if (usePdf && resolved.pdfHtml) {
            const conv = await convertHtml({
              html: resolved.pdfHtml,
              format: 'pdf',
              filename: body.filename || 'document',
              watermark: body.watermark || ''
            });
            attachments.push({
              filename: conv.filename,
              mimeType: conv.mimeType,
              base64: conv.buffer.toString('base64'),
              size: conv.size
            });
          }

          const taskMsg = {
            type: 'EXECUTE_DISPATCH',
            taskId: `${gmassId}_${i}`,
            campaignId: gmassId,
            accountId: tab.accountId,
            tabId: tab.tabId,
            provider: tab.provider || 'gmail',
            recipientEmail: recipient,
            subject: resolved.subject,
            body: resolved.message,
            isHtml: true,
            attachments
          };

          if (staggerMs > 0 && i > 0) {
            const entry = {
              id: `${gmassId}_${i}`,
              recipient,
              sender: tab.email,
              subject: resolved.subject,
              status: 'scheduled',
              ts: new Date().toISOString()
            };
            results.push(entry);
            store.state.gmass.sentLog.unshift(entry);
            const timer = setTimeout(() => {
              shootTimers.delete(timer);
              if (store.state.gmass.paused || store.state.gmass.activeCampaignId !== gmassId) return;
              const ok = wsHub.sendToAccount(tab.accountId, taskMsg);
              entry.status = ok ? 'dispatched' : 'queued';
              store.save();
              wsHub.broadcastDashboards({ type: 'GMASS_PROGRESS', entry, gmass: store.state.gmass });
            }, i * staggerMs);
            timer.__isGmass = true;
            timer.unref();
            shootTimers.add(timer);
          } else {
            const delivered = wsHub.sendToAccount(tab.accountId, taskMsg);
            const entry = {
              id: `${gmassId}_${i}`,
              recipient,
              sender: tab.email,
              subject: resolved.subject,
              status: delivered ? 'dispatched' : 'queued',
              ts: new Date().toISOString()
            };
            results.push(entry);
            store.state.gmass.sentLog.unshift(entry);
          }
        }
        store.state.gmass.sentLog = store.state.gmass.sentLog.slice(0, 500);
        if (staggerMs === 0) {
          store.state.gmass.active = false;
          store.state.gmass.statusText = 'Completed';
        }
        store.save();
        return sendJson(res, 200, { ok: true, gmassId, count: results.length, sentLog: store.state.gmass.sentLog, gmass: store.state.gmass });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    wsHub.handleUpgrade(req, socket, head);
  });

  return {
    server,
    store,
    wsHub,
    browserManager,
    async start(port = Number(options.port ?? process.env.PORT ?? 8080), host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          if (typeof browserManager.setServerPort === 'function') {
            browserManager.setServerPort(addr.port);
          }
          resolve(addr);
        });
      });
      return server.address();
    },
    async stop() {
      for (const t of shootTimers) clearTimeout(t);
      shootTimers.clear();
      wsHub.closeAll();
      await browserManager.stopAll();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

module.exports = { createServer };
