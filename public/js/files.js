(function () {
  'use strict';

  const C = window.RelayCommon;

  async function refreshFiles() {
    const r = await C.apiJson('/api/files');
    const list = document.getElementById('filesList');
    list.textContent = '';
    const files = r.files || [];
    const countEl = document.getElementById('storedFilesCount');
    if (countEl) countEl.textContent = String(files.length);

    if (files.length === 0) {
      const empty = document.createElement('p');
      empty.style.color = 'var(--text-muted)';
      empty.textContent = 'No uploaded files yet.';
      list.appendChild(empty);
      return;
    }

    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'file-item-row';

      const meta = document.createElement('div');
      meta.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      meta.innerHTML = `<strong class="file-name">${f.originalName}</strong> <span style="font-size:12px;color:var(--text-muted)">(${Math.round(f.size / 1024)} KB · ${f.mimeType})</span>`;

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;align-items:center;gap:6px;';

      const dl = document.createElement('a');
      dl.className = 'btn btn--sm file-download-btn';
      dl.href = `/api/files/${encodeURIComponent(f.id)}/download`;
      dl.download = f.originalName;
      dl.textContent = 'Download';

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--sm btn--danger file-delete-btn';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        await C.apiJson(`/api/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
        refreshFiles();
        C.showToast('Deleted', `Removed ${f.originalName}`, 'warning');
      });

      actions.append(dl, del);
      row.append(meta, actions);
      list.appendChild(row);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    C.initThemeToggle();
    refreshFiles();

    document.getElementById('uploadBtn').addEventListener('click', async () => {
      const f = document.getElementById('fileInput').files?.[0];
      if (!f) {
        C.showToast('No File', 'Please select a file to upload.', 'warning');
        return;
      }
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
      const previewContainer = document.getElementById('previewContainer');
      const previewTitle = document.getElementById('previewTitle');
      const previewMedia = document.getElementById('previewMedia');
      const dlBtn = document.getElementById('downloadPreviewBtn');

      status.textContent = 'Rendering with Playwright...';
      const format = document.getElementById('labFormat').value;
      const filename = document.getElementById('labFilename').value || 'document';
      const watermark = document.getElementById('labWatermark').value || '';
      const html = document.getElementById('labHtml').value || '<p>Empty</p>';

      const r = await C.apiJson('/api/files/convert', {
        method: 'POST',
        body: JSON.stringify({ html, format, filename, watermark })
      });

      if (r.ok) {
        status.textContent = `Generated ${r.filename} (${Math.round(r.size / 1024)} KB)`;
        previewContainer.style.display = 'flex';
        previewTitle.textContent = `Preview: ${r.filename} (${Math.round(r.size / 1024)} KB)`;

        const dataUri = `data:${r.mimeType};base64,${r.base64}`;
        dlBtn.href = dataUri;
        dlBtn.download = r.filename;
        dlBtn.textContent = `Download ${r.filename}`;

        previewMedia.textContent = '';
        if (format === 'pdf' || r.mimeType === 'application/pdf') {
          const iframe = document.createElement('iframe');
          iframe.id = 'previewPdfFrame';
          iframe.src = dataUri;
          iframe.title = 'PDF Preview';
          iframe.style.cssText = 'width:100%;height:380px;border:none;border-radius:4px;';
          previewMedia.appendChild(iframe);
        } else {
          const img = document.createElement('img');
          img.id = 'previewImage';
          img.src = dataUri;
          img.alt = r.filename;
          img.style.cssText = 'max-width:100%;max-height:380px;object-fit:contain;border-radius:4px;';
          previewMedia.appendChild(img);
        }

        C.showToast('Converted', r.filename, 'success');
      } else {
        status.textContent = r.error || 'Conversion failed';
        previewContainer.style.display = 'none';
        C.showToast('Conversion Error', r.error || 'Conversion failed', 'error');
      }
    });
  });
})();