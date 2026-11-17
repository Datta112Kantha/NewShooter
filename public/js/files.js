(function () {
  'use strict';

  const C = window.RelayCommon;

  async function refreshFiles() {
    const r = await C.apiJson('/api/files');
    const list = document.getElementById('filesList');
    list.textContent = '';
    if (!r.files || r.files.length === 0) {
      const empty = document.createElement('p');
      empty.style.color = 'var(--text-muted)';
      empty.textContent = 'No uploaded files yet.';
      list.appendChild(empty);
      return;
    }
    for (const f of r.files) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-alt);';
      const meta = document.createElement('div');
      meta.textContent = `${f.originalName} (${Math.round(f.size / 1024)} KB · ${f.mimeType})`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--sm btn--danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        await C.apiJson(`/api/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
        refreshFiles();
      });
      row.append(meta, del);
      list.appendChild(row);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    C.initThemeToggle();
    refreshFiles();

    document.getElementById('uploadBtn').addEventListener('click', async () => {
      const f = document.getElementById('fileInput').files?.[0];
      if (!f) return;
      const b64 = await new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result).split(',')[1] || '');
        rd.onerror = rej;
        rd.readAsDataURL(f);
      });
      await C.apiJson('/api/files/upload', {
        method: 'POST',
        body: JSON.stringify({ filename: f.name, mimeType: f.type, base64: b64 })
      });
      document.getElementById('fileInput').value = '';
      refreshFiles();
      C.showToast('Uploaded', f.name, 'success');
    });

    document.getElementById('labConvertBtn').addEventListener('click', async () => {
      const status = document.getElementById('labStatus');
      status.textContent = 'Rendering...';
      const r = await C.apiJson('/api/convert', {
        method: 'POST',
        body: JSON.stringify({
          html: document.getElementById('labHtml').value,
          format: document.getElementById('labFormat').value,
          filename: document.getElementById('labFilename').value,
          watermark: document.getElementById('labWatermark').value
        })
      });
      if (r.ok) {
        status.textContent = `Generated ${r.filename} (${Math.round(r.size / 1024)} KB)`;
        const a = document.createElement('a');
        a.href = `data:${r.mimeType};base64,${r.base64}`;
        a.download = r.filename;
        a.click();
        C.showToast('Converted', r.filename, 'success');
      } else {
        status.textContent = r.error;
      }
    });
  });
})();
