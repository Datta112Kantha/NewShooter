'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { ProxyBridge, probeProxyIp } = require('../proxy/proxyBridge');

const PROVIDER_LOGIN_URLS = {
  gmail: 'https://accounts.google.com/ServiceLogin?service=mail',
  outlook: 'https://login.live.com/',
  yahoo: 'https://login.yahoo.com/'
};

/**
 * Manages isolated persistent Chromium profiles per account + ProxyBridge pairs.
 * Guarantees each Gmail/Outlook/Yahoo account runs with its own Proxy + cookies + WebRTC IP leak protection.
 */
class BrowserManager {
  constructor(store, options = {}) {
    this.store = store;
    this.profilesRoot = options.profilesRoot || path.join(process.cwd(), '.browser_profile');
    this.extensionDir = options.extensionDir || path.join(process.cwd(), 'extension');
    this.headless = options.headless ?? false;
    this.serverPort = options.serverPort || 8080;
    /** @type {Map<string, { context: any, bridge: ProxyBridge|null, page: any, accountId: string }>} */
    this.sessions = new Map();

    fs.mkdirSync(this.profilesRoot, { recursive: true });
  }

  setServerPort(port) {
    this.serverPort = port;
  }

  async launchAccount(accountId, launchOptions = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    // Stop any previous running browser instance for this account
    if (this.sessions.has(account.id)) {
      await this.stopAccount(account.id);
    }

    let bridge = null;
    let bridgeUrl = null;
    const bridgeOpts = launchOptions.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: launchOptions.rejectUnauthorized }
      : {};
    if (account.proxy) {
      bridge = new ProxyBridge(account.proxy, bridgeOpts);
      bridgeUrl = await bridge.start();
    }

    const profileDir = path.join(this.profilesRoot, `profile_${account.id}`);
    fs.mkdirSync(profileDir, { recursive: true });

    const useExtension = launchOptions.loadExtension !== false && fs.existsSync(this.extensionDir);
    // Note: Bundled Chromium must be used when loading unpacked extensions via CLI flags
    // because stable Google Chrome / Edge channels disallow --load-extension and show --no-sandbox errors.
    const channel = launchOptions.channel || 'chromium';

    const args = [
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars'
    ];
    if (useExtension) {
      args.push(
        `--disable-extensions-except=${this.extensionDir}`,
        `--load-extension=${this.extensionDir}`
      );
    }

    const headless = launchOptions.headless !== undefined ? Boolean(launchOptions.headless) : this.headless;
    const context = await chromium.launchPersistentContext(profileDir, {
      channel,
      headless,
      ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
      args,
      proxy: bridgeUrl ? { server: bridgeUrl } : undefined,
      userAgent: account.userAgent || undefined,
      viewport: { width: 1240, height: 820 }
    });

    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
      } catch {}
    });

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    const sessionRecord = {
      accountId: account.id,
      context,
      bridge,
      page,
      bridgeUrl
    };
    this.sessions.set(account.id, sessionRecord);

    context.on('close', async () => {
      if (this.sessions.get(account.id) === sessionRecord) {
        this.sessions.delete(account.id);
      }
      if (bridge) await bridge.stop().catch(() => {});
      const acc = this.store.getAccount(account.id);
      if (acc) {
        acc.launched = false;
        acc.status = 'Offline';
        this.store.save();
      }
    });

    account.launched = true;
    account.status = 'Launching';
    this.store.save();

    // Probe IP through bridge asynchronously or via provided test URL
    let probe = null;
    if (account.proxy) {
      probe = await probeProxyIp(account.proxy, {
        checkUrl: launchOptions.ipCheckUrl
      }).catch((err) => ({ ok: false, error: err.message }));
      if (probe) this.store.updateAccountIpStatus(account.id, probe);
    }

    // Navigate via local /rpa-bootstrap so rpa_* params never leak to Google/Microsoft/Yahoo
    const baseUrl = launchOptions.startUrl || PROVIDER_LOGIN_URLS[account.provider] || PROVIDER_LOGIN_URLS.gmail;
    const cleanTargetUrl = new URL(baseUrl).toString();
    let navError = null;

    if (!launchOptions.skipNavigate) {
      const canBootstrap = Boolean(this.serverPort) && !launchOptions.skipBootstrap;
      if (canBootstrap) {
        const bootstrapUrl = new URL(`http://127.0.0.1:${this.serverPort}/rpa-bootstrap`);
        bootstrapUrl.searchParams.set('rpa_account', account.id);
        bootstrapUrl.searchParams.set('rpa_email', account.email);
        bootstrapUrl.searchParams.set('rpa_ws', `ws://127.0.0.1:${this.serverPort}`);
        bootstrapUrl.searchParams.set('next', cleanTargetUrl);

        try {
          await page.goto(bootstrapUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForURL(
            (u) => !(u.hostname === '127.0.0.1' && u.pathname === '/rpa-bootstrap'),
            { waitUntil: 'domcontentloaded', timeout: 25000 }
          );
        } catch (err) {
          navError = err.message;
        }
      } else {
        try {
          await page.goto(cleanTargetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        } catch (err) {
          navError = err.message;
        }
      }
    }

    const proxyFailedOnStrictCheck = Boolean(account.proxy && probe && !probe.ok && launchOptions.strictProxy);
    const hasFatalError = Boolean(navError || proxyFailedOnStrictCheck);
    account.status = hasFatalError ? 'Error' : 'Active';
    this.store.save();

    const existingTab = Object.values(this.store.state.onlineTabs).find((t) => t.accountId === account.id);
    this.store.upsertOnlineTab({
      tabKey: existingTab ? existingTab.key : `${account.id}:pw`,
      tabId: existingTab ? existingTab.tabId : 1,
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      tabName: existingTab?.tabName || `${account.provider.toUpperCase()} (${account.email.split('@')[0]})`,
      status: navError
        ? `Proxy/Nav Error`
        : (probe && !probe.ok && launchOptions.ipCheckUrl ? `Proxy Error` : (existingTab?.status || 'Idle')),
      isActive: !hasFatalError,
      isBlocked: hasFatalError,
      ip: account.outboundIp || (account.proxy ? (probe && !probe.ok ? 'Proxy Err' : 'Proxied') : 'Direct'),
      proxy: account.proxy
    });

    return {
      accountId: account.id,
      bridgeUrl,
      probe,
      navError,
      url: cleanTargetUrl
    };
  }

  async stopAccount(accountId) {
    const rec = this.sessions.get(accountId);
    if (!rec) return false;
    this.sessions.delete(accountId);
    try {
      await rec.context.close();
    } catch {
      // ignore
    }
    if (rec.bridge) {
      await rec.bridge.stop().catch(() => {});
    }
    const acc = this.store.getAccount(accountId);
    if (acc) {
      acc.launched = false;
      acc.status = 'Offline';
      this.store.save();
    }
    this.store.removeOnlineTab(accountId);
    return true;
  }

  getRunningSession(accountId) {
    return this.sessions.get(accountId) || null;
  }

  async stopAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.stopAccount(id);
    }
  }
}

module.exports = {
  BrowserManager,
  PROVIDER_LOGIN_URLS
};
