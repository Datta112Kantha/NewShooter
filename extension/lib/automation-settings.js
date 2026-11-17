(function (g) {
  'use strict';

  const DEFAULTS = {
    notifyOnCaptcha: true,
    closeOnCaptcha: false,
    disableTabCloseOnError: false,
    captchaTimeoutSec: 300,
    typingSpeed: 'normal',
    humanizeTyping: true,
    totpMaxRetries: 3,
    wsUrl: 'ws://127.0.0.1:8080',
    standaloneProxy: ''
  };

  const PROFILES = {
    slow: { base: 90, variation: 60, backspaceBase: 35, backspaceVariation: 25, pauseBase: 150, pauseVariation: 100 },
    normal: { base: 40, variation: 30, backspaceBase: 20, backspaceVariation: 15, pauseBase: 80, pauseVariation: 50 },
    fast: { base: 15, variation: 15, backspaceBase: 8, backspaceVariation: 7, pauseBase: 30, pauseVariation: 20 },
    instant: { base: 0, variation: 0, backspaceBase: 0, backspaceVariation: 0, pauseBase: 0, pauseVariation: 0 }
  };

  const STORAGE_KEY = 'automationSettings';

  function load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          resolve({ ...DEFAULTS, ...(res && res[STORAGE_KEY]) });
        });
      } catch {
        resolve({ ...DEFAULTS });
      }
    });
  }

  function save(partial) {
    return load().then((cur) => {
      const next = { ...DEFAULTS, ...cur, ...partial };
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [STORAGE_KEY]: next }, () => resolve(next));
        } catch {
          resolve(next);
        }
      });
    });
  }

  function reset() {
    return new Promise((resolve) => {
      const next = { ...DEFAULTS };
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: next }, () => resolve(next));
      } catch {
        resolve(next);
      }
    });
  }

  function getTypingProfile(settings) {
    const merged = { ...DEFAULTS, ...settings };
    const p = PROFILES[merged.typingSpeed] || PROFILES.normal;
    if (merged.humanizeTyping) return { ...p };
    return { base: p.base, variation: 0, backspaceBase: p.backspaceBase, backspaceVariation: 0, pauseBase: p.pauseBase, pauseVariation: 0 };
  }

  g.AutomationSettings = {
    STORAGE_KEY,
    DEFAULTS,
    TYPING_PROFILES: PROFILES,
    load,
    save,
    reset,
    getTypingProfile
  };
})(typeof self !== 'undefined' ? self : this);
