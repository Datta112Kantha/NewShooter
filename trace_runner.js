const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const documentsDir = path.resolve('./documents');
  if (!fs.existsSync(documentsDir)) {
    fs.mkdirSync(documentsDir, { recursive: true });
  }

  const extensionPath = path.resolve('./extension');
  const extensionExists = fs.existsSync(extensionPath);

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ];

  if (extensionExists) {
    launchArgs.push(
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    );
  }

  console.log(`[Trace] Launching Chromium persistent context...`);
  console.log(`[Trace] Extension path: ${extensionPath} (exists: ${extensionExists})`);
  console.log(`[Trace] Video recording dir: ${documentsDir}`);

  const userDataDir = path.resolve('./.browser_profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: launchArgs,
    recordVideo: {
      dir: documentsDir,
      size: { width: 1280, height: 720 },
    },
    viewport: { width: 1280, height: 720 },
  });

  const networkLog = [];
  const wsLog = [];

  function setupPageMonitoring(page) {
    page.on('request', (request) => {
      const entry = {
        timestamp: new Date().toISOString(),
        type: 'request',
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        headers: request.headers(),
        postData: request.postData(),
      };
      networkLog.push(entry);
      console.log(`[REQ] ${request.method()} ${request.url()} (${request.resourceType()})`);
      if (entry.postData) {
        console.log(`  Payload: ${entry.postData.slice(0, 300)}`);
      }
    });

    page.on('response', async (response) => {
      let body = null;
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('javascript') || ct.includes('html')) {
          body = await response.text();
        }
      } catch (e) {
        body = `[Error reading body: ${e.message}]`;
      }

      const entry = {
        timestamp: new Date().toISOString(),
        type: 'response',
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        headers: response.headers(),
        body: body && body.length > 2500 ? body.slice(0, 2500) + '... [truncated]' : body,
      };
      networkLog.push(entry);
      console.log(`[RESP] ${response.status()} ${response.url()}`);
      if (body && response.status() !== 304 && !response.url().endsWith('.css') && !response.url().includes('font')) {
        console.log(`  Body preview: ${body.slice(0, 250)}`);
      }
    });

    page.on('websocket', (ws) => {
      console.log(`[WebSocket Open] ${ws.url()}`);
      wsLog.push({ event: 'open', url: ws.url(), timestamp: new Date().toISOString() });

      ws.on('framesent', (event) => {
        console.log(`[WS Sent] ${event.payload}`);
        wsLog.push({ event: 'sent', url: ws.url(), payload: event.payload, timestamp: new Date().toISOString() });
      });

      ws.on('framereceived', (event) => {
        console.log(`[WS Received] ${event.payload}`);
        wsLog.push({ event: 'received', url: ws.url(), payload: event.payload, timestamp: new Date().toISOString() });
      });

      ws.on('close', () => {
        console.log(`[WebSocket Closed] ${ws.url()}`);
        wsLog.push({ event: 'close', url: ws.url(), timestamp: new Date().toISOString() });
      });
    });

    page.on('console', (msg) => {
      console.log(`[Browser Console ${msg.type()}] ${msg.text()}`);
    });
  }

  context.on('page', (page) => {
    setupPageMonitoring(page);
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  setupPageMonitoring(page);

  console.log('[Trace] Navigating to https://2223.tech...');
  await page.goto('https://2223.tech', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('[Trace] Current URL:', page.url());
  console.log('[Trace] Page title:', await page.title());

  // Wait for login form
  await page.waitForSelector('#userName', { timeout: 15000 });
  console.log('[Trace] Filling credentials...');
  await page.fill('#userName', 'admfib7H');
  await page.fill('#Pass', 'd9tQGJdZ77');

  console.log('[Trace] Clicking #loginButton...');
  await page.click('#loginButton');

  // Wait to see if session limit box appears or if redirect happens
  console.log('[Trace] Checking login response...');
  let reachedV3 = false;

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const curUrl = page.url();
    if (curUrl.includes('/V3/')) {
      reachedV3 = true;
      console.log('[Trace] Successfully reached /V3/ URL:', curUrl);
      break;
    }

    const limitVisible = await page.evaluate(() => {
      const el = document.getElementById('limitBox');
      return el && el.classList.contains('show');
    }).catch(() => false);

    if (limitVisible) {
      console.log('[Trace] Session limit detected! Clicking #limitGo to evict oldest session...');
      await page.click('#limitGo');
      console.log('[Trace] #limitGo clicked, awaiting redirect to /V3/...');
      await page.waitForTimeout(2000);
    }
  }

  if (!page.url().includes('/V3/')) {
    console.log('[Trace] Waiting for navigation to /V3/...');
    await page.waitForURL('**/V3/**', { timeout: 15000 }).catch(e => console.log('[Trace] URL wait warning:', e.message));
  }

  console.log('[Trace] Landing page URL:', page.url());
  console.log('[Trace] Landing page Title:', await page.title());

  // Wait for dashboard to fully load all assets, websocket, and initial AJAX
  console.log('[Trace] Waiting 10s for dashboard initialization...');
  await page.waitForTimeout(10000);

  // Take screenshot of main dashboard
  const screenshotPath1 = path.join(documentsDir, '1_dashboard_loaded.png');
  await page.screenshot({ path: screenshotPath1, fullPage: true });
  console.log(`[Trace] Screenshot saved: ${screenshotPath1}`);

  // Inspect DOM elements, forms, and triggers
  const domInspection = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')).map(el => ({
      tag: el.tagName,
      id: el.id,
      className: el.className,
      text: el.innerText ? el.innerText.trim() : (el.value || el.title || el.getAttribute('aria-label') || ''),
      onclick: el.getAttribute('onclick'),
    })).filter(b => b.text || b.id);

    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id,
      action: f.action,
      method: f.method,
      inputs: Array.from(f.querySelectorAll('input, select, textarea')).map(inp => ({
        id: inp.id,
        name: inp.name,
        type: inp.type,
        value: inp.value,
      }))
    }));

    const globalRelay = typeof window.RelayApi !== 'undefined' ? {
      available: true,
      keys: Object.getOwnPropertyNames(window.RelayApi),
      endpoint: window.RelayApi.endpoint || window.RelayApi._endpoint || null,
      loginURL: window.RelayApi.loginURL || window.RelayApi._loginURL || null,
    } : { available: false };

    return {
      title: document.title,
      url: window.location.href,
      buttons,
      forms,
      globalRelay,
      metaTags: Array.from(document.querySelectorAll('meta')).map(m => ({ name: m.name, content: m.content })),
    };
  });

  fs.writeFileSync(path.join(documentsDir, 'dom_inspection.json'), JSON.stringify(domInspection, null, 2));
  console.log('[Trace] DOM inspection saved to ./documents/dom_inspection.json');

  // Check if there is an email trigger / test shoot button or tab to interact with
  console.log('[Trace] Available buttons count:', domInspection.buttons.length);
  const testShootBtn = domInspection.buttons.find(b => b.id.includes('test') || b.id.includes('shoot') || b.id.includes('send') || b.text.toLowerCase().includes('test') || b.text.toLowerCase().includes('shoot') || b.text.toLowerCase().includes('send'));
  console.log('[Trace] Candidate test/send button:', testShootBtn);

  // If a test or shoot button exists, let's click or inspect it
  const testShootSelector = '#testShootBtn, #testSendBtn, #btnTestShoot, #btnSend, .btn-test-shoot, #sendBtn';
  const testEl = await page.$(testShootSelector);
  if (testEl) {
    console.log(`[Trace] Found test email trigger element (${testShootSelector}). Inspecting and clicking...`);
    await testEl.click().catch(e => console.log('Click notice:', e.message));
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(documentsDir, '2_after_test_click.png'), fullPage: true });
  }

  // Keep session active long enough to complete all background network calls & websockets
  console.log('[Trace] Keeping session active for 15s to capture asynchronous triggers & background calls...');
  await page.waitForTimeout(15000);

  // Final screenshot
  await page.screenshot({ path: path.join(documentsDir, '3_final_state.png'), fullPage: true });

  // Save network and websocket traces
  fs.writeFileSync(path.join(documentsDir, 'network_trace.json'), JSON.stringify(networkLog, null, 2));
  fs.writeFileSync(path.join(documentsDir, 'websocket_trace.json'), JSON.stringify(wsLog, null, 2));

  console.log('[Trace] Traces successfully saved to ./documents/');
  console.log('[Trace] Closing browser context to finalize video recording...');
  await context.close();

  const videos = fs.readdirSync(documentsDir).filter(f => f.endsWith('.webm'));
  console.log('[Trace] Final video files in ./documents/:', videos);
})();
