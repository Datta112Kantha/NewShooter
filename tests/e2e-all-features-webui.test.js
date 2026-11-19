'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const { createServer } = require('../src/server/app');
const { PREDEFINED_TAG_CATALOG } = require('../src/core/tagEngine');

test('Comprehensive E2E Web UI: Tags, Files, GMASS-2, and Theme Persistence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-webui-'));
  const app = createServer({
    port: 0,
    dataDir: path.join(tmpDir, 'data'),
    profilesRoot: path.join(tmpDir, 'profiles')
  });
  const addr = await app.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Seed online tabs for GMASS dispatch testing
  app.store.upsertOnlineTab({
    tabKey: 'acc1:1',
    accountId: 'acc1',
    tabId: 1,
    email: 'sender1@example.com',
    provider: 'gmail',
    tabName: 'Sender Tab 1',
    status: 'Idle',
    isActive: true,
    ip: '198.51.100.10',
    proxy: 'direct://'
  });
  app.store.upsertOnlineTab({
    tabKey: 'acc2:2',
    accountId: 'acc2',
    tabId: 2,
    email: 'support@cloudcrest.example',
    provider: 'outlook',
    tabName: 'Sender Tab 2',
    status: 'Idle',
    isActive: true,
    ip: '198.51.100.11',
    proxy: 'direct://'
  });

  const browser = await chromium.launch({ headless: true });
  const pageErrors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon.ico') && !text.includes('401 (Unauthorized)')) {
          pageErrors.push(`console.error: ${text}`);
        }
      }
    });

    // ── 0. Initial Login ─────────────────────────────────────────────────────
    await page.goto(`${baseUrl}/Login.php`, { waitUntil: 'load' });
    await page.waitForSelector('#loginButton');
    await page.fill('#usr', 'admfib7H');
    await page.fill('#pas', 'd9tQGJdZ77');
    await Promise.all([
      page.waitForURL('**/V3/'),
      page.click('#loginButton')
    ]);

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Dark/Light Theme Toggles & Persistence across Navigations
    // ─────────────────────────────────────────────────────────────────────────
    const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.ok(['light', 'dark'].includes(initialTheme));

    // Force theme to dark
    const targetDark = initialTheme === 'dark' ? false : true;
    if (targetDark) {
      await page.click('#themeToggle');
    }
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('color-scheme')), 'dark');
    assert.equal(await page.getAttribute('meta[name="color-scheme"]', 'content'), 'dark');

    // Navigate to /V3/tags/ and verify dark theme persisted
    await page.goto(`${baseUrl}/V3/tags/`, { waitUntil: 'load' });
    await page.waitForSelector('#tagsGrid');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.getAttribute('meta[name="color-scheme"]', 'content'), 'dark');

    // Navigate to /V3/files/ and verify dark theme persisted
    await page.goto(`${baseUrl}/V3/files/`, { waitUntil: 'load' });
    await page.waitForSelector('#labConvertBtn');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');

    // Navigate to /gmass2 and verify dark theme persisted
    await page.goto(`${baseUrl}/gmass2`, { waitUntil: 'load' });
    await page.waitForSelector('#gmBlastBtn');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');

    // Toggle theme back to light on /gmass2
    await page.click('#themeToggle');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await page.evaluate(() => localStorage.getItem('color-scheme')), 'light');

    // Navigate back to /V3/tags/ and verify light theme persisted
    await page.goto(`${baseUrl}/V3/tags/`, { waitUntil: 'load' });
    await page.waitForSelector('#tagsGrid');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');

    // ─────────────────────────────────────────────────────────────────────────
    // 2. /V3/tags/: Predefined Catalog, Category Filtering, CRUD, Circular, Spintax
    // ─────────────────────────────────────────────────────────────────────────
    // A. Predefined Tag Catalog Browsing (all 63 tags)
    await page.waitForSelector('#catalogGrid .predefined-card');
    const catalogCountText = await page.locator('#catalogCount').innerText();
    const statCatalogCountText = await page.locator('#statCatalogCount').innerText();
    assert.equal(catalogCountText, '63');
    assert.equal(statCatalogCountText, '63');

    const totalCatalogCards = await page.locator('#catalogGrid .predefined-card').count();
    assert.equal(totalCatalogCards, 63, 'Expected all 63 predefined catalog tags to be rendered in ALL view');
    assert.equal(PREDEFINED_TAG_CATALOG.length, 63);

    // Verify key built-in tags are present in catalog
    const catalogText = await page.locator('#catalogGrid').innerText();
    assert.ok(catalogText.includes('{email}'));
    assert.ok(catalogText.includes('{name}'));
    assert.ok(catalogText.includes('{orderno}'));
    assert.ok(catalogText.includes('{grandtotal}'));
    assert.ok(catalogText.includes('{carrier}'));
    assert.ok(catalogText.includes('{uuid}'));

    // B. Category Filtering
    // Filter by COMMERCE category
    await page.click('#categoryFilterBar button[data-category="COMMERCE"]');
    await page.waitForTimeout(100);
    const commerceCardCount = await page.locator('#catalogGrid .predefined-card').count();
    const commerceExpected = PREDEFINED_TAG_CATALOG.filter((t) => t.category === 'COMMERCE').length;
    assert.equal(commerceCardCount, commerceExpected);
    const commerceGridText = await page.locator('#catalogGrid').innerText();
    assert.ok(commerceGridText.includes('{orderno}'));
    assert.ok(commerceGridText.includes('{productname}'));
    assert.ok(!commerceGridText.includes('{email}')); // email is IDENTITY, shouldn't appear

    // Filter by PRICING category via dropdown select
    await page.selectOption('#categorySelect', 'PRICING');
    await page.waitForTimeout(100);
    const pricingCardCount = await page.locator('#catalogGrid .predefined-card').count();
    const pricingExpected = PREDEFINED_TAG_CATALOG.filter((t) => t.category === 'PRICING').length;
    assert.equal(pricingCardCount, pricingExpected);
    const pricingGridText = await page.locator('#catalogGrid').innerText();
    assert.ok(pricingGridText.includes('{grandtotal}'));
    assert.ok(pricingGridText.includes('{unitprice}'));

    // Reset back to ALL
    await page.click('#categoryFilterBar button[data-category="ALL"]');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#catalogGrid .predefined-card').count(), 63);

    // Search input filtering
    await page.fill('#tagSearchInput', 'tracking');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#catalogGrid .predefined-card').count(), 1);
    assert.ok((await page.locator('#catalogGrid').innerText()).includes('{tracking}'));
    await page.fill('#tagSearchInput', '');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#catalogGrid .predefined-card').count(), 63);

    // C. Custom Tag Creation: Sequential & Static & Random
    const cardFor = (key) => page.locator('.tag-card', { has: page.locator('.tag-card__name', { hasText: key }) });

    // 1) Sequential Tag
    await page.fill('#newTagName', 'promoTier');
    await page.fill('#newTagValues', 'VIP, Standard, Gold, Bronze');
    await page.selectOption('#newTagType', 'sequential');
    await page.click('#createTagForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('{promoTier}'));

    let promoCard = cardFor('{promoTier}');
    assert.ok(await promoCard.locator('.val-chip', { hasText: 'VIP' }).isVisible());
    assert.ok(await promoCard.locator('.val-chip', { hasText: 'Standard' }).isVisible());
    assert.ok(await promoCard.locator('.val-chip', { hasText: 'Gold' }).isVisible());
    assert.ok(await promoCard.locator('.val-chip', { hasText: 'Bronze' }).isVisible());
    assert.equal(await promoCard.locator('button', { hasText: 'Sequential' }).isVisible(), true);

    // 2) Static Tag
    await page.fill('#newTagName', 'systemToken');
    await page.fill('#newTagValues', 'SYS_STATIC_XYZ123');
    await page.selectOption('#newTagType', 'static');
    await page.click('#createTagForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('{systemToken}'));

    let staticCard = cardFor('{systemToken}');
    assert.ok(await staticCard.locator('.val-chip', { hasText: 'SYS_STATIC_XYZ123' }).isVisible());
    assert.equal(await staticCard.locator('button', { hasText: 'Static' }).isVisible(), true);

    // 3) Random Tag
    await page.fill('#newTagName', 'greetingStyle');
    await page.fill('#newTagValues', 'Hi there, Good day, Welcome');
    await page.selectOption('#newTagType', 'random');
    await page.click('#createTagForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('{greetingStyle}'));

    let randomCard = cardFor('{greetingStyle}');
    assert.equal(await randomCard.locator('button', { hasText: 'Random' }).isVisible(), true);

    // D. Custom Tag Editing
    // Click "Edit" on {promoTier} card to open modal dialog
    await promoCard.locator('button', { hasText: 'Edit' }).click();
    await page.waitForSelector('#editTagDialog[open]');
    assert.equal(await page.inputValue('#editTagName'), 'promoTier');
    assert.equal(await page.inputValue('#editTagType'), 'sequential');

    // Append 'Diamond' to values and save
    const curValText = await page.inputValue('#editTagValues');
    await page.fill('#editTagValues', curValText + '\nDiamond');
    await page.click('#editTagForm button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById('editTagDialog').open);

    promoCard = cardFor('{promoTier}');
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('Diamond'));
    assert.ok(await promoCard.locator('.val-chip', { hasText: 'Diamond' }).isVisible());

    // Inline add value: add 'Platinum' via card's inline add form
    await promoCard.locator('input[placeholder="Add value..."]').fill('Platinum');
    await promoCard.locator('button[type="submit"]', { hasText: '+' }).click();
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('Platinum'));
    assert.ok(await promoCard.locator('.val-chip', { hasText: 'Platinum' }).isVisible());

    // Remove single value chip ('Bronze')
    await promoCard.locator('.val-chip', { hasText: 'Bronze' }).locator('button[aria-label*="Remove"]').click();
    await page.waitForTimeout(150);
    assert.equal(await promoCard.locator('.val-chip', { hasText: 'Bronze' }).count(), 0);

    // Toggle tag type in-card from Sequential -> Random
    await promoCard.locator('button', { hasText: 'Sequential' }).click();
    await promoCard.locator('button', { hasText: 'Random' }).waitFor();
    assert.equal(await promoCard.locator('button', { hasText: 'Random' }).isVisible(), true);

    // E. Circular Dependency Error UI
    // Create Tag Loop A: {loopA} -> '{loopB}'
    await page.fill('#newTagName', 'loopA');
    await page.fill('#newTagValues', '{loopB}');
    await page.click('#createTagForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('{loopA}'));

    // Create Tag Loop B: {loopB} -> '{loopA}'
    await page.fill('#newTagName', 'loopB');
    await page.fill('#newTagValues', '{loopA}');
    await page.click('#createTagForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('tagsGrid').innerText.includes('{loopB}'));

    // Verify Circular Alert is displayed
    await page.waitForFunction(() => {
      const el = document.getElementById('circularAlert');
      return el && window.getComputedStyle(el).display !== 'none';
    });
    const circularAlertMsg = await page.locator('#circularAlertMsg').innerText();
    assert.ok(circularAlertMsg.includes('loopA'));
    assert.ok(circularAlertMsg.includes('loopB'));

    // Verify error class applied to cards
    assert.ok(await page.locator('.tag-card--error').count() >= 2);

    // Fix circular dependency by deleting {loopB}
    const loopBCard = cardFor('{loopB}');
    await loopBCard.locator('button', { hasText: 'Delete' }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.tag-card__name')].some((el) => el.textContent === '{loopB}'));

    // Verify Circular Alert is cleared
    await page.waitForFunction(() => {
      const el = document.getElementById('circularAlert');
      return el && window.getComputedStyle(el).display === 'none';
    });
    // Clean up loopA
    const loopACard = cardFor('{loopA}');
    await loopACard.locator('button', { hasText: 'Delete' }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.tag-card__name')].some((el) => el.textContent === '{loopA}'));

    // F. Live Spintax Playground Testing
    await page.fill('#spintaxInput', '{Hello|Hi|Greetings} {name}, order #{100-200} for {systemToken}!');
    await page.click('#testSpintaxBtn');
    await page.waitForFunction(() => {
      const out = document.getElementById('spintaxOutput').textContent;
      return out && out.includes('SYS_STATIC_XYZ123') && !out.includes('{systemToken}');
    });
    const spintaxOutput = await page.locator('#spintaxOutput').innerText();
    assert.ok(/^(Hello|Hi|Greetings)\s/.test(spintaxOutput), `Expected greeting in "${spintaxOutput}"`);
    assert.ok(/order #1\d\d/.test(spintaxOutput), `Expected range between 100-200 in "${spintaxOutput}"`);
    assert.ok(spintaxOutput.includes('SYS_STATIC_XYZ123'));

    // Nested Spintax resolution
    await page.fill('#spintaxInput', '{Welcome to {the VIP club|our elite circle}|Good day}!');
    await page.click('#testSpintaxBtn');
    await page.waitForFunction(() => {
      const out = document.getElementById('spintaxOutput').textContent;
      return out.includes('VIP club') || out.includes('elite circle') || out.includes('Good day');
    });

    // Clicking a predefined catalog tag inserts it into the playground
    await page.click('.predefined-card strong:has-text("{orderno}")');
    await page.waitForFunction(() => document.getElementById('spintaxInput').value.includes('{orderno}'));

    // G. Custom Tag Deletion
    const deleteBtn = promoCard.locator('button', { hasText: 'Delete' });
    await deleteBtn.click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.tag-card__name')].some((el) => el.textContent === '{promoTier}'));

    const staticDelBtn = cardFor('{systemToken}').locator('button', { hasText: 'Delete' });
    await staticDelBtn.click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.tag-card__name')].some((el) => el.textContent === '{systemToken}'));

    const randomDelBtn = cardFor('{greetingStyle}').locator('button', { hasText: 'Delete' });
    await randomDelBtn.click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.tag-card__name')].some((el) => el.textContent === '{greetingStyle}'));

    // ─────────────────────────────────────────────────────────────────────────
    // 3. /V3/files/: Template Upload, HTML->PDF & PNG Preview, Watermark, DL, Del
    // ─────────────────────────────────────────────────────────────────────────
    await page.goto(`${baseUrl}/V3/files/`, { waitUntil: 'load' });
    await page.waitForSelector('#labConvertBtn');

    // A. Template Upload
    const templateContent = '<html><body><h1>Account Invoice</h1><p>Client: {name}</p><p>Balance: $450.00</p></body></html>';
    const sampleFilePath = path.join(tmpDir, 'invoice_template.html');
    fs.writeFileSync(sampleFilePath, templateContent, 'utf8');

    await page.setInputFiles('#fileInput', sampleFilePath);
    await page.click('#uploadBtn');
    await page.waitForFunction(() => document.getElementById('filesList').innerText.includes('invoice_template.html'));
    assert.equal(await page.locator('#storedFilesCount').innerText(), '1');

    // Verify uploaded file row has download and delete buttons
    const fileRow = page.locator('.file-item-row', { hasText: 'invoice_template.html' });
    assert.equal(await fileRow.locator('.file-download-btn').isVisible(), true);
    assert.equal(await fileRow.locator('.file-delete-btn').isVisible(), true);

    // Verify file download endpoint returns valid content
    const dlHref = await fileRow.locator('.file-download-btn').getAttribute('href');
    assert.ok(dlHref.startsWith('/api/files/'));
    const dlResp = await context.request.get(`${baseUrl}${dlHref}`);
    assert.equal(dlResp.status(), 200);
    assert.equal(await dlResp.text(), templateContent);

    // B. HTML-to-PDF Preview Generation via /api/files/convert with Watermark
    await page.selectOption('#labFormat', 'pdf');
    await page.fill('#labFilename', 'invoice_test');
    await page.fill('#labWatermark', 'PAID AND VERIFIED');
    await page.fill('#labHtml', '<h1>Invoice Document</h1><p>Customer: John Doe</p><p>Total Due: $350.00</p>');

    await page.click('#labConvertBtn');
    await page.waitForFunction(() => document.getElementById('labStatus').innerText.includes('Generated invoice_test.pdf'));
    await page.waitForSelector('#previewContainer:not([style*="display: none"])');
    await page.waitForSelector('#previewPdfFrame');

    const pdfFrameSrc = await page.locator('#previewPdfFrame').getAttribute('src');
    assert.ok(pdfFrameSrc.startsWith('data:application/pdf;base64,'), 'Expected PDF data URI');
    const dlPdfHref = await page.locator('#downloadPreviewBtn').getAttribute('href');
    assert.ok(dlPdfHref.startsWith('data:application/pdf;base64,'));
    assert.equal(await page.locator('#downloadPreviewBtn').getAttribute('download'), 'invoice_test.pdf');

    // C. HTML-to-PNG Preview Generation via /api/files/convert with Watermark
    await page.selectOption('#labFormat', 'png');
    await page.fill('#labFilename', 'banner_preview');
    await page.fill('#labWatermark', 'CONFIDENTIAL DRAFT');
    await page.fill('#labHtml', '<div style="background:#4f46e5;color:#fff;padding:40px;border-radius:16px"><h2>Executive Report</h2><p>Q4 Performance Metrics</p></div>');

    await page.click('#labConvertBtn');
    await page.waitForFunction(() => document.getElementById('labStatus').innerText.includes('Generated banner_preview.png'));
    await page.waitForSelector('#previewImage');

    const pngImgSrc = await page.locator('#previewImage').getAttribute('src');
    assert.ok(pngImgSrc.startsWith('data:image/png;base64,'), 'Expected PNG data URI');
    const dlPngHref = await page.locator('#downloadPreviewBtn').getAttribute('href');
    assert.ok(dlPngHref.startsWith('data:image/png;base64,'));
    assert.equal(await page.locator('#downloadPreviewBtn').getAttribute('download'), 'banner_preview.png');

    // D. File Deletion
    await fileRow.locator('.file-delete-btn').click();
    await page.waitForFunction(() => !document.getElementById('filesList').innerText.includes('invoice_template.html'));
    assert.equal(await page.locator('#storedFilesCount').innerText(), '0');

    // ─────────────────────────────────────────────────────────────────────────
    // 4. /gmass2: Campaign Config, Delays, HTML-Only, Start, Pause, Resume, Stop
    // ─────────────────────────────────────────────────────────────────────────
    await page.goto(`${baseUrl}/gmass2`, { waitUntil: 'load' });
    await page.waitForSelector('#gmBlastBtn');

    // Verify initial UI elements
    assert.equal(await page.locator('#gmassModeHeading').innerText(), 'Script · Bin4ry Relay');
    assert.match(await page.locator('#gmassStatusPill').innerText(), /Idle/i);

    // A. Campaign Configuration
    await page.fill('#gmEmails', 'lead1@example.com\nlead2@example.com\nlead3@example.com');
    await page.waitForFunction(() => document.getElementById('gmEmailCount').textContent === '3');
    await page.fill('#gmSubject', 'Quarterly Summary {orderno}');
    await page.fill('#gmMessage', '<p>Hello {name}, your bill total is {grandtotal}.</p>');
    await page.fill('#gmPdfHtml', '<h1>Invoice {orderno}</h1><p>Amount: {amount}</p>');
    await page.fill('#gmWatermark', 'ORIGINAL COPY');
    await page.fill('#gmFilename', 'report_{orderno}');
    await page.fill('#gmFromName', 'Accounts Payable');

    // B. Delay Intervals Configuration
    await page.waitForSelector('#gmDelayInterval');
    await page.fill('#gmDelayInterval', '600');
    assert.equal(await page.inputValue('#gmDelayInterval'), '600');

    // C. HTML-only Toggle and Mutual Exclusivity with HTML->PDF
    await page.check('#gmConvertPdf');
    assert.equal(await page.isChecked('#gmConvertPdf'), true);
    await page.check('#gmHtmlOnly');
    assert.equal(await page.isChecked('#gmHtmlOnly'), true);
    assert.equal(await page.isChecked('#gmConvertPdf'), false, 'Checking HTML only should uncheck HTML->PDF');

    await page.check('#gmConvertPdf');
    assert.equal(await page.isChecked('#gmConvertPdf'), true);
    assert.equal(await page.isChecked('#gmHtmlOnly'), false, 'Checking HTML->PDF should uncheck HTML only');

    // Keep HTML only checked for clean dispatch testing
    await page.check('#gmHtmlOnly');

    // D. Campaign Controls: Start (Blast)
    await page.click('#gmBlastBtn');
    await page.waitForFunction(() => {
      const txt = document.getElementById('gmassStatusPill').innerText;
      return txt.includes('Sending') || txt.includes('Blasting');
    });
    await page.waitForSelector('#gmSentLog > div');
    const sentCount = await page.locator('#gmSentLog > div').count();
    assert.ok(sentCount >= 1, `Expected at least 1 log entry in sent box, got ${sentCount}`);

    // E. Campaign Controls: Pause
    await page.click('#gmPauseBtn');
    await page.waitForFunction(() => document.getElementById('gmassStatusPill').innerText.includes('Paused'));
    assert.match(await page.locator('#gmassStatusPill').innerText(), /Paused/i);

    // F. Campaign Controls: Resume
    await page.click('#gmResumeBtn');
    await page.waitForFunction(() => {
      const txt = document.getElementById('gmassStatusPill').innerText;
      return txt.includes('Resumed') || txt.includes('Sending');
    });
    assert.match(await page.locator('#gmassStatusPill').innerText(), /Resumed|Sending/i);

    // G. Campaign Controls: Stop
    await page.click('#gmStopBtn');
    await page.waitForFunction(() => document.getElementById('gmassStatusPill').innerText.includes('Stopped'));
    assert.match(await page.locator('#gmassStatusPill').innerText(), /Stopped/i);

    // H. Show Failed Log Filter Toggle
    await page.click('#gmShowFailedBtn');
    assert.equal(await page.locator('#gmShowFailedBtn').getAttribute('aria-pressed'), 'true');
    await page.click('#gmShowFailedBtn');
    assert.equal(await page.locator('#gmShowFailedBtn').getAttribute('aria-pressed'), 'false');

    // Verify no unexpected unhandled errors occurred in the browser
    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
  } finally {
    await browser.close();
    await app.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});