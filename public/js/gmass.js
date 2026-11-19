(function () {
  'use strict';

  const C = window.RelayCommon;
  let allLogs = [];
  let onlineTabs = [];
  let uploadedFiles = [];
  let selectedDomains = [];
  let selectedFileIds = new Set();
  let showFailedOnly = false;

  function renderLog(logs = [], total = 0) {
    allLogs = Array.isArray(logs) ? logs : [];
    const box = document.getElementById('gmSentLog');
    box.textContent = '';
    const visible = showFailedOnly
      ? allLogs.filter((l) => /fail|err|queue/i.test(String(l.status || '')))
      : allLogs;
    document.getElementById('gmSentTotal').textContent = `Total: ${allLogs.length} / ${total || allLogs.length}`;
    for (const item of visible) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:7px 9px;border:1px solid var(--border);border-radius:7px;background:var(--surface-alt);';
      row.textContent = `${item.recipient} · ${item.status} (${item.sender || 'auto'})`;
      box.appendChild(row);
    }
  }

  function updateDomainBadge() {
    const isLoginStage = (t) => C.isLoginStageTab ? C.isLoginStageTab(t) : (!t.email || String(t.email).includes('Login Pending') || String(t.status) === 'login_pending');
    const readyTabs = onlineTabs.filter((t) => t.isActive && !t.isBlocked && !isLoginStage(t));
    const pendingTabs = onlineTabs.filter(isLoginStage);
    const countEl = document.getElementById('gmStateCount');
    if (countEl) countEl.textContent = String(readyTabs.length);
    const hint = document.getElementById('gmDomainHint');
    if (hint) {
      if (selectedDomains.length > 0) {
        hint.textContent = selectedDomains.join(', ');
      } else if (readyTabs.length > 0) {
        hint.textContent = pendingTabs.length > 0 ? `ALL DOMAINS (${pendingTabs.length} pending login)` : 'ALL DOMAINS';
      } else if (pendingTabs.length > 0) {
        hint.textContent = `${pendingTabs.length} TAB(S) LOGIN PENDING`;
      } else {
        hint.textContent = 'SELECT DOMAIN TO CONTINUE';
      }
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    C.initThemeToggle();
    const isEmbed = new URLSearchParams(window.location.search).get('embed') === '1';
    if (isEmbed) document.getElementById('gmassTopNav').style.display = 'none';

    const isGmass4 = window.location.pathname.includes('gmass4');
    document.getElementById('gmassModeHeading').textContent = isGmass4 ? 'GMASS-4 (Fastest Blaster)' : 'Script · Bin4ry Relay';
    document.getElementById(isGmass4 ? 'navG4' : 'navG2')?.classList.add('is-active');

    const domainsDlg = document.getElementById('domainsDialog');
    const previewDlg = document.getElementById('gmPreviewDialog');
    const attachDlg = document.getElementById('gmAttachDialog');
    C.wireDialog(domainsDlg, document.getElementById('domainsDlgClose'));
    C.wireDialog(previewDlg, document.getElementById('gmPreviewClose'));
    C.wireDialog(attachDlg, document.getElementById('gmAttachClose'));

    document.getElementById('gmEmails').addEventListener('input', (e) => {
      const n = e.target.value.split(/[\r\n,;]+/).filter((s) => s.trim()).length;
      document.getElementById('gmEmailCount').textContent = String(n);
    });

    const convCb = document.getElementById('gmConvertPdf');
    const htmlOnlyCb = document.getElementById('gmHtmlOnly');
    convCb.addEventListener('change', () => {
      if (convCb.checked) htmlOnlyCb.checked = false;
    });
    htmlOnlyCb.addEventListener('change', () => {
      if (htmlOnlyCb.checked) convCb.checked = false;
    });

    const [gmResp, dashResp, extResp] = await Promise.all([
      C.apiJson('/api/gmass'),
      C.relayAction('getDashboard').catch(() => ({})),
      C.pingExtension ? C.pingExtension(1000).catch(() => null) : Promise.resolve(null)
    ]);
    onlineTabs = (extResp?.tabs && Array.isArray(extResp.tabs) && extResp.tabs.length > 0)
      ? extResp.tabs
      : (dashResp.onlineTabs || []);
    uploadedFiles = dashResp.uploadedFiles || [];
    selectedDomains = gmResp.gmass?.selectedDomains || [];
    if (gmResp.gmass?.htmlOnly) htmlOnlyCb.checked = true;
    if (gmResp.gmass?.sentLog) renderLog(gmResp.gmass.sentLog);
    updateDomainBadge();

    document.getElementById('gmSelectDomainsBtn').addEventListener('click', () => {
      const list = document.getElementById('domainsCheckList');
      list.textContent = '';
      const isLoginStage = (t) => C.isLoginStageTab ? C.isLoginStageTab(t) : (!t.email || String(t.email).includes('Login Pending') || String(t.status) === 'login_pending');
      const readyTabs = onlineTabs.filter((t) => t.isActive && !t.isBlocked && !isLoginStage(t));
      const pendingTabs = onlineTabs.filter(isLoginStage);

      // Display pending tabs notice gracefully without throwing
      if (pendingTabs.length > 0) {
        const pSec = document.createElement('div');
        pSec.style.cssText = 'padding:6px 10px;border-radius:6px;background:var(--warning-bg);color:var(--warning);font-size:11.5px;font-weight:600;margin-bottom:8px;';
        pSec.textContent = `⏳ ${pendingTabs.length} tab(s) in login stage (authentication pending). Complete login in tab to enable sending.`;
        list.appendChild(pSec);
      }

      const domains = [...new Set(readyTabs.map((t) => {
        try {
          const parts = String(t.email || '').split('@');
          return parts.length > 1 ? parts[1].toLowerCase().trim() : null;
        } catch {
          return null;
        }
      }).filter(Boolean))];

      if (domains.length === 0) {
        const p = document.createElement('div');
        p.style.cssText = 'font-size:12px;color:var(--text-muted);padding:4px 0;';
        p.textContent = pendingTabs.length > 0
          ? 'No authenticated sender domains ready yet. Tabs are awaiting login.'
          : 'No online sender domains available yet.';
        list.appendChild(p);
      } else {
        for (const dom of domains) {
          const lbl = document.createElement('label');
          lbl.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = dom;
          cb.checked = selectedDomains.includes(dom);
          lbl.append(cb, document.createTextNode(dom));
          list.appendChild(lbl);
        }
      }
      domainsDlg.showModal();
    });

    document.getElementById('clearDomainsBtn').addEventListener('click', async () => {
      selectedDomains = [];
      await C.apiJson('/api/gmass/config', { method: 'POST', body: JSON.stringify({ selectedDomains: [] }) });
      updateDomainBadge();
      domainsDlg.close();
    });

    document.getElementById('applyDomainsBtn').addEventListener('click', async () => {
      selectedDomains = [...document.querySelectorAll('#domainsCheckList input:checked')].map((c) => c.value);
      await C.apiJson('/api/gmass/config', { method: 'POST', body: JSON.stringify({ selectedDomains }) });
      updateDomainBadge();
      domainsDlg.close();
    });

    document.getElementById('gmAttachBtn').addEventListener('click', () => {
      const list = document.getElementById('gmAttachFilesList');
      list.textContent = '';
      if (uploadedFiles.length === 0) {
        const p = document.createElement('div');
        p.style.cssText = 'font-size:12px;color:var(--text-muted)';
        p.textContent = 'Upload files in FILES tab first.';
        list.appendChild(p);
      } else {
        for (const f of uploadedFiles) {
          const lbl = document.createElement('label');
          lbl.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selectedFileIds.has(f.id);
          cb.addEventListener('change', () => {
            if (cb.checked) selectedFileIds.add(f.id);
            else selectedFileIds.delete(f.id);
          });
          lbl.append(cb, document.createTextNode(`${f.originalName} (${Math.round(f.size / 1024)} KB)`));
          list.appendChild(lbl);
        }
      }
      attachDlg.showModal();
    });

    document.getElementById('gmShowFailedBtn').addEventListener('click', (e) => {
      showFailedOnly = !showFailedOnly;
      e.currentTarget.setAttribute('aria-pressed', String(showFailedOnly));
      e.currentTarget.classList.toggle('is-selected', showFailedOnly);
      renderLog(allLogs);
    });

    document.getElementById('gmPauseBtn').addEventListener('click', async () => {
      const r = await C.apiJson('/api/gmass/pause', { method: 'POST', body: '{}' });
      const status = document.getElementById('gmassStatusPill');
      status.innerHTML = 'Status: <strong>Paused</strong>';
      C.showToast('GMASS Paused', 'Campaign paused and active dispatches aborted.', 'warning');
      if (r.gmass?.sentLog) renderLog(r.gmass.sentLog);
    });

    document.getElementById('gmResumeBtn')?.addEventListener('click', async () => {
      const r = await C.apiJson('/api/gmass/resume', { method: 'POST', body: '{}' });
      const status = document.getElementById('gmassStatusPill');
      status.innerHTML = 'Status: <strong>Resumed</strong>';
      C.showToast('GMASS Resumed', 'Campaign dispatch resumed.', 'success');
      if (r.gmass?.sentLog) renderLog(r.gmass.sentLog);
    });

    document.getElementById('gmStopBtn')?.addEventListener('click', async () => {
      const r = await C.apiJson('/api/gmass/stop', { method: 'POST', body: '{}' });
      const status = document.getElementById('gmassStatusPill');
      status.innerHTML = 'Status: <strong>Stopped</strong>';
      C.showToast('GMASS Stopped', 'Campaign stopped.', 'info');
      if (r.gmass?.sentLog) renderLog(r.gmass.sentLog);
    });

    document.getElementById('gmBlastBtn').addEventListener('click', async () => {
      const status = document.getElementById('gmassStatusPill');
      status.innerHTML = 'Status: <strong>Blasting...</strong>';
      const delayInp = document.getElementById('gmDelayInterval');
      const staggerMs = delayInp ? (parseInt(delayInp.value, 10) || 0) : (isGmass4 ? 100 : 300);
      const r = await C.apiJson('/api/gmass/send', {
        method: 'POST',
        body: JSON.stringify({
          emails: document.getElementById('gmEmails').value,
          subject: document.getElementById('gmSubject').value,
          message: document.getElementById('gmMessage').value,
          pdfHtml: document.getElementById('gmPdfHtml').value,
          convertPdf: convCb.checked && !htmlOnlyCb.checked,
          htmlOnly: htmlOnlyCb.checked,
          selectedDomains,
          selectedFiles: [...selectedFileIds],
          staggerMs,
          watermark: document.getElementById('gmWatermark').value,
          filename: document.getElementById('gmFilename').value,
          fromName: document.getElementById('gmFromName').value
        })
      });
      if (!r.ok) {
        status.innerHTML = 'Status: <strong>Error</strong>';
        C.showToast('GMASS Error', r.error, 'error');
        return;
      }
      status.innerHTML = 'Status: <strong>Sending</strong>';
      renderLog(r.sentLog, r.count);
      C.showToast('GMASS Dispatched', `Queued ${r.count} message(s)`, 'success');
    });

    document.getElementById('gmPreviewPdfBtn').addEventListener('click', async () => {
      const html = document.getElementById('gmPdfHtml').value || document.getElementById('gmMessage').value || '<h1>Preview</h1>';
      document.getElementById('gmPreviewFrame').srcdoc = html;
      document.getElementById('gmPreviewMeta').textContent = 'Checking local PDF renderer...';
      previewDlg.showModal();
      const r = await C.apiJson('/api/convert', {
        method: 'POST',
        body: JSON.stringify({
          html,
          format: 'pdf',
          filename: document.getElementById('gmFilename').value || 'preview',
          watermark: document.getElementById('gmWatermark').value
        })
      });
      if (r.ok) {
        document.getElementById('gmPreviewMeta').textContent = `${r.filename} rendered (${Math.round(r.size / 1024)} KB)`;
        C.showToast('PDF Ready', `${r.filename} (${Math.round(r.size / 1024)} KB)`, 'success');
      } else {
        document.getElementById('gmPreviewMeta').textContent = r.error || 'Conversion error';
        C.showToast('Preview Error', r.error, 'error');
      }
    });

    function connectGmassWs() {
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const sock = new WebSocket(`${proto}//${window.location.host}/ws/dashboard`);
        sock.addEventListener('open', () => {
          try { sock.send(JSON.stringify({ type: 'PING_TABS' })); } catch {}
        });
        sock.addEventListener('message', (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.onlineTabs || msg.tabs) {
              onlineTabs = msg.onlineTabs || msg.tabs;
              updateDomainBadge();
            }
            if ((msg.type === 'GMASS_PROGRESS' || msg.type === 'GMASS_PAUSED' || msg.type === 'GMASS_RESUMED' || msg.type === 'GMASS_STOPPED') && msg.gmass) {
              if (Array.isArray(msg.gmass.sentLog)) renderLog(msg.gmass.sentLog);
              const statusEl = document.getElementById('gmassStatusPill');
              if (statusEl && msg.gmass.statusText) {
                statusEl.innerHTML = 'Status: <strong></strong>';
                statusEl.querySelector('strong').textContent = msg.gmass.statusText;
              }
            }
          } catch {}
        });
      } catch {}

      // Fallback polling for tabs
      setInterval(async () => {
        try {
          const res = await C.apiJson('/api/tabs');
          const fresh = res?.onlineTabs || res?.tabs;
          if (Array.isArray(fresh)) {
            onlineTabs = fresh;
            updateDomainBadge();
          }
        } catch {}
      }, 5000);
    }
    connectGmassWs();
  });
})();
