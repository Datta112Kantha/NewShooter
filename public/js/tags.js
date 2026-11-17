(function () {
  'use strict';

  const C = window.RelayCommon;
  let customTags = {};
  let query = '';

  function render() {
    const entries = Object.entries(customTags);
    const totalVals = entries.reduce((sum, [, d]) => sum + (d.values || []).length, 0);
    document.getElementById('statTagCount').textContent = String(entries.length);
    document.getElementById('statValueCount').textContent = String(totalVals);

    const grid = document.getElementById('tagsGrid');
    grid.textContent = '';

    const q = query.toLowerCase();
    const filtered = entries.filter(([key, def]) => {
      if (!q) return true;
      return key.toLowerCase().includes(q) || (def.values || []).some((v) => v.toLowerCase().includes(q));
    });

    for (const [key, def] of filtered) {
      const cleanName = key.replace(/^\{|\}$/g, '');
      const card = document.createElement('article');
      card.className = 'tag-card';

      const head = document.createElement('div');
      head.className = 'tag-card__head';

      const title = document.createElement('span');
      title.className = 'tag-card__name';
      title.textContent = key;

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;align-items:center;';

      const randBtn = document.createElement('button');
      randBtn.type = 'button';
      randBtn.className = `btn btn--sm ${def.type === 'random' ? 'btn--primary' : ''}`;
      randBtn.textContent = def.type === 'random' ? 'Random' : 'Sequential';
      randBtn.addEventListener('click', async () => {
        const nextType = def.type === 'random' ? 'sequential' : 'random';
        const r = await C.apiJson('/V3/tags/tags.php', {
          method: 'POST',
          body: JSON.stringify({ name: cleanName, values: def.values, type: nextType })
        });
        customTags = r.tags || {};
        render();
      });

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
        render();
        C.showToast('Deleted', `Removed ${key}`, 'warning');
      });

      actions.append(randBtn, delBtn);
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
          render();
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
        render();
      });
      addForm.append(addInput, addBtn);

      card.append(head, chips, addForm);
      grid.appendChild(card);
    }
  }

  async function load() {
    const r = await C.apiJson('/V3/tags/tags.php');
    customTags = r.tags || {};
    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    C.initThemeToggle();
    load();
    document.getElementById('tagSearchInput').addEventListener('input', (e) => {
      query = e.target.value;
      render();
    });
    document.getElementById('createTagForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('newTagName').value;
      const values = document.getElementById('newTagValues').value;
      const type = document.getElementById('newTagRandom').checked ? 'random' : 'sequential';
      const r = await C.apiJson('/V3/tags/tags.php', {
        method: 'POST',
        body: JSON.stringify({ name, values, type })
      });
      customTags = r.tags || {};
      render();
      e.target.reset();
      C.showToast('Tag Added', `Saved {${name.trim()}}`, 'success');
    });
  });
})();
