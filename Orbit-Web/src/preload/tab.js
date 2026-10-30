'use strict';
// Preload for every tab. Runs isolated from the page's own scripts (contextIsolation).
// On aphelion:// pages it exposes the internal-page API; on websites it provides the
// browser features that need the page DOM. It never exposes anything to websites.
const { contextBridge, ipcRenderer } = require('electron');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');

if (location.protocol === 'aphelion:') {
  contextBridge.exposeInMainWorld('aphelion', {
    call: (name, ...args) => ipcRenderer.invoke(`page:${name}`, ...args),
    on: (name, cb) => ipcRenderer.on('aph:event', (_e, n, payload) => n === name && cb(payload)),
  });
} else {
  quietPasskeys();
  content();
}

// Sites such as Google and GitHub ask for passkeys in the background ("conditional
// mediation", meant to feed the password-field autofill). Chrome answers that silently;
// in Aphelion it would open the Windows Security key dialog at random moments. Report
// that background passkey autofill is not available; passkeys still work when a site
// asks for one because you clicked "Use a passkey" or "Use security key".
function quietPasskeys() {
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        const PKC = window.PublicKeyCredential;
        if (PKC) PKC.isConditionalMediationAvailable = () => Promise.resolve(false);
        const creds = navigator.credentials;
        if (!creds?.get) return;
        const get = creds.get.bind(creds);
        creds.get = function (options) {
          if (options && options.mediation === 'conditional') {
            return Promise.reject(new DOMException('Passkey autofill is not available', 'NotSupportedError'));
          }
          return get(options);
        };
      },
    });
  } catch {
    /* older Electron without executeInMainWorld: nothing to patch */
  }
}

