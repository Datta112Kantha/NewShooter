(function () {
  'use strict';

  const C = window.RelayCommon;
  let state = {
    onlineTabs: [],
    totalOpenTabs: 0,
    accounts: [],
    predefinedTags: [],
    customTags: {},
    dataCount: 0,
    dataPreview: [],
    testRecipients: [],
    uploadedFiles: [],
    attachmentConfig: { format: 'html', selectedFiles: [] },
    shootSettings: { gmail: 3, yahoo: 5, outlook: 5, layout: 'two-col', forceStart: false },
    shootQuota: { dailyLimit: 60000, sentToday: 0, expiryHours: 3 },
    activeFilters: new Set(),
    searchQuery: '',
    sourceMode: false
  };

  let dashboardWs = null;
  let lastGeneratedAi = null;

  function setStatusAlert(msg) {
    const al = document.getElementById('alertRegion');
    if (al) al.textContent = msg;
  }

  async function applyExtensionTabs(resp) {
    if (!resp) return;
    if (Array.isArray(resp.tabs) && resp.tabs.length > 0) {
      state.onlineTabs = resp.tabs;
      renderTabsTable();
      updateDockEstimate();
      await C.apiJson('/api/tabs', { method: 'POST', body: JSON.stringify({ tabs: resp.tabs }) }).catch(() => {});
    }
    const totalCount = typeof resp.totalBrowserTabs === 'number'
      ? resp.totalBrowserTabs
      : (typeof resp.total === 'number' ? resp.total : (resp.tabs?.length || 0));
    state.totalOpenTabs = totalCount;
    const badge = document.getElementById('totalOpenTabsBadge');
    if (badge) {
      badge.textContent = `Tabs: ${totalCount}`;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'BIN4RY_EXTENSION_ANNOUNCE' && e.data.extensionId) {
        state.extensionId = e.data.extensionId;
        window.RELAY_EXTENSION_ID = e.data.extensionId;
        try { localStorage.setItem('relay_extension_id', e.data.extensionId); } catch {}
      }
      if (e.data.type === 'BIN4RY_TABS_RESPONSE') {
        applyExtensionTabs(e.data);
      }
    });
  }

  function updateCounts() {
    const editor = document.getElementById('composeEditor');
    const source = document.getElementById('composeSource');
    const text = state.sourceMode
      ? source.value.replace(/<[^>]+>/g, ' ').trim()
      : (editor.innerText || '').trim();
    document.getElementById('charCount').textContent = String(text.length);
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    document.getElementById('wordCount').textContent = String(words);
  }

  function renderTabsTable() {
    const tbody = document.getElementById('onlineTabsBody');
    const q = state.searchQuery.toLowerCase();
    const tabs = state.onlineTabs || [];

    const isLoginStageTab = (t) => C.isLoginStageTab ? C.isLoginStageTab(t) : (!t.email || String(t.email).includes('Login Pending') || String(t.status) === 'login_pending');

    const gmailCount = tabs.filter((t) => (t.provider || 'gmail') === 'gmail' && !isLoginStageTab(t)).length;
    const outlookCount = tabs.filter((t) => t.provider === 'outlook' && !isLoginStageTab(t)).length;
    const yahooCount = tabs.filter((t) => t.provider === 'yahoo' && !isLoginStageTab(t)).length;
    const loginPendingCount = tabs.filter(isLoginStageTab).length;
    const blockedCount = tabs.filter((t) => t.isBlocked).length;
    const dupCount = tabs.filter((t) => t.isDup).length;

    const parts = [];
    if (gmailCount || (!outlookCount && !yahooCount && !loginPendingCount)) parts.push(`Gmail ${gmailCount}`);
    if (outlookCount) parts.push(`Outlook ${outlookCount}`);
    if (yahooCount) parts.push(`Yahoo ${yahooCount}`);
    if (loginPendingCount) parts.push(`Login Pending ${loginPendingCount}`);
    document.getElementById('providerCountBadge').textContent = parts.join(' · ');

    const totalBadge = document.getElementById('totalOpenTabsBadge');
    if (totalBadge) {
      const count = typeof state.totalOpenTabs === 'number'
        ? state.totalOpenTabs
        : tabs.length;
      totalBadge.textContent = `Tabs: ${count}`;
    }

    const blkBadge = document.getElementById('blockedCountBadge');
    blkBadge.textContent = `${blockedCount} Blocked`;
    blkBadge.hidden = blockedCount === 0;
    document.getElementById('dupCountNum').textContent = String(dupCount);

    const readyTabs = tabs.filter((t) => t.isActive && !t.isBlocked && !isLoginStageTab(t));
    const pendingTabs = tabs.filter(isLoginStageTab);
    const statusChip = document.getElementById('actionStatusChip');
    const statusText = document.getElementById('actionStatusText');
    if (state.shootState?.active) {
      statusChip.className = 'action-status-chip is-busy';
      statusText.textContent = `Shooting (${state.shootState.completedTasks}/${state.shootState.totalTasks})...`;
    } else if (readyTabs.length > 0) {
      statusChip.className = 'action-status-chip is-ready';
      statusText.textContent = pendingTabs.length > 0
        ? `Ready · ${readyTabs.length} online (${pendingTabs.length} pending login)`
        : `Ready · ${readyTabs.length} tabs online`;
    } else if (pendingTabs.length > 0) {
      statusChip.className = 'action-status-chip is-busy';
      statusText.textContent = `${pendingTabs.length} tab(s) pending login...`;
    } else {
      statusChip.className = 'action-status-chip';
      statusText.textContent = 'Waiting for tabs...';
    }

    const filtered = tabs.filter((t) => {
      const isPending = isLoginStageTab(t);
      const textToMatch = `${t.email || ''} ${t.tabName || ''} ${t.provider || ''} ${t.status || ''} ${isPending ? 'login pending' : ''}`.toLowerCase();
      if (q && !textToMatch.includes(q)) return false;
      if (state.activeFilters.has('duplicates') && !t.isDup) return false;
      if (state.activeFilters.has('blocked') && !t.isBlocked) return false;
      if (state.activeFilters.has('inactive') && t.isActive) return false;
      if (state.activeFilters.has('sent') && !(t.sent > 0)) return false;
      return true;
    });

    tbody.textContent = '';
    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 10;
      td.style.padding = '28px 12px';
      td.style.color = 'var(--text-muted)';
      td.textContent = tabs.length === 0
        ? 'No online sender tabs connected. Click "+ Accounts & Proxies" to launch an isolated proxied browser or connect Chrome Extension.'
        : 'No tabs match your current filter.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const tab of filtered) {
      const tr = document.createElement('tr');
      const isPending = isLoginStageTab(tab);
      if (tab.isDup) tr.classList.add('is-dup');
      if (tab.isBlocked) tr.classList.add('is-blocked');
      if (isPending) tr.classList.add('is-login-pending');

      const tdNum = document.createElement('td');
      tdNum.className = 'col-num';
      tdNum.textContent = String(tab.index || '-');

      const tdData = document.createElement('td');
      tdData.className = 'col-data';
      const dataText = String(tab.dataAllocated || '');
      const countAlloc = dataText ? dataText.split(',').filter((s) => s.trim()).length : 0;
      tdData.textContent = isPending ? '—' : (countAlloc ? `${countAlloc} rec` : '—');
      tdData.title = isPending ? 'Awaiting login completion' : dataText;

      const tdEmail = document.createElement('td');
      tdEmail.className = 'col-email';
      const emailWrap = document.createElement('div');
      emailWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
      if (C.getProviderIconHtml) {
        emailWrap.innerHTML = C.getProviderIconHtml(tab.provider);
      }

      if (isPending) {
        const badge = document.createElement('span');
        badge.className = 'status-pill status-pill--pending';
        badge.style.cssText = 'background:var(--warning-bg);color:var(--warning);font-weight:700;padding:2px 8px;border-radius:999px;font-size:11px;';
        badge.textContent = 'Login Pending';
        emailWrap.appendChild(badge);

        if (tab.tabId || tab.windowId) {
          const idLabel = document.createElement('span');
          idLabel.style.cssText = 'font-size:10.5px;color:var(--text-muted);font-weight:600;margin-left:2px;';
          idLabel.textContent = tab.windowId ? `[Win ${tab.windowId} · Tab ${tab.tabId}]` : `[Tab ${tab.tabId}]`;
          emailWrap.appendChild(idLabel);
        }
        tdEmail.appendChild(emailWrap);
        tdEmail.title = `${tab.provider || 'Provider'} (Window: ${tab.windowId || 'default'}, Tab: ${tab.tabId}) - Login Pending`;
      } else {
        const emText = document.createElement('span');
        emText.textContent = tab.email || '(No Email)';
        emailWrap.appendChild(emText);
        tdEmail.appendChild(emailWrap);
        tdEmail.title = tab.email || '';
      }

      const tdTab = document.createElement('td');
      tdTab.className = 'col-tab';
      tdTab.textContent = tab.tabName || (tab.windowId ? `Win ${tab.windowId} · Tab ${tab.tabId}` : `Tab ${tab.tabId}`);
      tdTab.title = `Window: ${tab.windowId || 'default'} | Tab ID: ${tab.tabId}`;

      const tdInbox = document.createElement('td');
      tdInbox.className = 'col-inbox';
      tdInbox.textContent = isPending ? '—' : String(tab.inbox ?? 0);

      const tdDraft = document.createElement('td');
      tdDraft.className = 'col-draft';
      tdDraft.textContent = isPending ? '—' : String(tab.draft ?? 0);

      const tdFolders = document.createElement('td');
      tdFolders.className = 'col-folders';
      const foldPill = document.createElement('span');
      foldPill.className = 'folders-pill';
      if (isPending) {
        foldPill.textContent = '—';
        foldPill.title = 'Awaiting login';
      } else {
        foldPill.textContent = `S ${tab.sent ?? 0}`;
        foldPill.title = `Inbox: ${tab.inbox || 0} | Sent: ${tab.sent || 0} | Draft: ${tab.draft || 0} | Spam: ${tab.spam || 0}`;
      }
      tdFolders.appendChild(foldPill);

      const tdStatus = document.createElement('td');
      tdStatus.className = 'col-status';
      const sp = document.createElement('span');
      const stLower = String(tab.status || 'Idle').toLowerCase();
      let stCls = 'status-pill--idle';
      if (tab.isBlocked || stLower.includes('error') || stLower.includes('block')) {
        stCls = 'status-pill--error';
      } else if (isPending) {
        stCls = 'status-pill--pending';
      } else if (stLower.includes('send') || stLower.includes('queue')) {
        stCls = 'status-pill--working';
      }
      sp.className = `status-pill ${stCls}`;
      if (isPending) {
        sp.style.cssText = 'background:var(--warning-bg);color:var(--warning);';
        sp.textContent = tab.status === 'login_pending' ? 'Login Pending' : (tab.status || 'Login Pending');
      } else {
        sp.textContent = tab.status || 'Idle';
      }
      tdStatus.appendChild(sp);

      const tdIp = document.createElement('td');
      tdIp.className = 'col-ip';
      const ipWrap = document.createElement('div');
      ipWrap.className = 'ip-cell';
      const ipLink = document.createElement('a');
      ipLink.className = 'ip-link';
      ipLink.href = `https://mxtoolbox.com/SuperTool.aspx?action=blacklist%3a${encodeURIComponent(tab.ip || '127.0.0.1')}`;
      ipLink.target = '_blank';
      ipLink.rel = 'noopener';
      ipLink.title = 'MXToolbox — 100+ blacklists';
      ipLink.textContent = tab.ip || 'Direct';
      ipWrap.appendChild(ipLink);
      if (tab.proxyInfo) {
        const pt = document.createElement('span');
        pt.className = 'proxy-tag';
        pt.textContent = tab.proxyInfo.protocol;
        pt.title = tab.proxyInfo.display;
        ipWrap.appendChild(pt);
      }
      tdIp.appendChild(ipWrap);

      const tdActions = document.createElement('td');
      tdActions.className = 'col-actions';
      const act = document.createElement('div');
      act.className = 'row-actions';

      const pinBtn = makeRowBtn(tab.pinned ? '★' : '☆', 'Pin row', async () => {
        const r = await C.relayAction('pinTab', { key: tab.key });
        state.onlineTabs = r.onlineTabs || [];
        renderTabsTable();
      });
      const fldBtn = makeRowBtn('📁', 'Fetch folder counts', async () => {
        await C.relayAction('getFolders', { accountId: tab.accountId, tabId: tab.tabId });
        C.showToast('Folders', `Requested folder counts for ${tab.email}`);
      });
      const rldBtn = makeRowBtn('↻', 'Reload tab', async () => {
        const res = await C.relayAction('reloadTab', {
          accountId: tab.accountId,
          tabId: tab.tabId,
          key: tab.key,
          email: tab.email
        });
        if (res?.reopened) {
          C.showToast('Browser Reopening', `Re-opening browser window for ${tab.email} and attempting shoot`);
        } else {
          C.showToast('Reloading', `Reloading tab for ${tab.email}`);
        }
      });
      const clsBtn = makeRowBtn('✕', 'Close tab', async () => {
        const r = await C.relayAction('closeTab', { key: tab.key, accountId: tab.accountId, tabId: tab.tabId });
        state.onlineTabs = r.onlineTabs || [];
        renderTabsTable();
      });

      act.append(pinBtn, fldBtn, rldBtn, clsBtn);
      tdActions.appendChild(act);

      tr.append(tdNum, tdData, tdEmail, tdTab, tdInbox, tdDraft, tdFolders, tdStatus, tdIp, tdActions);
      tbody.appendChild(tr);
    }
  }

  function makeRowBtn(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn icon-btn--sm';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderTagsBar() {
    const host = document.getElementById('tagsChipsList');
    const preview = document.getElementById('tagPreviewCard');
    host.textContent = '';

    const customEntries = Object.entries(state.customTags || {}).map(([key, def]) => ({
      key,
      category: 'CUSTOM (' + (def.type || 'seq').toUpperCase() + ')',
      desc: `${(def.values || []).length} values`,
      example: (def.values || [])[0] || '',
      rawDef: def,
      isCustom: true
    }));

    const rangeTag = {
      key: '{1-100}',
      category: 'NUMERIC RANGE',
      desc: 'Random integer between min and max',
      example: '42',
      isCustom: false
    };

    const all = [...customEntries, rangeTag, ...(state.predefinedTags || []).map((t) => ({ ...t, isCustom: false }))];

    for (const t of all) {
      const wrap = document.createElement('span');
      wrap.className = 'tag-chip-wrap';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tag-chip ${t.isCustom ? '_custom' : '_predef'}`;
      btn.textContent = t.key;

      btn.addEventListener('mouseenter', () => {
        document.getElementById('tpcCat').textContent = t.category;
        document.getElementById('tpcKey').textContent = t.key;
        document.getElementById('tpcDesc').textContent = t.desc;
        document.getElementById('tpcEx').textContent = `Example: ${t.example}`;
        const r = btn.getBoundingClientRect();
        preview.style.left = `${Math.min(window.innerWidth - 250, Math.max(8, r.left))}px`;
        preview.style.top = `${Math.max(8, r.top - 108)}px`;
        preview.hidden = false;
      });
      btn.addEventListener('mouseleave', () => { preview.hidden = true; });
      btn.addEventListener('click', () => insertTagAtCompose(t.key));
      wrap.appendChild(btn);

      if (t.isCustom && t.rawDef) {
        const cleanName = t.key.replace(/^\{|\}$/g, '');
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'tag-chip-edit';
        editBtn.textContent = '✎';
        editBtn.title = `Edit ${cleanName}`;
        editBtn.setAttribute('aria-label', `Edit ${cleanName}`);
        editBtn.addEventListener('click', () => {
          document.getElementById('ctpName').value = cleanName;
          document.getElementById('ctpValues').value = (t.rawDef.values || []).join('\n');
          document.getElementById('ctpRandom').checked = t.rawDef.type !== 'sequential';
          const pop = document.getElementById('quickTagPopover');
          const r = editBtn.getBoundingClientRect();
          pop.style.left = `${Math.min(window.innerWidth - 310, Math.max(12, r.left - 80))}px`;
          pop.style.top = `${Math.max(12, r.top - 190)}px`;
          pop.showPopover?.();
        });
        wrap.appendChild(editBtn);
      }

      host.appendChild(wrap);
    }
  }

  function insertTagAtCompose(tagText) {
    if (state.sourceMode) {
      const ta = document.getElementById('composeSource');
      const pos = ta.selectionStart || ta.value.length;
      ta.value = ta.value.slice(0, pos) + tagText + ta.value.slice(pos);
      updateCounts();
      saveComposeDebounced();
      return;
    }
    const ed = document.getElementById('composeEditor');
    ed.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && ed.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const tn = document.createTextNode(tagText);
      range.insertNode(tn);
      range.setStartAfter(tn);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      ed.appendChild(document.createTextNode(tagText));
    }
    updateCounts();
    saveComposeDebounced();
  }

  function renderAccountsTable() {
    const tbody = document.getElementById('accountsTableBody');
    tbody.textContent = '';
    if (!state.accounts || state.accounts.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.padding = '16px';
      td.textContent = 'No saved accounts yet.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const acc of state.accounts) {
      const tr = document.createElement('tr');

      const tdEm = document.createElement('td');
      tdEm.textContent = acc.email;
      tdEm.style.textAlign = 'left';

      const tdProv = document.createElement('td');
      tdProv.textContent = acc.provider;

      const tdProx = document.createElement('td');
      tdProx.textContent = acc.proxyInfo ? acc.proxyInfo.display : 'Direct';

      const tdIp = document.createElement('td');
      tdIp.textContent = acc.outboundIp ? `${acc.outboundIp} (${acc.ipLatencyMs || 0}ms)` : acc.ipStatus;

      const tdCtrl = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';

      if (acc.launched) {
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'btn btn--sm btn--danger';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', async () => {
          const r = await C.apiJson(`/api/accounts/${encodeURIComponent(acc.id)}/stop`, { method: 'POST', body: '{}' });
          state.accounts = r.accounts || [];
          renderAccountsTable();
          await refreshDashboard();
        });
        wrap.appendChild(stopBtn);
      } else {
        const launchBtn = document.createElement('button');
        launchBtn.type = 'button';
        launchBtn.className = 'btn btn--sm btn--success';
        launchBtn.textContent = 'Launch';
        launchBtn.addEventListener('click', async () => {
          C.showToast('Launching', `Starting isolated browser for ${acc.email}...`);
          const r = await C.apiJson(`/api/accounts/${encodeURIComponent(acc.id)}/launch`, {
            method: 'POST',
            body: JSON.stringify({ headless: false })
          });
          state.accounts = r.accounts || [];
          renderAccountsTable();
          await refreshDashboard();
          C.showToast('Launched', `${acc.email} active${r.probe?.ip ? ` via ${r.probe.ip}` : ''}`, 'success');
        });
        wrap.appendChild(launchBtn);
      }

      if (acc.proxy) {
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'btn btn--sm';
        testBtn.textContent = 'Check IP';
        testBtn.addEventListener('click', async () => {
          const r = await C.apiJson(`/api/accounts/${encodeURIComponent(acc.id)}/test-proxy`, { method: 'POST', body: '{}' });
          state.accounts = r.accounts || [];
          renderAccountsTable();
          C.showToast(r.ok ? 'Proxy Verified' : 'Proxy Error', r.probe?.ip || r.probe?.error || 'Done', r.ok ? 'success' : 'error');
        });
        wrap.appendChild(testBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn--sm';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        const r = await C.apiJson(`/api/accounts/${encodeURIComponent(acc.id)}`, { method: 'DELETE' });
        state.accounts = r.accounts || [];
        renderAccountsTable();
      });
      wrap.appendChild(delBtn);

      tdCtrl.appendChild(wrap);
      tr.append(tdEm, tdProv, tdProx, tdIp, tdCtrl);
      tbody.appendChild(tr);
    }
  }

  function renderAttachmentsBar() {
    const chips = document.getElementById('attachChips');
    chips.textContent = '';
    const cfg = state.attachmentConfig || {};
    if (cfg.format && cfg.format !== 'html') {
      const c = document.createElement('span');
      c.className = 'attach-chip';
      c.textContent = `Auto → ${cfg.format.toUpperCase()}`;
      chips.appendChild(c);
    }
    for (const id of cfg.selectedFiles || []) {
      const f = (state.uploadedFiles || []).find((x) => x.id === id);
      if (f) {
        const c = document.createElement('span');
        c.className = 'attach-chip';
        c.textContent = f.originalName;
        chips.appendChild(c);
      }
    }
  }

  function renderAttachModalFiles() {
    const list = document.getElementById('attachFilesList');
    list.textContent = '';
    const selected = new Set(state.attachmentConfig?.selectedFiles || []);
    for (const f of state.uploadedFiles || []) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-alt);cursor:pointer;';
      const left = document.createElement('span');
      left.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:12.5px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(f.id);
      cb.addEventListener('change', async () => {
        if (cb.checked) selected.add(f.id);
        else selected.delete(f.id);
        state.attachmentConfig.selectedFiles = [...selected];
        await C.relayAction('saveAttachmentConfig', { selectedFiles: state.attachmentConfig.selectedFiles });
        renderAttachmentsBar();
      });
      const lbl = document.createElement('span');
      lbl.textContent = `${f.originalName} (${Math.round(f.size / 1024)} KB)`;
      left.append(cb, lbl);
      row.appendChild(left);
      list.appendChild(row);
    }
  }

  function renderTestModalList() {
    const box = document.getElementById('testRecipientsList');
    const cntEl = document.getElementById('testSavedCount');
    if (cntEl) cntEl.textContent = String((state.testRecipients || []).length);
    box.textContent = '';
    for (const em of state.testRecipients || []) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface-alt)';
      const sp = document.createElement('span');
      sp.textContent = em;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--sm btn--danger';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        const r = await C.relayAction('deleteTestData', { email: em });
        state.testRecipients = r.testData || [];
        renderTestModalList();
      });
      row.append(sp, del);
      box.appendChild(row);
    }
  }

  function updateDockEstimate() {
    const el = document.getElementById('dockEstText');
    if (!el) return;
    const perTab = Math.max(1, Number(document.getElementById('recordsPerTabInput')?.value || state.recordsPerTab || 5));
    const activeTabs = (state.onlineTabs || []).filter((t) => t.isActive && !t.isBlocked).length;
    const availData = Number(state.dataCount || 0);
    const totalEst = availData > 0 ? Math.min(availData, activeTabs * perTab) : activeTabs * perTab;
    const avgPerTab = activeTabs > 0 ? Math.floor(totalEst / activeTabs) : perTab;
    el.textContent = `≈ ${avgPerTab}/tab · ${totalEst} total (${activeTabs} tabs)`;
  }

  function updateConvertBarVisibility() {
    const bar = document.getElementById('subBar');
    const sel = document.getElementById('convertFormatSelect');
    if (bar && sel) {
      bar.classList.toggle('is-convert-active', sel.value !== 'html');
    }
  }

  function applySettingsToUi() {
    const s = state.shootSettings || {};
    const q = state.shootQuota || {};
    document.getElementById('gmailDelaySlider').value = String(s.gmail ?? 3);
    document.getElementById('gmailDelayVal').textContent = `${s.gmail ?? 3}s`;
    document.getElementById('yahooDelaySlider').value = String(s.yahoo ?? 5);
    document.getElementById('yahooDelayVal').textContent = `${s.yahoo ?? 5}s`;
    document.getElementById('outlookDelaySlider').value = String(s.outlook ?? 5);
    document.getElementById('outlookDelayVal').textContent = `${s.outlook ?? 5}s`;
    document.getElementById('forceStartCheck').checked = Boolean(s.forceStart);

    const layoutVal = s.layout || 'two-col';
    document.getElementById('relayWorkspace').dataset.layout = layoutVal;
    for (const r of document.querySelectorAll('input[name="layoutMode"]')) {
      r.checked = r.value === layoutVal;
    }

    const sentToday = q.sentToday ?? 0;
    const dailyLimit = q.dailyLimit ?? 60000;
    const metricLimitEl = document.getElementById('metricLimit');
    if (metricLimitEl) metricLimitEl.textContent = String(dailyLimit);
    const metricSentEl = document.getElementById('metricSent');
    if (metricSentEl) metricSentEl.textContent = `${sentToday} / ${dailyLimit}`;
    const metricExpiryEl = document.getElementById('metricExpiry');
    if (metricExpiryEl) metricExpiryEl.textContent = `${q.expiryHours ?? 3} hours left`;

    const sendBtn = document.getElementById('sendButton');
    const limitReached = !s.forceStart && (q.sentToday >= q.dailyLimit);
    sendBtn.classList.toggle('is-limit-reached', limitReached);
    document.getElementById('abortShootBtn').hidden = !state.shootState?.active;
  }

  let saveComposeTimer = null;
  function saveComposeDebounced() {
    clearTimeout(saveComposeTimer);
    saveComposeTimer = setTimeout(async () => {
      const subject = document.getElementById('composeSubject').value;
      const body = state.sourceMode
        ? document.getElementById('composeSource').value
        : document.getElementById('composeEditor').innerHTML;
      await C.relayAction('saveCompose', { subject, body });
    }, 350);
  }

  async function refreshDashboard() {
    try {
      const extResp = await (C.queryExtensionTabs ? C.queryExtensionTabs(1000) : C.pingExtension?.(1000));
      if (extResp) {
        applyExtensionTabs(extResp);
      }
    } catch {}

    const snap = await C.relayAction('getDashboard');
    const incomingTabs = snap.onlineTabs || [];
    if (incomingTabs.length > 0 || !state.onlineTabs || state.onlineTabs.length === 0) {
      state = { ...state, ...snap };
    } else {
      state = { ...state, ...snap, onlineTabs: state.onlineTabs };
    }

    if (!state.onlineTabs || state.onlineTabs.length === 0) {
      try {
        const fallbackTabs = await C.getTabsViaApi();
        if (Array.isArray(fallbackTabs) && fallbackTabs.length > 0) {
          state.onlineTabs = fallbackTabs;
        }
      } catch {}
    }

    document.getElementById('userNameLabel').textContent = snap.user?.username || 'admin';
    document.getElementById('userAvatar').textContent = (snap.user?.username || 'A')[0].toUpperCase();
    document.getElementById('dockDataCount').textContent = String(snap.dataCount || 0);
    document.getElementById('modalDataCount').textContent = String(snap.dataCount || 0);
    document.getElementById('loadedData').value = (snap.dataPreview || []).join('\n');
    document.getElementById('recordsPerTabInput').value = String(snap.recordsPerTab || 5);

    const subjEl = document.getElementById('composeSubject');
    if (document.activeElement !== subjEl) subjEl.value = snap.compose?.subject || '';
    const edEl = document.getElementById('composeEditor');
    if (document.activeElement !== edEl && !state.sourceMode) {
      edEl.innerHTML = snap.compose?.body || '';
    }

    document.getElementById('convertFormatSelect').value = snap.attachmentConfig?.format || 'html';
    document.getElementById('convertFilename').value = snap.attachmentConfig?.filename || '';
    document.getElementById('convertWatermark').value = snap.attachmentConfig?.watermark || '';
    updateConvertBarVisibility();

    renderTabsTable();
    renderTagsBar();
    renderAttachmentsBar();
    applySettingsToUi();
    updateDockEstimate();
    updateCounts();
  }

  let tabPingTimer = null;
  function startTabPingPolling() {
    if (tabPingTimer) clearInterval(tabPingTimer);
    tabPingTimer = setInterval(async () => {
      // 1. Direct extension detection / ping if chrome.runtime.sendMessage is available
      try {
        const extResp = await (C.queryExtensionTabs ? C.queryExtensionTabs(1200) : C.pingExtension?.(1200));
        if (extResp) {
          await applyExtensionTabs(extResp);
        }
      } catch {}

      // 2. WebSocket PING_TABS
      if (dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
        dashboardWs.send(JSON.stringify({ type: 'PING_TABS' }));
      }

      // 3. Fallback to GET /api/tabs & refreshTabs
      try {
        const tabs = await C.getTabsViaApi();
        if (Array.isArray(tabs) && tabs.length > 0) {
          state.onlineTabs = tabs;
          renderTabsTable();
          updateDockEstimate();
        }
      } catch {}
    }, 2500);
  }

  function connectDashboardWs() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws/dashboard`;
    dashboardWs = new WebSocket(url);
    dashboardWs.addEventListener('open', () => {
      try {
        dashboardWs.send(JSON.stringify({ type: 'PING_TABS' }));
      } catch {}
      startTabPingPolling();
    });
    dashboardWs.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        const tabs = msg.onlineTabs || msg.tabs;
        if (tabs) {
          state.onlineTabs = tabs;
          if (typeof msg.totalBrowserTabs === 'number') {
            state.totalOpenTabs = msg.totalBrowserTabs;
          } else if (typeof msg.total === 'number') {
            state.totalOpenTabs = msg.total;
          }
          renderTabsTable();
          updateDockEstimate();
        }
        if (msg.customTags) {
          state.customTags = msg.customTags;
          renderTagsBar();
        }
        if (typeof msg.total === 'number' && msg.type === 'DATA_UPDATED') {
          state.dataCount = msg.total;
          document.getElementById('dockDataCount').textContent = String(msg.total);
          updateDockEstimate();
        }
        if (msg.shootQuota) {
          state.shootQuota = msg.shootQuota;
        }
        if (msg.shootState || msg.shootQuota) {
          if (msg.shootState) state.shootState = msg.shootState;
          applySettingsToUi();
          renderTabsTable();
        }
        if (msg.type === 'VERIFICATION_STATUS' && msg.event) {
          C.showToast('Account Alert', `${msg.event.email || 'Account'}: ${msg.event.statusText || 'Action needed'}`, 'warning');
        }
      } catch {}
    });
    dashboardWs.addEventListener('close', () => {
      setTimeout(connectDashboardWs, 3000);
    });
  }

  function wireEvents() {
    C.initThemeToggle();
    C.wireGmassPopovers();
    C.wireChatDrawer();
    C.wireDownloadExtensionModal();

    // Wire native dialogs
    const dataDialog = document.getElementById('dataDialog');
    const testDialog = document.getElementById('testDialog');
    const accountsDialog = document.getElementById('accountsDialog');
    const aiDialog = document.getElementById('aiDialog');
    const attachDialog = document.getElementById('attachDialog');
    const gmassModal = document.getElementById('gmassModal');

    C.wireDialog(dataDialog, document.getElementById('dataDialogClose'));
    C.wireDialog(testDialog, document.getElementById('testDialogClose'));
    C.wireDialog(accountsDialog, document.getElementById('accountsDialogClose'));
    C.wireDialog(aiDialog, document.getElementById('aiDialogClose'));
    C.wireDialog(attachDialog, document.getElementById('attachDialogClose'));
    C.wireDialog(gmassModal, document.getElementById('gmassModalClose'));

    // Panel collapses
    for (const btn of document.querySelectorAll('.panel-collapse-btn')) {
      btn.addEventListener('click', () => {
        const panel = document.getElementById(btn.dataset.target);
        const collapsed = panel.classList.toggle('is-collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // Search & filter chips
    document.getElementById('tabSearchInput').addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderTabsTable();
    });

    for (const chip of document.querySelectorAll('.filter-chip')) {
      chip.addEventListener('click', () => {
        const key = chip.dataset.filter;
        if (state.activeFilters.has(key)) {
          state.activeFilters.delete(key);
          chip.classList.remove('is-active');
        } else {
          state.activeFilters.add(key);
          chip.classList.add('is-active');
        }
        renderTabsTable();
      });
    }

    // Columns visibility
    const tabsTable = document.getElementById('onlineTabsTable');
    for (const cb of document.querySelectorAll('#columnsPopover input[data-col]')) {
      cb.addEventListener('change', () => {
        tabsTable.classList.toggle(`col-hidden--${cb.dataset.col}`, !cb.checked);
      });
    }

    const confirmDialog = document.getElementById('confirmDialog');
    const linkDialog = document.getElementById('linkDialog');
    C.wireDialog(confirmDialog, document.getElementById('confirmDialogClose'));
    C.wireDialog(linkDialog, document.getElementById('linkDialogClose'));

    function showConfirmModal(title, message, yesLabel = 'Yes', noLabel = 'No') {
      return new Promise((resolve) => {
        document.getElementById('confirmDialogTitle').textContent = title;
        document.getElementById('confirmDialogMsg').textContent = message;
        document.getElementById('confirmYesBtn').textContent = yesLabel;
        document.getElementById('confirmNoBtn').textContent = noLabel;
        confirmDialog.returnValue = '';
        const onClose = () => {
          const accepted = confirmDialog.returnValue === 'yes';
          confirmDialog.returnValue = '';
          resolve(accepted);
        };
        confirmDialog.addEventListener('close', onClose, { once: true });
        confirmDialog.showModal();
      });
    }

    // Tabs toolbar actions
    async function performActiveTabScan() {
      // 1. Direct extension communication via postMessage and chrome.runtime.sendMessage
      try {
        const extResp = await (C.queryExtensionTabs ? C.queryExtensionTabs(1500) : C.pingExtension?.(1500));
        if (extResp) {
          await applyExtensionTabs(extResp);
        }
      } catch {}

      // 2. WebSocket PING_TABS
      if (dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
        dashboardWs.send(JSON.stringify({ type: 'PING_TABS' }));
      }

      // 3. Fallback to GET /api/tabs and relayAction('refreshTabs')
      try {
        const tabs = await C.getTabsViaApi();
        if (Array.isArray(tabs) && tabs.length > 0) {
          state.onlineTabs = tabs;
          renderTabsTable();
          updateDockEstimate();
        }
      } catch {}
      await refreshDashboard();
      C.showToast('Tabs Refreshed', `Active scan completed · ${state.onlineTabs?.length || 0} tabs online`);
    }

    const refreshAllBtn = document.getElementById('refreshAllBtn');
    if (refreshAllBtn) {
      refreshAllBtn.addEventListener('click', performActiveTabScan);
    }
    const refreshTabsBtn = document.getElementById('refreshTabsBtn');
    if (refreshTabsBtn && refreshTabsBtn !== refreshAllBtn) {
      refreshTabsBtn.addEventListener('click', performActiveTabScan);
    }
    const refreshAllTabsBtn = document.getElementById('refreshAllTabsBtn');
    if (refreshAllTabsBtn && refreshAllTabsBtn !== refreshAllBtn) {
      refreshAllTabsBtn.addEventListener('click', performActiveTabScan);
    }
    document.getElementById('getFoldersAllBtn')?.addEventListener('click', async () => {
      await C.relayAction('getFolders', {});
      C.showToast('Folders', 'Requested folder counts across all online tabs');
    });

    async function handleReloadTabs() {
      const ok = await showConfirmModal('Confirm Reload', 'RELOAD ALL OPENED TABS?');
      if (!ok) return;
      try {
        if (window.chrome?.runtime?.sendMessage) {
          const knownId = window.RELAY_EXTENSION_ID || localStorage.getItem('relay_extension_id');
          if (knownId) {
            window.chrome.runtime.sendMessage(knownId, { action: 'RELOAD_ALL_TABS' }, () => {});
          }
        }
        window.postMessage({ action: 'RELOAD_ALL_TABS' }, '*');
      } catch {}
      const res = await C.relayAction('reloadAll', {});
      if (res?.reopenedCount > 0) {
        C.showToast('Reloading', `Re-opened ${res.reopenedCount} offline browser window(s) and queued shoot`);
      } else {
        C.showToast('Reloading', 'Reload command broadcast to all online mail tabs');
      }
    }

    const reloadTabsBtn = document.getElementById('reloadTabsBtn');
    if (reloadTabsBtn) {
      reloadTabsBtn.addEventListener('click', handleReloadTabs);
    }
    const reloadAllTabsBtn = document.getElementById('reloadAllTabsBtn');
    if (reloadAllTabsBtn && reloadAllTabsBtn !== reloadTabsBtn) {
      reloadAllTabsBtn.addEventListener('click', handleReloadTabs);
    }
    document.getElementById('closeAllTabsBtn').addEventListener('click', async () => {
      await C.relayAction('closeAll', {});
      await refreshDashboard();
    });

    // Data modal & Set Data
    document.getElementById('openDataModalBtn').addEventListener('click', async () => {
      const r = await C.relayAction('getData');
      document.getElementById('modalDataCount').textContent = String(r.total || 0);
      document.getElementById('loadedData').value = (r.data || []).join('\n');
      dataDialog.showModal();
    });
    document.getElementById('saveDataBtn').addEventListener('click', async () => {
      const raw = document.getElementById('addData').value;
      const r = await C.relayAction('addData', { data: raw });
      state.dataCount = r.total || 0;
      document.getElementById('addData').value = '';
      document.getElementById('dockDataCount').textContent = String(state.dataCount);
      document.getElementById('modalDataCount').textContent = String(state.dataCount);
      document.getElementById('loadedData').value = (r.data || []).join('\n');
      updateDockEstimate();
      C.showToast('Data Loaded', `Added ${r.added} new records (Total: ${r.total})`, 'success');
    });
    document.getElementById('eraseDataBtn').addEventListener('click', async () => {
      await C.relayAction('deleteData');
      state.dataCount = 0;
      document.getElementById('dockDataCount').textContent = '0';
      document.getElementById('modalDataCount').textContent = '0';
      document.getElementById('loadedData').value = '';
      updateDockEstimate();
      C.showToast('Data Cleared', 'All server recipient data erased', 'warning');
    });
    document.getElementById('recordsPerTabInput').addEventListener('input', updateDockEstimate);
    document.getElementById('setDataBtn').addEventListener('click', async () => {
      const perTab = Number(document.getElementById('recordsPerTabInput').value || 5);
      const r = await C.relayAction('allocateData', { recordsPerTab: perTab });
      state.onlineTabs = r.onlineTabs || [];
      renderTabsTable();
      updateDockEstimate();
      C.showToast('Data Allocated', `Assigned to ${r.allocations?.length || 0} active tab(s). Remaining: ${r.remaining}`, 'success');
    });

    // Accounts & Proxies modal
    document.getElementById('manageAccountsBtn').addEventListener('click', async () => {
      const r = await C.apiJson('/api/accounts');
      state.accounts = r.accounts || [];
      renderAccountsTable();
      accountsDialog.showModal();
    });
    document.getElementById('probeProxyBtn').addEventListener('click', async () => {
      const proxy = document.getElementById('accProxyInput').value.trim();
      const box = document.getElementById('proxyProbeResult');
      box.textContent = 'Testing proxy...';
      try {
        const r = await C.apiJson('/api/proxies/test', { method: 'POST', body: JSON.stringify({ proxy }) });
        box.textContent = r.ok ? `OK · IP: ${r.probe.ip} (${r.probe.latencyMs}ms)` : `Error: ${r.probe?.error || r.error}`;
      } catch (e) {
        box.textContent = `Error: ${e.message}`;
      }
    });
    document.getElementById('saveAccountBtn').addEventListener('click', async () => {
      const payload = {
        email: document.getElementById('accEmailInput').value.trim(),
        password: document.getElementById('accPassInput').value,
        recovery: document.getElementById('accRecoveryInput').value.trim(),
        twoFa: document.getElementById('accTwoFaInput').value.trim(),
        provider: document.getElementById('accProviderSelect').value,
        proxy: document.getElementById('accProxyInput').value.trim()
      };
      const r = await C.apiJson('/api/accounts', { method: 'POST', body: JSON.stringify(payload) });
      state.accounts = r.accounts || [];
      renderAccountsTable();
      C.showToast('Account Saved', payload.email, 'success');
    });
    document.getElementById('importBulkBtn').addEventListener('click', async () => {
      const r = await C.apiJson('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({
          bulk: document.getElementById('bulkAccountsInput').value,
          defaultProxy: document.getElementById('bulkDefaultProxyInput').value.trim()
        })
      });
      state.accounts = r.accounts || [];
      renderAccountsTable();
      C.showToast('Imported', `Imported ${r.count} account(s)`, 'success');
    });

    // Test Shoot modal & Fire
    document.getElementById('openTestModalBtn').addEventListener('click', async () => {
      const r = await C.relayAction('getTestData');
      state.testRecipients = r.testData || [];
      renderTestModalList();
      testDialog.showModal();
    });
    document.getElementById('addTestRecipientBtn').addEventListener('click', async () => {
      const raw = document.getElementById('newTestEmails').value.trim();
      if (!raw) return;
      const r = await C.relayAction('addTestData', { emails: raw });
      document.getElementById('newTestEmails').value = '';
      state.testRecipients = r.testData || [];
      renderTestModalList();
    });
    async function runTestShoot() {
      const subject = document.getElementById('composeSubject').value;
      const body = state.sourceMode
        ? document.getElementById('composeSource').value
        : document.getElementById('composeEditor').innerHTML;
      const r = await C.relayAction('testShoot', { subject, body });
      if (!r.ok) {
        C.showToast('Test Shoot Failed', r.error, 'error');
        setStatusAlert(r.error);
      } else {
        C.showToast('Test Shoot Dispatched', `Queued ${r.queuedTasks} test email(s)`, 'success');
      }
    }
    document.getElementById('fireTestShootBtn').addEventListener('click', runTestShoot);
    document.getElementById('fireTestFromModalBtn').addEventListener('click', () => {
      testDialog.close();
      runTestShoot();
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        runTestShoot();
      }
    });

    // Compose Editor & Source Toggle
    document.getElementById('composeSubject').addEventListener('input', saveComposeDebounced);
    document.getElementById('composeEditor').addEventListener('input', () => {
      updateCounts();
      saveComposeDebounced();
    });
    document.getElementById('composeSource').addEventListener('input', () => {
      updateCounts();
      saveComposeDebounced();
    });
    for (const tool of document.querySelectorAll('.ed-tool[data-cmd]')) {
      tool.addEventListener('click', () => {
        document.getElementById('composeEditor').focus();
        document.execCommand(tool.dataset.cmd, false);
        updateCounts();
        saveComposeDebounced();
      });
    }
    let savedRange = null;
    document.getElementById('insertLinkBtn').addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange();
      document.getElementById('linkUrlInput').value = 'https://';
      linkDialog.showModal();
    });
    document.getElementById('linkCancelBtn').addEventListener('click', () => {
      linkDialog.returnValue = '';
      linkDialog.close();
    });
    document.getElementById('linkDialogForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = document.getElementById('linkUrlInput').value.trim();
      linkDialog.close();
      if (!url) return;
      const ed = document.getElementById('composeEditor');
      ed.focus();
      if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
      document.execCommand('createLink', false, url);
      updateCounts();
      saveComposeDebounced();
    });
    document.getElementById('toggleSourceBtn').addEventListener('click', (e) => {
      const ed = document.getElementById('composeEditor');
      const src = document.getElementById('composeSource');
      state.sourceMode = !state.sourceMode;
      e.currentTarget.setAttribute('aria-pressed', String(state.sourceMode));
      if (state.sourceMode) {
        src.value = ed.innerHTML;
        ed.hidden = true;
        src.hidden = false;
      } else {
        ed.innerHTML = src.value;
        src.hidden = true;
        ed.hidden = false;
      }
      updateCounts();
    });

    // Quick custom tag creation
    document.getElementById('composeTagsPopoverForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('ctpName').value;
      const values = document.getElementById('ctpValues').value;
      const type = document.getElementById('ctpRandom').checked ? 'random' : 'sequential';
      const r = await C.apiJson('/V3/tags/tags.php', {
        method: 'POST',
        body: JSON.stringify({ name, values, type })
      });
      state.customTags = r.tags || {};
      renderTagsBar();
      document.getElementById('quickTagPopover').hidePopover?.();
      e.target.reset();
      C.showToast('Tag Saved', `Saved {${name.trim()}}`, 'success');
    });

    function sanitizeHtml(htmlStr) {
      const doc = new DOMParser().parseFromString(String(htmlStr || ''), 'text/html');
      for (const bad of doc.querySelectorAll('script, iframe, object, embed')) bad.remove();
      for (const el of doc.querySelectorAll('*')) {
        for (const attr of [...el.attributes]) {
          if (/^on/i.test(attr.name) || (/^href|src$/i.test(attr.name) && /^javascript:/i.test(attr.value.trim()))) {
            el.removeAttribute(attr.name);
          }
        }
      }
      return doc.body.innerHTML;
    }

    // AI Assistant
    document.getElementById('aiAssistantBtn').addEventListener('click', () => aiDialog.showModal());
    document.getElementById('generateAiBtn').addEventListener('click', async () => {
      const prompt = document.getElementById('aiPromptInput').value;
      const r = await C.apiJson('/V3/controller/ai/aiPromptsApi.php', {
        method: 'POST',
        body: JSON.stringify({ prompt })
      });
      const safeHtml = sanitizeHtml(r.html || r.text || '');
      lastGeneratedAi = { ...r, html: safeHtml };
      document.getElementById('aiGeneratedSubj').textContent = r.subject || '';
      document.getElementById('aiGeneratedHtml').innerHTML = safeHtml;
      document.getElementById('aiPreviewBox').hidden = false;
    });
    document.getElementById('applyAiBtn').addEventListener('click', () => {
      if (!lastGeneratedAi) return;
      if (lastGeneratedAi.subject) document.getElementById('composeSubject').value = lastGeneratedAi.subject;
      if (lastGeneratedAi.html) {
        document.getElementById('composeEditor').innerHTML = lastGeneratedAi.html;
        document.getElementById('composeSource').value = lastGeneratedAi.html;
      }
      updateCounts();
      saveComposeDebounced();
      aiDialog.close();
      C.showToast('Applied', 'AI template inserted into Compose', 'success');
    });

    // Attachment conversion & files
    document.getElementById('convertFormatSelect').addEventListener('change', updateConvertBarVisibility);
    document.getElementById('saveConvertBtn').addEventListener('click', async () => {
      const cfg = {
        format: document.getElementById('convertFormatSelect').value,
        filename: document.getElementById('convertFilename').value,
        watermark: document.getElementById('convertWatermark').value
      };
      const r = await C.relayAction('saveAttachmentConfig', cfg);
      state.attachmentConfig = r.config;
      renderAttachmentsBar();
      C.showToast('Saved', `Attachment mode: ${cfg.format.toUpperCase()}`, 'success');
    });
    document.getElementById('clearConvertBtn').addEventListener('click', async () => {
      document.getElementById('convertFormatSelect').value = 'html';
      document.getElementById('convertFilename').value = '';
      document.getElementById('convertWatermark').value = '';
      updateConvertBarVisibility();
      const r = await C.relayAction('saveAttachmentConfig', { format: 'html', filename: '', watermark: '', selectedFiles: [] });
      state.attachmentConfig = r.config;
      renderAttachmentsBar();
    });
    document.getElementById('previewConvertBtn').addEventListener('click', async () => {
      const fmt = document.getElementById('convertFormatSelect').value;
      const format = fmt === 'html' ? 'pdf' : fmt;
      const html = document.getElementById('composeEditor').innerHTML || '<h1>Preview Document</h1><p>Generated locally via Playwright.</p>';
      C.showToast('Converting...', `Rendering ${format.toUpperCase()} locally...`);
      const r = await C.apiJson('/api/convert', {
        method: 'POST',
        body: JSON.stringify({
          html,
          format,
          filename: document.getElementById('convertFilename').value || 'preview',
          watermark: document.getElementById('convertWatermark').value
        })
      });
      if (r.ok) {
        C.showToast('Converted', `${r.filename} (${Math.round(r.size / 1024)} KB)`, 'success');
      } else {
        C.showToast('Convert Error', r.error, 'error');
      }
    });
    document.getElementById('attachFilesBtn').addEventListener('click', () => {
      renderAttachModalFiles();
      attachDialog.showModal();
    });
    document.getElementById('uploadFileBtn').addEventListener('click', async () => {
      const input = document.getElementById('fileUploadInput');
      const file = input.files?.[0];
      if (!file) return;
      const b64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(String(reader.result).split(',')[1] || '');
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      const r = await C.apiJson('/api/files/upload', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, mimeType: file.type, base64: b64 })
      });
      state.uploadedFiles = r.files || [];
      renderAttachModalFiles();
      input.value = '';
      C.showToast('Uploaded', file.name, 'success');
    });

    // Shoot Settings Popover
    async function persistShootSettings() {
      const layoutEl = document.querySelector('input[name="layoutMode"]:checked');
      const payload = {
        gmail: Number(document.getElementById('gmailDelaySlider').value),
        yahoo: Number(document.getElementById('yahooDelaySlider').value),
        outlook: Number(document.getElementById('outlookDelaySlider').value),
        layout: layoutEl ? layoutEl.value : 'two-col',
        forceStart: document.getElementById('forceStartCheck').checked
      };
      state.shootSettings = payload;
      applySettingsToUi();
      await C.relayAction('saveShootSettings', payload);
    }
    for (const id of ['gmailDelaySlider', 'yahooDelaySlider', 'outlookDelaySlider', 'forceStartCheck']) {
      document.getElementById(id).addEventListener('change', persistShootSettings);
      document.getElementById(id).addEventListener('input', () => {
        document.getElementById('gmailDelayVal').textContent = document.getElementById('gmailDelaySlider').value + 's';
        document.getElementById('yahooDelayVal').textContent = document.getElementById('yahooDelaySlider').value + 's';
        document.getElementById('outlookDelayVal').textContent = document.getElementById('outlookDelaySlider').value + 's';
      });
    }
    for (const r of document.querySelectorAll('input[name="layoutMode"]')) {
      r.addEventListener('change', persistShootSettings);
    }

    // Main SHOOT & ABORT buttons
    document.getElementById('sendButton').addEventListener('click', async () => {
      const activeTabs = (state.onlineTabs || []).filter((t) => t.isActive && (!t.isBlocked || state.shootSettings?.forceStart));
      const unalloc = activeTabs.filter((t) => !String(t.dataAllocated || '').trim());
      const hasAlloc = activeTabs.some((t) => String(t.dataAllocated || '').trim());
      if (unalloc.length > 0 && hasAlloc) {
        const names = unalloc.map((t) => `${t.tabName || t.email || 'Tab'} (${t.email || '—'})`).slice(0, 3).join(', ');
        const proceed = await showConfirmModal(
          'Confirm Shoot',
          `${unalloc.length} tab(s) have no data loaded: ${names} — start anyway?`
        );
        if (!proceed) return;
      }

      const btn = document.getElementById('sendButton');
      btn.classList.remove('finished');
      btn.classList.add('active');
      const subject = document.getElementById('composeSubject').value;
      const body = state.sourceMode
        ? document.getElementById('composeSource').value
        : document.getElementById('composeEditor').innerHTML;

      const r = await C.relayAction('shoot', { subject, body, confirmAnyway: true });
      if (!r.ok) {
        btn.classList.remove('active');
        C.showToast('Shoot Blocked', r.error, 'error');
        setStatusAlert(r.error);
        return;
      }

      // Duplicate Tabs warning toast stack alongside Shooting Started toast
      const emailCounts = new Map();
      for (const t of activeTabs) {
        const em = String(t.email || '').trim().toLowerCase();
        if (em) emailCounts.set(em, (emailCounts.get(em) || 0) + 1);
      }
      for (const [em, count] of emailCounts.entries()) {
        if (count > 1) {
          C.showToast('Duplicate Tabs Found', `${em} is open in ${count} tabs.`, 'warning');
        }
      }

      setTimeout(() => {
        btn.classList.remove('active');
        btn.classList.add('finished');
        setTimeout(() => btn.classList.remove('finished'), 2200);
      }, 900);

      C.showToast('SHOOT', `Shooting Started! (${r.queuedTasks} queued)`, 'success');
      await refreshDashboard();
    });

    document.getElementById('abortShootBtn').addEventListener('click', async () => {
      await C.relayAction('abortShoot');
      C.showToast('Aborted', 'Active shoot cancelled across connected tabs', 'warning');
      await refreshDashboard();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    wireEvents();
    try {
      const extResp = await (C.queryExtensionTabs ? C.queryExtensionTabs(800) : C.pingExtension?.(800));
      if (extResp) {
        applyExtensionTabs(extResp);
      }
    } catch {}
    await refreshDashboard();
    connectDashboardWs();
  });
})();
