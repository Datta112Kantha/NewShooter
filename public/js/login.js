(function () {
  'use strict';

  const form = document.getElementById('loginForm');
  const usrInput = document.getElementById('usr');
  const pasInput = document.getElementById('pas');
  const csrfInput = document.getElementById('csrfToken');
  const loginBtn = document.getElementById('loginButton');
  const togglePassBtn = document.getElementById('togglePass');
  const errorBox = document.getElementById('loginError');
  const limitBox = document.getElementById('limitBox');
  const limitRatio = document.getElementById('limitRatio');
  const limitList = document.getElementById('limitList');
  const limitGo = document.getElementById('limitGo');
  const limitCancel = document.getElementById('limitCancel');

  const vid = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()));
  const fp = btoa([navigator.language, screen.width + 'x' + screen.height, navigator.hardwareConcurrency || 4].join('|'));

  // Send telemetry beacon just like 2223.tech /V3/vt/c
  fetch('/V3/vt/c', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vid,
      fp,
      c: {
        screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        lang: navigator.language || 'en-US',
        cores: navigator.hardwareConcurrency || 4,
        webdriver: navigator.webdriver ? 1 : 0
      },
      p: '/Login.php'
    })
  }).then((r) => r.text()).catch(() => {});

  fetch('/api/auth/csrf')
    .then((r) => r.json())
    .then((d) => { if (d.csrfToken) csrfInput.value = d.csrfToken; })
    .catch(() => {});

  togglePassBtn.addEventListener('click', () => {
    const isPass = pasInput.type === 'password';
    pasInput.type = isPass ? 'text' : 'password';
    togglePassBtn.setAttribute('aria-pressed', String(isPass));
    togglePassBtn.setAttribute('aria-label', isPass ? 'Hide password' : 'Show password');
  });

  async function submitLogin(forceEvict) {
    errorBox.hidden = true;
    limitBox.hidden = true;
    loginBtn.disabled = true;

    const params = new URLSearchParams();
    params.set('usr', usrInput.value.trim());
    params.set('pas', pasInput.value);
    params.set('csrf_token', csrfInput.value);
    params.set('submit', 'true');
    params.set('vt_id', vid);
    params.set('vt_fp', fp);
    if (forceEvict) params.set('force_evict', '1');

    try {
      const resp = await fetch('/Login.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.status === 'ok') {
        window.location.href = data.redirect || '/V3/';
        return;
      }
      if (data.status === 'limit') {
        limitRatio.textContent = `${data.activeDevices.length}/${data.limit}`;
        limitList.textContent = '';
        for (const dev of data.activeDevices) {
          const li = document.createElement('li');
          li.textContent = dev.label + (dev.willSignOut ? ' — will be signed out' : '');
          limitList.appendChild(li);
        }
        limitBox.hidden = false;
        limitGo.focus();
        return;
      }
      if (data.csrfToken) {
        csrfInput.value = data.csrfToken;
      }
      const errMsg = data.error || data.message || 'Authentication failed';
      errorBox.textContent = errMsg;
      errorBox.hidden = false;
    } catch (err) {
      errorBox.textContent = 'Network error: ' + err.message;
      errorBox.hidden = false;
    } finally {
      loginBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitLogin(false);
  });

  limitGo.addEventListener('click', () => {
    submitLogin(true);
  });

  limitCancel.addEventListener('click', () => {
    limitBox.hidden = true;
    pasInput.focus();
  });
})();
