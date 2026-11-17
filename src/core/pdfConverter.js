'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SUPPORTED_FORMATS = new Set(['pdf', 'png', 'jpeg', 'jpg', 'webp']);

/**
 * Local Playwright-based HTML -> PDF / Image converter (zero external API dependency).
 */
async function convertHtml({ html, format = 'pdf', filename = 'document', watermark = '' }) {
  const fmt = String(format || 'pdf').toLowerCase().trim();
  if (!html || !String(html).trim()) {
    throw new Error('Cannot convert empty HTML content');
  }
  const normalizedFmt = fmt === 'jpg' ? 'jpeg' : fmt;
  if (!SUPPORTED_FORMATS.has(fmt) && !['tiff', 'bmp', 'heic'].includes(fmt)) {
    throw new Error(`Unsupported conversion format: ${fmt}`);
  }

  const watermarkHtml = watermark
    ? `<div style="position:fixed;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center;opacity:0.08;font-size:56px;font-weight:700;transform:rotate(-28deg);color:#0f172a;z-index:9999;">${escapeHtml(watermark)}</div>`
    : '';

  const fullDoc = /<html[\s>]/i.test(html)
    ? (watermarkHtml ? html.replace(/<body([^>]*)>/i, `<body$1>${watermarkHtml}`) : html)
    : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:32px;color:#0f172a;background:#fff;line-height:1.5;}</style></head><body>${watermarkHtml}${html}</body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 850, height: 1100 } });
    await page.setContent(fullDoc, { waitUntil: 'load' });

    let buffer;
    let ext = normalizedFmt;
    let mimeType;

    if (normalizedFmt === 'pdf') {
      buffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' }
      });
      mimeType = 'application/pdf';
    } else if (normalizedFmt === 'jpeg') {
      buffer = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
      ext = 'jpg';
      mimeType = 'image/jpeg';
    } else if (normalizedFmt === 'webp') {
      // Playwright screenshot outputs png/jpeg natively; encode webp via browser canvas when supported
      const dataUrl = await page.evaluate(async () => {
        return null;
      });
      if (dataUrl) {
        buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
        mimeType = 'image/webp';
      } else {
        // Take PNG and convert via in-page canvas to image/webp
        const pngBuf = await page.screenshot({ type: 'png', fullPage: true });
        const webpB64 = await page.evaluate(async (b64) => {
          const img = new Image();
          img.src = 'data:image/png;base64,' + b64;
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.getContext('2d').drawImage(img, 0, 0);
          return canvas.toDataURL('image/webp', 0.9).split(',')[1];
        }, pngBuf.toString('base64'));
        buffer = Buffer.from(webpB64, 'base64');
        ext = 'webp';
        mimeType = 'image/webp';
      }
    } else {
      // png default or bmp/tiff/heic graceful PNG raster
      buffer = await page.screenshot({ type: 'png', fullPage: true });
      ext = fmt === 'png' || !['bmp', 'tiff', 'heic'].includes(fmt) ? 'png' : 'png';
      mimeType = 'image/png';
    }

    const safeBase = String(filename || 'document')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '_') || 'document';

    return {
      filename: `${safeBase}.${ext}`,
      mimeType,
      size: buffer.length,
      buffer,
      requestedFormat: fmt
    };
  } finally {
    await browser.close();
  }
}

async function convertHtmlToFile(options, outputDir) {
  const result = await convertHtml(options);
  fs.mkdirSync(outputDir, { recursive: true });
  const targetPath = path.join(outputDir, result.filename);
  fs.writeFileSync(targetPath, result.buffer);
  return { ...result, path: targetPath };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  convertHtml,
  convertHtmlToFile
};