function content() {
  let options = {};
  const styleEls = {};

  function setStyle(key, css) {
    if (!css) {
      styleEls[key]?.remove();
      delete styleEls[key];
      return;
    }
    if (!styleEls[key]) {
      styleEls[key] = document.createElement('style');
      styleEls[key].dataset.aphelion = key;
      (document.head || document.documentElement).appendChild(styleEls[key]);
    }
    styleEls[key].textContent = css;
  }

  // ---- page options (dark pages, caret, contrast, motion, login capture) ----
  ipcRenderer.on('aph:page-options', (_e, opts) => {
    options = opts;
    applyDark();
    setStyle('motion', opts.motion ? '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}' : '');
    setStyle('contrast', opts.contrast ? 'a{text-decoration:underline!important} :focus-visible{outline:3px solid #ededf0!important;outline-offset:2px!important}' : '');
    setCaret(opts.caret);
    if (opts.autofill) ipcRenderer.send('aph:autofill-request');
  });

  function luminance(rgb) {
    const m = rgb.match(/\d+(\.\d+)?/g);
    if (!m) return 1;
    const [r, g, b, a] = m.map(Number);
    if (a === 0) return 1;  // transparent: assume the default white
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function applyDark() {
    if (!options.dark || !document.body) return setStyle('dark', '');
    const bg = getComputedStyle(document.body).backgroundColor;
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    const isDark = Math.min(luminance(bg), luminance(htmlBg)) < 0.35;
    if (isDark) return setStyle('dark', '');   // already dark: leave it alone
    setStyle('dark', 'html{filter:invert(.9) hue-rotate(180deg)!important;background:#fff!important}' +
      'img,video,picture,canvas,iframe,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}');
  }

  // ---- caret browsing: move through the page with a text cursor (F7 toggles) ----
  function blockEdit(e) {
    e.preventDefault();
  }
  function setCaret(on) {
    if (!document.body) return;
    if (on) {
      document.body.setAttribute('contenteditable', 'true');
      document.body.dataset.aphCaret = '1';
      document.addEventListener('beforeinput', blockEdit, true);
      document.addEventListener('paste', blockEdit, true);
      document.addEventListener('drop', blockEdit, true);
    } else if (document.body.dataset.aphCaret) {
      document.body.removeAttribute('contenteditable');
      delete document.body.dataset.aphCaret;
      document.removeEventListener('beforeinput', blockEdit, true);
      document.removeEventListener('paste', blockEdit, true);
      document.removeEventListener('drop', blockEdit, true);
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F7') ipcRenderer.send('aph:caret-key');
  }, true);

  // ---- KeePass fill ----
  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }
  function setValue(el, v) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, v) : (el.value = v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function userFieldFor(pw) {
    const fields = [...(pw.form || document).querySelectorAll('input')].filter(visible);
    const i = fields.indexOf(pw);
    for (let j = i - 1; j >= 0; j--) {
      const t = (fields[j].type || 'text').toLowerCase();
      if (['text', 'email', 'tel', ''].includes(t) || fields[j].autocomplete === 'username') return fields[j];
    }
    return document.querySelector('input[autocomplete="username"],input[type="email"]');
  }
  ipcRenderer.on('aph:fill', (_e, { user, password }) => {
    const pw = [...document.querySelectorAll('input[type="password"]')].find(visible);
    const u = pw ? userFieldFor(pw) : document.querySelector('input[autocomplete="username"],input[type="email"],input[name*="user" i]');
    if (u && user) setValue(u, user);
    if (pw && password) setValue(pw, password);
    (pw || u)?.focus();
  });

  // ---- offer to save logins (only what the user just typed into a password form) ----
  function captureLogin(form) {
    const pw = [...form.querySelectorAll('input[type="password"]')].find((p) => p.value);
    if (!pw) return;
    const u = userFieldFor(pw);
    ipcRenderer.send('aph:login-submitted', { user: u?.value || '', password: pw.value });
  }
  document.addEventListener('submit', (e) => options.capture && e.target instanceof HTMLFormElement && captureLogin(e.target), true);

  // ---- element picker: hover to highlight, click to hide, Esc to cancel ----
  ipcRenderer.on('aph:picker', () => {
    const host = document.createElement('aphelion-picker');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>.box{position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ededf0;' +
      'background:rgba(237,237,240,.18);border-radius:6px;transition:all 80ms}.tip{position:fixed;left:50%;top:16px;' +
      'transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:10px;background:rgba(61,61,68,.94);' +
      'color:#f4f4f6;font:13px Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.4)}</style>' +
      '<div class="box"></div><div class="tip">Click the element to hide · Esc to cancel</div>';
    document.documentElement.appendChild(host);
    const box = shadow.querySelector('.box');
    let target = null;
    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === host || el === document.body || el === document.documentElement) return;
      target = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const stop = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      host.remove();
    };
    const click = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target) ipcRenderer.send('aph:picked', selectorFor(target));
      stop();
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stop();
      }
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  });

  function selectorFor(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 6) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !/\d{3,}/.test(c)).slice(0, 2);
      if (cls.length) part += `.${cls.join('.')}`;
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ---- media controls ----
  ipcRenderer.on('aph:media', (_e, act) => {
    const media = [...document.querySelectorAll('video,audio')];
    const playing = media.find((m) => !m.paused) || media[0];
    if (!playing) return;
    if (act === 'toggle') playing.paused ? playing.play().catch(() => {}) : playing.pause();
    if (act === 'pause') media.forEach((m) => m.pause());
    if (act === 'prev') playing.currentTime = playing.currentTime > 3 ? 0 : Math.max(0, playing.currentTime - 10);
    if (act === 'next') {
      // ask the site's own "next" (YouTube & most players listen for Shift+N / media key)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', shiftKey: true, bubbles: true }));
      if (isFinite(playing.duration)) playing.currentTime = Math.min(playing.duration - 0.5, playing.currentTime + 10);
    }
  });

  // ---- reader view + page language ----
  ipcRenderer.on('aph:ask', (_e, id, what) => {
    if (what !== 'reader') return;
    let data = null;
    try {
      const art = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
      if (art) data = { title: art.title, byline: art.byline, site: art.siteName || location.hostname, content: art.content,
                        length: art.length, lang: document.documentElement.lang || '' };
    } catch {
      data = null;
    }
    ipcRenderer.send('aph:tab-reply', id, data);
  });

  window.addEventListener('DOMContentLoaded', () => {
    applyDark();
    if (options.caret) setCaret(true);
    setTimeout(() => {
      try {
        ipcRenderer.send('aph:article', isProbablyReaderable(document));
      } catch {
        /* ignore */
      }
      ipcRenderer.send('aph:lang', document.documentElement.lang || '');
    }, 800);
  });
}
