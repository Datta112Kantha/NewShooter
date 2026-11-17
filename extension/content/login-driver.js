(function () {
  'use strict';

  const DOM = window.NewShooterDOM;
  const TOTP = window.NewShooterTOTP;
  const CREDS = window.NewShooterCredentials;

  let active = false;

  async function handleBootstrapHandoff() {
    if (window.location.pathname !== '/rpa-bootstrap') return false;
    const params = new URLSearchParams(window.location.search);
    const rpaAccount = params.get('rpa_account');
    const rpaEmail = params.get('rpa_email');
    const rpaWs = params.get('rpa_ws');
    try {
      await chrome.runtime.sendMessage({
        action: 'BOOTSTRAP_RPA',
        accountId: rpaAccount,
        email: rpaEmail,
        wsUrl: rpaWs
      });
    } catch {}
    document.documentElement.dataset.rpaBootstrapped = '1';
    window.dispatchEvent(new CustomEvent('rpa-bootstrapped'));
    return true;
  }

  function isControllerPage() {
    const p = window.location.pathname;
    return p.startsWith('/V3') || p === '/Login.php' || p === '/gmass2' || p === '/gmass4';
  }

  async function resolvePendingAccount() {
    const params = new URLSearchParams(window.location.search);
    const rpaAccount = params.get('rpa_account');
    const rpaEmail = params.get('rpa_email');
    const rpaWs = params.get('rpa_ws');

    if (rpaAccount || rpaEmail || rpaWs) {
      try {
        await chrome.runtime.sendMessage({
          action: 'BOOTSTRAP_RPA',
          accountId: rpaAccount,
          email: rpaEmail,
          wsUrl: rpaWs
        });
        params.delete('rpa_account');
        params.delete('rpa_email');
        params.delete('rpa_ws');
        const cleanSearch = params.toString();
        const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${window.location.hash}`;
        window.history.replaceState(null, '', cleanUrl);
      } catch {}
    }

    const maxWaitMs = (rpaAccount || rpaEmail) ? 8000 : 5000;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'GET_PENDING_LOGIN' });
        if (resp?.ok && resp.account?.email && resp.account?.password) {
          return { account: resp.account, settings: resp.settings || {} };
        }
      } catch {}
      await DOM.sleep(250);
    }
    return null;
  }

  function detectCaptcha() {
    const iframe = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], #captcha-form, img[src*="/Captcha"], [data-captcha="true"]');
    if (iframe && DOM.isElementVisible(iframe)) return true;
    const text = (document.body?.innerText || '').toLowerCase();
    return text.includes('type the text you hear or see')
      || text.includes('verify you are human')
      || text.includes('complete the captcha');
  }

  function detectGoogleErrorBanner() {
    const errEl = document.querySelector('div[jsname="B34EJ"], [role="alert"], .o6cuMc, .Ekjuhf');
    if (errEl && DOM.isElementVisible(errEl)) {
      const msg = errEl.innerText.trim();
      if (msg) return { text: msg, tier: CREDS.classifyErrorStatus(msg) };
    }
    const bodyText = (document.body?.innerText || '').toLowerCase();
    if (bodyText.includes('this browser or app may not be secure')) {
      return { text: 'This browser or app may not be secure (Google automation block)', tier: 'fatal' };
    }
    if (bodyText.includes("couldn't sign you in") && bodyText.includes('different browser')) {
      return { text: 'This browser or app may not be secure (Google automation block)', tier: 'fatal' };
    }
    return null;
  }

  function queryFirst(selectors) {
    for (const sel of selectors) {
      const all = document.querySelectorAll(sel);
      for (const el of all) {
        if (DOM.isElementVisible(el)) return el;
      }
    }
    return null;
  }

  async function reportError(account, text, tier) {
    const t = tier || CREDS.classifyErrorStatus(text);
    const severity = t === 'fatal' ? 'fatal' : (t === 'retry' ? 'retry' : 'action');
    await chrome.runtime.sendMessage({
      action: 'REPORT_VERIFICATION_STATUS',
      email: account.email,
      statusText: text.slice(0, 60),
      severity,
      code: t
    }).catch(() => {});
    await chrome.runtime.sendMessage({
      action: 'TASK_STATUS_UPDATE',
      email: account.email,
      status: 'FAILED',
      step: t,
      errorMessage: text
    }).catch(() => {});
  }

  async function waitWhileCaptcha(account, settings) {
    const res = await chrome.runtime.sendMessage({
      action: 'CAPTCHA_DETECTED',
      email: account.email
    }).catch(() => null);
    if (res?.closed) return false;
    if (settings.closeOnCaptcha && !settings.disableTabCloseOnError) return false;

    const timeoutMs = Math.max(5, Number(settings.captchaTimeoutSec || 60)) * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await DOM.sleep(1000);
      if (!detectCaptcha()) {
        await chrome.runtime.sendMessage({
          action: 'CAPTCHA_RESOLVED',
          email: account.email
        }).catch(() => {});
        return true;
      }
    }
    await reportError(account, 'Captcha timeout', 'action');
    return false;
  }

  async function handleGoogleTotp(account, settings, state) {
    const pinInput = queryFirst(['#totpPin', 'input[name="totpPin"]', 'input[autocomplete="one-time-code"]']);
    if (!pinInput) return 'none';
    if (!account.twoFa) {
      await reportError(account, '2FA Secret Missing', 'action');
      return 'abort';
    }

    const maxRetries = Math.max(1, Number(settings.totpMaxRetries ?? 2));
    if (state.totpAttempts > 0) {
      const err = detectGoogleErrorBanner();
      if (err && state.totpAttempts >= maxRetries) {
        await reportError(account, `TOTP failed after ${state.totpAttempts} attempts: ${err.text}`, 'fatal');
        return 'abort';
      }
      if (err) {
        await chrome.runtime.sendMessage({
          action: 'REPORT_VERIFICATION_STATUS',
          email: account.email,
          statusText: `TOTP Retry (${state.totpAttempts}/${maxRetries})`,
          severity: 'retry',
          code: 'totp_retry'
        }).catch(() => {});
      }
    }

    if (state.totpAttempts >= maxRetries) {
      await reportError(account, 'TOTP max retries exceeded', 'fatal');
      return 'abort';
    }

    let code = await TOTP.generateTOTP(account.twoFa);
    if (state.lastTotpCode && code === state.lastTotpCode) {
      const remainingMs = ((30 - (Math.floor(Date.now() / 1000) % 30)) * 1000) + 300;
      await DOM.sleep(Math.min(remainingMs, 3500));
      code = await TOTP.generateTOTP(account.twoFa);
    }

    state.totpAttempts += 1;
    state.lastTotpCode = code;
    await DOM.typeOrganic(pinInput, code, { useCdp: true, clear: true });

    if (settings.totpAutoSubmit !== false) {
      const nextBtn = queryFirst(['#totpNext button', '#totpNext', 'button[type="submit"]']);
      if (nextBtn) await DOM.cdpClickElement(nextBtn);
    }
    await DOM.sleep(1000);
    return 'acted';
  }

  async function handleRecoveryEmail(account) {
    const recInput = queryFirst(['#knowledge-preregistered-email-response', 'input[name="knowledgePreregisteredEmailResponse"]']);
    if (!recInput) return false;
    if (!account.recovery) {
      await reportError(account, 'Recovery email missing', 'action');
      return false;
    }
    await DOM.typeOrganic(recInput, account.recovery, { useCdp: true, clear: true });
    const nextBtn = queryFirst(['button[jsname="LgbsSe"]', '#next button', 'button[type="submit"]']);
    if (nextBtn) await DOM.cdpClickElement(nextBtn);
    await DOM.sleep(1000);
    return true;
  }

  async function handleSmsPhoneChallenge(account) {
    const bodyText = (document.body?.innerText || '').toLowerCase();
    if (bodyText.includes('too many failed attempts') || bodyText.includes('unavailable because there were too many')) {
      await reportError(account, 'Too many SMS verification attempts', 'fatal');
      return 'abort';
    }

    const phoneInput = queryFirst(['#phoneNumberId', 'input[type="tel"][name="phoneNumber"]']);
    if (!phoneInput) return 'none';

    for (let phoneTry = 0; phoneTry < 5; phoneTry++) {
      const curPhoneEl = queryFirst(['#phoneNumberId', 'input[type="tel"][name="phoneNumber"]']);
      if (!curPhoneEl) break;

      const claim = await chrome.runtime.sendMessage({ action: 'SMS_POOL_CLAIM', email: account.email });
      if (!claim?.ok || !claim.item) {
        await reportError(account, 'No available SMS pool numbers', 'action');
        return 'abort';
      }

      await DOM.typeOrganic(curPhoneEl, claim.item.phone, { useCdp: true, clear: true });
      const sendBtn = queryFirst(['#idvanyphonecollectNext button', '#idvanyphonecollectNext', 'button[type="submit"]']);
      if (sendBtn) await DOM.cdpClickElement(sendBtn);
      await DOM.sleep(900);

      // Check immediate per-number rejection
      const postSendErr = detectGoogleErrorBanner();
      if (postSendErr || (document.body?.innerText || '').toLowerCase().includes('cannot be used for verification')) {
        const reason = postSendErr?.text || 'Phone number rejected by Google';
        await chrome.runtime.sendMessage({ action: 'SMS_POOL_ERROR', phone: claim.item.phone, error: reason });
        continue;
      }

      const codeInput = await DOM.waitForElement('#idvAnyPhonePin, input[name="idvAnyPhonePin"]', 15000);
      if (!codeInput) {
        const errAfterWait = detectGoogleErrorBanner();
        await chrome.runtime.sendMessage({
          action: 'SMS_POOL_ERROR',
          phone: claim.item.phone,
          error: errAfterWait?.text || 'PIN field did not appear'
        });
        continue;
      }

      let codeVerified = false;
      for (let attempt = 0; attempt < 24; attempt++) {
        const otp = await chrome.runtime.sendMessage({ action: 'FETCH_SMS_OTP', url: claim.item.url });
        if (otp?.ok && otp.code) {
          await DOM.typeOrganic(codeInput, otp.code, { useCdp: true, clear: true });
          const verifyBtn = queryFirst(['#idvanyphoneverifyNext button', '#idvanyphoneverifyNext', 'button[type="submit"]']);
          if (verifyBtn) await DOM.cdpClickElement(verifyBtn);
          await DOM.sleep(1000);

          const pinErr = detectGoogleErrorBanner();
          if (pinErr && /wrong|incorrect|invalid/i.test(pinErr.text)) {
            await chrome.runtime.sendMessage({ action: 'SMS_POOL_ERROR', phone: claim.item.phone, error: pinErr.text });
            break;
          }
          await chrome.runtime.sendMessage({ action: 'SMS_POOL_VERIFY', phone: claim.item.phone });
          codeVerified = true;
          break;
        }
        await DOM.sleep(2500);
      }
      if (codeVerified) return 'acted';
      await chrome.runtime.sendMessage({ action: 'SMS_POOL_ERROR', phone: claim.item.phone, error: 'OTP timeout' });
    }
    return 'abort';
  }

  async function dismissPostLoginPrompts() {
    const skipTexts = ['not now', 'skip', 'no, thanks', 'confirm', 'continue', 'done', 'remind me later', "i'll do it later"];
    const buttons = document.querySelectorAll('button, a[role="button"]');
    for (const btn of buttons) {
      if (!DOM.isElementVisible(btn)) continue;
      const txt = (btn.innerText || '').trim().toLowerCase();
      if (skipTexts.includes(txt)) {
        await DOM.cdpClickElement(btn);
        await DOM.sleep(800);
        return true;
      }
    }
    return false;
  }

  async function runGoogleFlow(account, settings) {
    const state = { totpAttempts: 0, lastTotpCode: '' };
    let emailSubmitted = false;
    let passSubmitted = false;

    for (let step = 0; step < 36; step++) {
      // Check visible inbox trigger (ignoring hidden multi-stage mock containers)
      if (queryFirst(['div[gh="cm"]', '[role="button"][gh="cm"]'])) {
        await chrome.runtime.sendMessage({ action: 'INBOX_READY', email: account.email, provider: 'gmail' }).catch(() => {});
        return;
      }

      if (detectCaptcha()) {
        const solved = await waitWhileCaptcha(account, settings);
        if (!solved) return;
        continue;
      }

      // Handle 2FA TOTP first so retry logic catches wrong-code errors cleanly
      const totpOutcome = await handleGoogleTotp(account, settings, state);
      if (totpOutcome === 'abort') return;
      if (totpOutcome === 'acted') continue;

      const err = detectGoogleErrorBanner();
      if (err) {
        await reportError(account, err.text, err.tier);
        return;
      }

      const emailEl = queryFirst(['#identifierId', 'input[type="email"]']);
      if (emailEl && !emailSubmitted) {
        await DOM.typeOrganic(emailEl, account.email, { useCdp: true, clear: true });
        emailSubmitted = true;
        const next = queryFirst(['#identifierNext button', '#identifierNext', 'button[type="submit"]']);
        if (next) await DOM.cdpClickElement(next);
        await DOM.sleep(1000);
        continue;
      }

      const passEl = queryFirst(['input[type="password"][name="Passwd"]', 'input[type="password"]']);
      if (passEl && !passSubmitted) {
        await DOM.typeOrganic(passEl, account.password, { useCdp: true, clear: true });
        passSubmitted = true;
        const next = queryFirst(['#passwordNext button', '#passwordNext', 'button[type="submit"]']);
        if (next) await DOM.cdpClickElement(next);
        await DOM.sleep(1000);
        continue;
      }

      if (await handleRecoveryEmail(account)) continue;

      const smsOutcome = await handleSmsPhoneChallenge(account);
      if (smsOutcome === 'abort') return;
      if (smsOutcome === 'acted') continue;

      const authChallengeChoice = queryFirst(['[data-challengetype="6"]', '[data-challengetype="12"]', '[data-challengetype="9"]']);
      if (authChallengeChoice) {
        await DOM.cdpClickElement(authChallengeChoice);
        await DOM.sleep(900);
        continue;
      }

      if (await dismissPostLoginPrompts()) continue;
      await DOM.sleep(1000);
    }
  }

  async function runOutlookFlow(account) {
    let emailDone = false;
    let passDone = false;
    for (let step = 0; step < 24; step++) {
      const errEl = queryFirst(['#usernameError', '#passwordError', '.alert-error']);
      if (errEl && errEl.innerText.trim()) {
        await reportError(account, errEl.innerText.trim(), 'fatal');
        return;
      }
      const userEl = queryFirst(['#i0116', 'input[name="loginfmt"]']);
      if (userEl && !emailDone) {
        await DOM.typeOrganic(userEl, account.email, { useCdp: true, clear: true });
        emailDone = true;
        const next = queryFirst(['#idSIButton9', 'input[type="submit"]']);
        if (next) await DOM.cdpClickElement(next);
        await DOM.sleep(1000);
        continue;
      }
      const passEl = queryFirst(['#i0118', 'input[name="passwd"]']);
      if (passEl && !passDone) {
        await DOM.typeOrganic(passEl, account.password, { useCdp: true, clear: true });
        passDone = true;
        const signIn = queryFirst(['#idSIButton9', 'input[type="submit"]']);
        if (signIn) await DOM.cdpClickElement(signIn);
        await DOM.sleep(1000);
        continue;
      }
      const otcEl = queryFirst(['#idTxtBx_SAOTCC_OTC', 'input[name="otc"]']);
      if (otcEl && account.twoFa) {
        const code = await TOTP.generateTOTP(account.twoFa);
        await DOM.typeOrganic(otcEl, code, { useCdp: true, clear: true });
        const verifyBtn = queryFirst(['#idSubmit_SAOTCC_Continue', 'input[type="submit"]']);
        if (verifyBtn) await DOM.cdpClickElement(verifyBtn);
        await DOM.sleep(1000);
        continue;
      }
      if (!userEl && !passEl && !otcEl) {
        const staySignedIn = queryFirst(['#idSIButton9', '#acceptButton']);
        if (staySignedIn) {
          await DOM.cdpClickElement(staySignedIn);
          await DOM.sleep(900);
          continue;
        }
      }
      await DOM.sleep(700);
    }
  }

  async function runYahooFlow(account) {
    let userDone = false;
    let passDone = false;
    for (let step = 0; step < 24; step++) {
      const errEl = queryFirst(['.error-msg', '.error-txt', '[data-error="true"]']);
      if (errEl && errEl.innerText.trim()) {
        await reportError(account, errEl.innerText.trim(), 'fatal');
        return;
      }
      const userEl = queryFirst(['#login-username']);
      if (userEl && !userDone) {
        await DOM.typeOrganic(userEl, account.email, { useCdp: true, clear: true });
        userDone = true;
        const next = queryFirst(['#login-signin', 'button[type="submit"]']);
        if (next) await DOM.cdpClickElement(next);
        await DOM.sleep(1000);
        continue;
      }
      const passEl = queryFirst(['#login-passwd']);
      if (passEl && !passDone) {
        await DOM.typeOrganic(passEl, account.password, { useCdp: true, clear: true });
        passDone = true;
        const next = queryFirst(['#login-signin', 'button[type="submit"]']);
        if (next) await DOM.cdpClickElement(next);
        await DOM.sleep(1000);
        continue;
      }
      if (await dismissPostLoginPrompts()) continue;
      await DOM.sleep(700);
    }
  }

  async function bootstrap() {
    if (await handleBootstrapHandoff()) return;
    if (isControllerPage()) return;
    if (active) return;
    active = true;

    const resolved = await resolvePendingAccount();
    if (!resolved) {
      active = false;
      return;
    }

    const { account, settings } = resolved;
    const host = window.location.hostname.toLowerCase();
    if (host.includes('live.com') || host.includes('microsoftonline.com')) {
      await runOutlookFlow(account, settings);
    } else if (host.includes('yahoo.com')) {
      await runYahooFlow(account, settings);
    } else if (host.includes('google.com') || document.querySelector('#identifierId, #totpPin, #knowledge-preregistered-email-response, #phoneNumberId, iframe[src*="recaptcha"]')) {
      await runGoogleFlow(account, settings);
    }
  }

  // Re-run cleanly on SPA history navigations if driver finished earlier step
  window.addEventListener('popstate', () => { active = false; setTimeout(bootstrap, 300); });
  window.addEventListener('hashchange', () => { active = false; setTimeout(bootstrap, 300); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
