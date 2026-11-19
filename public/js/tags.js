(function () {
  'use strict';

  const C = window.RelayCommon;
  let customTags = {};
  let predefinedTags = [];
  let query = '';
  let selectedCategory = 'ALL';

  // Cycle detection for custom tags
  function findCycles(tags) {
    const adj = {};
    for (const [key, def] of Object.entries(tags)) {
      const outgoing = new Set();
      const vals = Array.isArray(def.values) ? def.values : [];
      for (const v of vals) {
        const matches = String(v).match(/\{[^{}]+\}/g);
        if (matches) {
          for (const m of matches) {
            if (m in tags) outgoing.add(m);
          }
        }
      }
      adj[key] = [...outgoing];
    }

    const visited = new Set();
    const stack = [];
    let cycleFound = null;

    function dfs(node) {
      if (cycleFound) return;
      const stackIdx = stack.indexOf(node);
      if (stackIdx !== -1) {
        cycleFound = [...stack.slice(stackIdx), node];
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      stack.push(node);
      for (const neighbor of (adj[node] || [])) {
        dfs(neighbor);
        if (cycleFound) return;
      }
      stack.pop();
    }

    for (const node of Object.keys(tags)) {
      if (!visited.has(node)) {
        dfs(node);
        if (cycleFound) break;
      }
    }
    return cycleFound;
  }

  function updateCircularAlert() {
    const cycle = findCycles(customTags);
    const alertEl = document.getElementById('circularAlert');
    const msgEl = document.getElementById('circularAlertMsg');
    if (cycle && cycle.length > 0) {
      alertEl.style.display = 'flex';
      const pathStr = cycle.join(' → ');
      msgEl.textContent = `Circular loop detected: ${pathStr}. Recursive tag resolution will loop indefinitely. Please break the cycle.`;
    } else {
      alertEl.style.display = 'none';
      msgEl.textContent = '';
    }
    return cycle;
  }

  // Live spintax & tag resolver for the playground
  function resolveSpintaxText(input) {
    let text = String(input ?? '');
    if (!text.includes('{') || !text.includes('|')) return text;
    let passes = 0;
    const innermostRe = /\{([^{}]*\|[^{}]*)\}/g;
    while (passes < 12 && innermostRe.test(text)) {
      innermostRe.lastIndex = 0;
      text = text.replace(innermostRe, (_, inner) => {
        const options = inner.split('|');
        return options[Math.floor(Math.random() * options.length)];
      });
      passes++;
    }
    return text;
  }

  function evaluatePlayground(text) {
    if (!text || !text.trim()) return '';
    let result = resolveSpintaxText(text);

    // Range tags {min-max}
    result = result.replace(/\{\s*(\d+)\s*-\s*(\d+)\s*\}/g, (_, minStr, maxStr) => {
      let min = parseInt(minStr, 10);
      let max = parseInt(maxStr, 10);
      if (min > max) [min, max] = [max, min];
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    });

    // Custom tags
    const visited = new Set();
    let hasCycle = false;
    let cyclePath = [];

    function resolveCustom(tagKey) {
      if (visited.has(tagKey)) {
        hasCycle = true;
        cyclePath.push(tagKey);
        return `[CIRCULAR: ${tagKey}]`;
      }
      visited.add(tagKey);
      const def = customTags[tagKey];
      if (!def || !def.values || def.values.length === 0) return tagKey;
      let val = def.values[0];
      if (def.type === 'random') {
        val = def.values[Math.floor(Math.random() * def.values.length)];
      }
      val = resolveSpintaxText(val);
      val = val.replace(/\{[^{}]+\}/g, (nested) => {
        if (nested in customTags) return resolveCustom(nested);
        return nested;
      });
      return val;
    }

    for (const key of Object.keys(customTags)) {
      if (result.includes(key)) {
        visited.clear();
        result = result.split(key).join(resolveCustom(key));
      }
    }

    if (hasCycle) {
      const alertEl = document.getElementById('circularAlert');
      const msgEl = document.getElementById('circularAlertMsg');
      alertEl.style.display = 'flex';
      msgEl.textContent = `Circular dependency detected during playground evaluation: ${cyclePath.join(' → ')}`;
    }

    // Predefined catalog tags replacement
    for (const tag of predefinedTags) {
      if (result.includes(tag.key)) {
        result = result.split(tag.key).join(tag.example || tag.key);
      }
    }

    return result;
  }

  function renderCustomTags() {
    const entries = Object.entries(customTags);
    const totalVals = entries.reduce((sum, [, d]) => sum + (d.values || []).length, 0);
    document.getElementById('statTagCount').textContent = String(entries.length);
    document.getElementById('statValueCount').textContent = String(totalVals);

    const grid = document.getElementById('tagsGrid');
    grid.textContent = '';

    const cycle = updateCircularAlert();
    const cycleSet = new Set(cycle || []);

    const q = query.toLowerCase();
    const filtered = entries.filter(([key, def]) => {
      if (!q) return true;
      return key.toLowerCase().includes(q) || (def.values || []).some((v) => v.toLowerCase().includes(q));
    });

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-muted);font-size:13px;grid-column:1/-1;padding:12px;';
      empty.textContent = entries.length === 0 ? 'No custom tags defined yet. Use the form above to add one.' : 'No custom tags match your search.';
      grid.appendChild(empty);
      return;
    }

    for (const [key, def] of filtered) {
      const cleanName = key.replace(/^\{|\}$/g, '');
      const card = document.createElement('article');
      card.className = `tag-card ${cycleSet.has(key) ? 'tag-card--error' : ''}`;

      const head = document.createElement('div');
      head.className = 'tag-card__head';

      const title = document.createElement('span');
      title.className = 'tag-card__name';
      title.textContent = key;

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

      // Type toggle button (cycles Sequential -> Random -> Static -> Sequential)
      const typeBtn = document.createElement('button');
      typeBtn.type = 'button';
      const curType = def.type || 'sequential';
      typeBtn.className = `btn btn--sm ${curType === 'random' ? 'btn--primary' : curType === 'static' ? 'btn--alt' : ''}`;
      typeBtn.textContent = curType[0].toUpperCase() + curType.slice(1);
      typeBtn.title = 'Click to switch type';
      typeBtn.addEventListener('click', async () => {
        const nextMap = { sequential: 'random', random: 'static', static: 'sequential' };
        const nextType = nextMap[curType] || 'sequential';
        const r = await C.apiJson('/V3/tags/tags.php', {
          method: 'POST',
          body: JSON.stringify({ name: cleanName, values: def.values, type: nextType })
        });
        customTags = r.tags || {};
        renderCustomTags();
      });

      // Edit button (opens edit modal)
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn--sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        openEditDialog(key, def);
      });

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn--sm btn--danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        const r = await C.apiJson('/V3/tags/tags.php', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete', name: cleanName })
        });
        customTags = r.tags || {};
        renderCustomTags();
        C.showToast('Deleted', `Removed ${key}`, 'warning');
      });

      actions.append(typeBtn, editBtn, delBtn);
      head.append(title, actions);

      const chips = document.createElement('div');
      chips.className = 'tag-card__chips';
      for (let i = 0; i < (def.values || []).length; i++) {
        const val = def.values[i];
        const chip = document.createElement('span');
        chip.className = 'val-chip';
        chip.textContent = val + ' ';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.setAttribute('aria-label', `Remove value ${val}`);
        rm.textContent = '×';
        rm.addEventListener('click', async () => {
          const remaining = def.values.filter((_, idx) => idx !== i);
          if (remaining.length === 0) {
            C.showToast('Cannot empty', 'A tag requires at least one value; delete the tag instead.', 'warning');
            return;
          }
          const r = await C.apiJson('/V3/tags/tags.php', {
            method: 'POST',
            body: JSON.stringify({ name: cleanName, values: remaining, type: def.type })
          });
          customTags = r.tags || {};
          renderCustomTags();
        });
        chip.appendChild(rm);
        chips.appendChild(chip);
      }

      const addForm = document.createElement('form');
      addForm.style.cssText = 'display:flex;gap:6px;margin-top:auto;';
      const addInput = document.createElement('input');
      addInput.className = 'field-input';
      addInput.type = 'text';
      addInput.placeholder = 'Add value...';
      const addBtn = document.createElement('button');
      addBtn.type = 'submit';
      addBtn.className = 'btn btn--sm btn--primary';
      addBtn.textContent = '+';
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = addInput.value.trim();
        if (!v) return;
        const r = await C.apiJson('/V3/tags/tags.php', {
          method: 'POST',
          body: JSON.stringify({ name: cleanName, values: [...def.values, v], type: def.type })
        });
        customTags = r.tags || {};
        renderCustomTags();
      });
      addForm.append(addInput, addBtn);

      card.append(head, chips, addForm);
      grid.appendChild(card);
    }
  }

  function renderPredefinedCatalog() {
    const grid = document.getElementById('catalogGrid');
    grid.textContent = '';

    const q = query.toLowerCase();
    const filtered = predefinedTags.filter((t) => {
      const matchCat = selectedCategory === 'ALL' || t.category === selectedCategory;
      if (!matchCat) return false;
      if (!q) return true;
      return t.key.toLowerCase().includes(q) || (t.desc || '').toLowerCase().includes(q) || (t.example || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q);
    });

    document.getElementById('catalogCount').textContent = String(predefinedTags.length);
    document.getElementById('statCatalogCount').textContent = String(predefinedTags.length);

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-muted);font-size:13px;grid-column:1/-1;padding:12px;';
      empty.textContent = 'No predefined catalog tags match filter.';
      grid.appendChild(empty);
      return;
    }

    for (const tag of filtered) {
      const card = document.createElement('article');
      card.className = 'predefined-card';
      card.title = `Click to insert ${tag.key} into Spintax playground`;

      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';

      const keyEl = document.createElement('strong');
      keyEl.className = 'tag-card__name';
      keyEl.textContent = tag.key;

      const catEl = document.createElement('span');
      catEl.className = 'category-chip';
      catEl.textContent = tag.category;

      topRow.append(keyEl, catEl);

      const descEl = document.createElement('div');
      descEl.style.cssText = 'font-size:12px;color:var(--text-muted);';
      descEl.textContent = tag.desc || '';

      const exEl = document.createElement('div');
      exEl.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:ui-monospace, monospace;';
      exEl.innerHTML = `Example: <code>${tag.example || ''}</code>`;

      card.append(topRow, descEl, exEl);

      card.addEventListener('click', () => {
        const inp = document.getElementById('spintaxInput');
        if (inp) {
          inp.value = (inp.value ? inp.value + ' ' : '') + tag.key;
          updatePlayground();
          C.showToast('Tag Selected', `Inserted ${tag.key} into playground`, 'info');
        }
      });

      grid.appendChild(card);
    }
  }

  function setupCategoryFilters() {
    const cats = ['ALL', ...new Set(predefinedTags.map((t) => t.category).filter(Boolean))];
    const bar = document.getElementById('categoryFilterBar');
    const sel = document.getElementById('categorySelect');
    bar.textContent = '';
    sel.textContent = '';

    for (const cat of cats) {
      // Pill button
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `category-btn ${cat === selectedCategory ? 'is-active' : ''}`;
      const count = cat === 'ALL' ? predefinedTags.length : predefinedTags.filter((t) => t.category === cat).length;
      btn.textContent = `${cat} (${count})`;
      btn.dataset.category = cat;
      btn.addEventListener('click', () => {
        selectedCategory = cat;
        sel.value = cat;
        [...bar.children].forEach((b) => b.classList.toggle('is-active', b.dataset.category === cat));
        renderPredefinedCatalog();
      });
      bar.appendChild(btn);

      // Select option
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = `${cat} (${count})`;
      sel.appendChild(opt);
    }

    sel.value = selectedCategory;
    sel.addEventListener('change', (e) => {
      selectedCategory = e.target.value;
      [...bar.children].forEach((b) => b.classList.toggle('is-active', b.dataset.category === selectedCategory));
      renderPredefinedCatalog();
    });
  }

  function updatePlayground() {
    const input = document.getElementById('spintaxInput').value;
    const out = evaluatePlayground(input);
    document.getElementById('spintaxOutput').textContent = out;
  }

  function openEditDialog(key, def) {
    const dlg = document.getElementById('editTagDialog');
    document.getElementById('editTagOriginalKey').value = key;
    document.getElementById('editTagName').value = key.replace(/^\{|\}$/g, '');
    document.getElementById('editTagType').value = def.type || 'sequential';
    document.getElementById('editTagValues').value = (def.values || []).join('\n');
    dlg.showModal();
  }

  async function load() {
    const r = await C.apiJson('/V3/tags/tags.php');
    customTags = r.tags || {};
    predefinedTags = r.predefined || [];
    setupCategoryFilters();
    renderCustomTags();
    renderPredefinedCatalog();
    updatePlayground();
  }

  document.addEventListener('DOMContentLoaded', () => {
    C.initThemeToggle();
    load();

    const editDlg = document.getElementById('editTagDialog');
    C.wireDialog(editDlg, document.getElementById('editTagClose'));
    document.getElementById('editTagCancelBtn').addEventListener('click', () => editDlg.close());

    document.getElementById('editTagForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const origKey = document.getElementById('editTagOriginalKey').value;
      const cleanOrig = origKey.replace(/^\{|\}$/g, '');
      const newName = document.getElementById('editTagName').value.trim();
      const newType = document.getElementById('editTagType').value;
      const rawVals = document.getElementById('editTagValues').value;
      const values = rawVals.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);

      if (cleanOrig !== newName) {
        await C.apiJson('/V3/tags/tags.php', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete', name: cleanOrig })
        });
      }

      const r = await C.apiJson('/V3/tags/tags.php', {
        method: 'POST',
        body: JSON.stringify({ name: newName, values, type: newType })
      });
      customTags = r.tags || {};
      renderCustomTags();
      editDlg.close();
      C.showToast('Tag Updated', `Saved {${newName}}`, 'success');
      updatePlayground();
    });

    document.getElementById('tagSearchInput').addEventListener('input', (e) => {
      query = e.target.value;
      renderCustomTags();
      renderPredefinedCatalog();
    });

    const newTagType = document.getElementById('newTagType');
    const newTagRandom = document.getElementById('newTagRandom');
    newTagType.addEventListener('change', () => {
      newTagRandom.checked = (newTagType.value === 'random');
    });
    newTagRandom.addEventListener('change', () => {
      newTagType.value = newTagRandom.checked ? 'random' : 'sequential';
    });

    document.getElementById('createTagForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('newTagName').value.trim();
      const values = document.getElementById('newTagValues').value;
      const type = document.getElementById('newTagType').value || (newTagRandom.checked ? 'random' : 'sequential');

      const r = await C.apiJson('/V3/tags/tags.php', {
        method: 'POST',
        body: JSON.stringify({ name, values, type })
      });
      customTags = r.tags || {};
      renderCustomTags();
      e.target.reset();
      newTagType.value = 'random';
      newTagRandom.checked = true;
      C.showToast('Tag Added', `Saved {${name}} (${type})`, 'success');
      updatePlayground();
    });

    document.getElementById('spintaxInput').addEventListener('input', updatePlayground);
    document.getElementById('testSpintaxBtn').addEventListener('click', () => {
      updatePlayground();
      C.showToast('Evaluated', 'Spintax expression evaluated', 'info');
    });
  });
})();