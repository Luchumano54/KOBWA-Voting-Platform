'use strict';
/* KOBWA VOTING PLATFORM front end. Talks to the Flask API in /api/*; holds no business rules of its own.
   All DOM is built with h() (createElement + textContent), never innerHTML, so names, bios and
   audit details typed by users can never execute as markup. */
(() => {
  // ------------------------------------------------------------------ DOM helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  let uid = 0;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'for') el.htmlFor = v;
      else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role') el.setAttribute(k, v === true ? '' : v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const icon = (name, cls = 'w-4 h-4') => h('i', { 'data-lucide': name, class: cls });
  const refreshIcons = () => { if (window.lucide) window.lucide.createIcons(); };
  const clear = (el) => { el.replaceChildren(); return el; };
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const GRADIENTS = [
    'from-brand-600 to-indigo-600', 'from-emerald-600 to-teal-600', 'from-amber-500 to-orange-600',
    'from-fuchsia-600 to-purple-600', 'from-rose-600 to-pink-600', 'from-cyan-600 to-sky-600',
  ];
  function hashStr(s) { let x = 0; for (const ch of s) x = (x * 31 + ch.codePointAt(0)) >>> 0; return x; }
  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function avatar(name, imageUrl, sizeClass, textClass) {
    const fallback = () => h('div', {
      class: `${sizeClass} bg-gradient-to-br ${GRADIENTS[hashStr(name) % GRADIENTS.length]} flex items-center justify-center text-white font-extrabold ${textClass}`,
      role: 'img', 'aria-label': name,
    }, initials(name));
    if (!imageUrl) return fallback();
    const wrap = h('div', { class: `${sizeClass} overflow-hidden bg-slate-950` });
    wrap.append(h('img', { src: imageUrl, alt: name, loading: 'lazy', class: 'w-full h-full object-cover', on: { error: () => wrap.replaceWith(fallback()) } }));
    return wrap;
  }

  const INPUT = 'w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-500';
  const BTN_PRIMARY = 'px-4 py-2 bg-brand-600 hover:bg-brand-500 rounded-xl text-sm font-medium text-white shadow-lg shadow-brand-600/20 transition disabled:opacity-60';
  const BTN_GHOST = 'px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-sm font-medium text-slate-300 transition disabled:opacity-60';
  const BTN_DANGER = 'px-4 py-2 bg-red-600 hover:bg-red-500 rounded-xl text-sm font-medium text-white transition disabled:opacity-60';

  function field(label, control, hint) {
    if (!control.id) control.id = `f${++uid}`;
    return h('div', null,
      h('label', { for: control.id, class: 'block text-xs font-semibold text-slate-300 mb-1' }, label),
      control,
      hint && h('p', { class: 'text-[11px] text-slate-400 mt-1.5' }, hint));
  }
  const formError = () => h('p', { class: 'hidden text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2', role: 'alert' });
  function showInline(el, message) { el.textContent = message; el.classList.remove('hidden'); }
  async function busy(button, task) {
    button.disabled = true;
    try { return await task(); } finally { button.disabled = false; }
  }

  // ---------------------------------------------------------------------- toasts
  function toast(message, type = 'info') {
    const colors = { error: 'bg-red-600', success: 'bg-emerald-600', info: 'bg-brand-600' };
    const el = h('div', {
      class: `${colors[type] || colors.info} text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-xl flex items-center space-x-2 pointer-events-auto transition-all duration-300 opacity-0 translate-y-2`,
    }, icon(type === 'error' ? 'alert-circle' : 'check-circle'), h('span', null, message));
    $('#toast-container').append(el);
    refreshIcons();
    setTimeout(() => el.classList.remove('opacity-0', 'translate-y-2'), 10);
    setTimeout(() => { el.classList.add('opacity-0', 'translate-y-2'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 5000 : 3000);
  }

  // ---------------------------------------------------------------------- modals
  const modalStack = [];
  function openModal({ title, wide = false, build, onClose }) {
    const previous = document.activeElement;
    const titleId = `modal-title-${++uid}`;
    const body = h('div', { class: 'p-6' });
    const dialog = h('div', {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
      class: `bg-slate-900 border border-slate-800 rounded-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-hidden shadow-2xl animate-fade-in max-h-[90vh] flex flex-col`,
    },
      h('div', { class: 'px-6 py-4 border-b border-slate-800 flex items-center justify-between' },
        h('h3', { id: titleId, class: 'text-lg font-bold text-white' }, title),
        h('button', { type: 'button', 'aria-label': 'Close', class: 'text-slate-400 hover:text-white', on: { click: () => close() } }, icon('x', 'w-5 h-5'))),
      h('div', { class: 'overflow-y-auto' }, body));
    const overlay = h('div', {
      class: 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm',
      on: { mousedown: (e) => { if (e.target === overlay) close(); } },
    }, dialog);
    const handle = { close };

    function onKey(e) {
      if (modalStack[modalStack.length - 1] !== handle) return;
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Tab') {
        const items = [...dialog.querySelectorAll('button, input, select, textarea, a[href]')].filter((n) => !n.disabled && n.offsetParent !== null);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    function close() {
      const i = modalStack.indexOf(handle);
      if (i === -1) return;
      modalStack.splice(i, 1);
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (previous && previous.focus) previous.focus();
      if (onClose) onClose();
    }

    modalStack.push(handle);
    document.addEventListener('keydown', onKey);
    build(body, close);
    $('#modal-root').append(overlay);
    refreshIcons();
    const target = dialog.querySelector('input:not([type=hidden]), select, textarea') || dialog.querySelector('button:not([aria-label="Close"])') || dialog;
    target.focus();
    return handle;
  }
  function closeAllModals() { [...modalStack].forEach((m) => m.close()); }

  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      openModal({
        title, onClose: () => done(false),
        build(body, close) {
          body.append(
            h('p', { class: 'text-sm text-slate-300 leading-relaxed' }, message),
            h('div', { class: 'pt-6 flex justify-end space-x-3' },
              h('button', { type: 'button', class: BTN_GHOST, on: { click: () => close() } }, 'Cancel'),
              h('button', { type: 'button', class: danger ? BTN_DANGER : BTN_PRIMARY, on: { click: () => { done(true); close(); } } }, confirmLabel)));
        },
      });
    });
  }

  // ------------------------------------------------------------------------- API
  class ApiError extends Error {
    constructor(status, message, data) { super(message); this.status = status; this.data = data || {}; }
  }

  const state = {
    user: null, settings: { results_public: true }, categories: [],
    view: 'voter', voterCat: null, resultsCat: null, results: null, resultsKey: '',
    selection: new Map(), poll: null, peopleQuery: '',
    admin: { tab: 'categories', categories: [], eligible: 0, users: [], userFilter: '',
      audit: { items: [], total: 0, page: 1, per_page: 25, q: '' }, verify: null },
    bigScreen: {
      active: false, autoRotate: true, rotateIntervalSec: 12, countdownSec: 12,
      catIndex: 0, pollTimer: null, clockTimer: null, previousView: 'results',
      showSettings: false,
      theme: (function() { try { return localStorage.getItem('bigscreen_theme') || 'dark'; } catch { return 'dark'; } })(),
    },
  };

  async function api(path, { method = 'GET', json, form } = {}) {
    const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
    if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (form) opts.body = form;
    let res;
    try { res = await fetch(path, opts); }
    catch { throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.user && path !== '/api/auth/login') sessionExpired();
      if (res.status === 403 && data.code === 'password_change_required') showForcedPassword();
      throw new ApiError(res.status, data.error || 'The request failed.', data);
    }
    return data;
  }

  function resetState() {
    stopPolling();
    stopBigScreenTimers();
    closeAllModals();
    clear($('#toast-container'));
    state.user = null; state.categories = []; state.results = null; state.resultsKey = '';
    state.selection.clear(); state.peopleQuery = ''; state.view = 'voter'; state.voterCat = null; state.resultsCat = null;
    state.bigScreen.active = false;
    Object.assign(state.admin, { tab: 'categories', categories: [], users: [], verify: null, userFilter: '' });
    Object.assign(state.admin.audit, { items: [], total: 0, page: 1, q: '' });
  }
  function sessionExpired() {
    resetState();
    showScreen('login');
    toast('Your session has ended. Sign in again to continue.', 'error');
  }

  // ------------------------------------------------------------- screens and auth
  function showScreen(name) {
    for (const [key, id] of [['boot', 'screen-boot'], ['login', 'screen-login'], ['password', 'screen-password'], ['app', 'app'], ['bigscreen', 'screen-bigscreen']]) {
      const el = $('#' + id);
      if (el) el.classList.toggle('hidden', key !== name);
    }
    refreshIcons();
    if (name === 'login') $('#login-email').focus();
  }

  function passwordForm({ forced, onDone }) {
    const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, class: INPUT });
    const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10, class: INPUT });
    const repeat = h('input', { type: 'password', autocomplete: 'new-password', required: true, class: INPUT });
    const error = formError();
    const submit = h('button', { type: 'submit', class: `${BTN_PRIMARY} ${forced ? 'w-full' : ''}` }, forced ? 'Save password and continue' : 'Change password');
    const form = h('form', {
      class: 'space-y-4',
      on: {
        submit: async (e) => {
          e.preventDefault();
          error.classList.add('hidden');
          if (next.value !== repeat.value) return showInline(error, 'The two new passwords do not match.');
          try {
            const { user } = await busy(submit, () => api('/api/auth/change-password', { method: 'POST', json: { current_password: current.value, new_password: next.value } }));
            onDone(user);
          } catch (ex) { showInline(error, ex.message); }
        },
      },
    },
      field(forced ? 'Temporary password' : 'Current password', current),
      field('New password', next, 'At least 10 characters. Avoid your email address or anything easy to guess.'),
      field('Repeat new password', repeat),
      error,
      forced ? submit : h('div', { class: 'pt-2 flex justify-end' }, submit));
    return form;
  }

  function showForcedPassword() {
    const card = clear($('#forced-password-card'));
    card.append(
      h('h1', { class: 'text-lg font-bold text-white' }, 'Choose your own password'),
      h('p', { class: 'text-sm text-slate-400 mt-1 mb-5' }, 'Your administrator gave you a temporary password. Set a new one to continue.'),
      passwordForm({ forced: true, onDone: async (user) => { state.user = user; toast('Password updated.', 'success'); await enterApp(); } }));
    showScreen('password');
  }

  async function afterSignIn(user) {
    state.user = user;
    if (user.must_change_password) return showForcedPassword();
    return enterApp();
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
    resetState();
    showScreen('login');
  }

  async function loadBootstrap() {
    const data = await api('/api/bootstrap');
    state.user = data.user;
    state.settings = data.settings;
    state.categories = data.categories;
  }

  async function enterApp() {
    await loadBootstrap();
    $('#user-name').textContent = state.user.name;
    $('#user-role').textContent = state.user.role === 'admin' ? 'Administrator' : 'Voter';
    showScreen('app');
    await switchView('voter');
  }

  // ------------------------------------------------------------------ navigation
  function navItems() {
    const items = [
      { id: 'voter', label: 'Voting portal', short: 'Vote', icon: 'vote' },
      { id: 'results', label: 'Live results', short: 'Results', icon: 'trophy' },
    ];
    if (state.user && state.user.role === 'admin') items.push({ id: 'admin', label: 'Back-office admin', short: 'Admin', icon: 'shield-check' });
    return items;
  }
  function renderNav() {
    const desktop = clear($('#nav-desktop')), mobile = clear($('#nav-mobile'));
    for (const it of navItems()) {
      const on = state.view === it.id;
      const go = { click: () => switchView(it.id) };
      desktop.append(h('button', {
        type: 'button', 'aria-current': on ? 'page' : null, on: go,
        class: on ? 'flex items-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white shadow-lg shadow-brand-600/20'
                  : 'flex items-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-900',
      }, icon(it.icon), h('span', null, it.label)));
      mobile.append(h('button', {
        type: 'button', 'aria-current': on ? 'page' : null, on: go,
        class: on ? 'flex flex-col items-center py-1 px-3 text-xs font-medium text-brand-400' : 'flex flex-col items-center py-1 px-3 text-xs font-medium text-slate-400',
      }, icon(it.icon, 'w-5 h-5 mb-1'), h('span', null, it.short)));
    }
    refreshIcons();
  }

  async function switchView(view) {
    state.view = view;
    stopPolling();
    for (const v of ['voter', 'results', 'admin']) $('#view-' + v).classList.toggle('hidden', v !== view);
    renderNav();
    try {
      if (view === 'voter') { await loadBootstrap(); if (state.view === view) renderVoter(); }
      else if (view === 'results') { await loadResults(); if (state.view === view) { renderResults({ animate: true }); startPolling(); } }
      else { await loadAdminTab(); if (state.view === view) renderAdmin(); }
    } catch (ex) { if (ex.status !== 401) toast(ex.message, 'error'); }
  }

  // ----------------------------------------------------------------- voting portal
  const choiceKey = (catId) => `apex:choice:${state.user.id}:${catId}`;
  function saveChoice(catId, ids) { try { localStorage.setItem(choiceKey(catId), JSON.stringify(ids)); } catch { /* private mode */ } }
  function loadChoice(catId) { try { return JSON.parse(localStorage.getItem(choiceKey(catId))) || []; } catch { return []; } }

  function emptyPanel(iconName, title, text) {
    return h('div', { class: 'glass-panel rounded-2xl py-12 px-6 text-center' },
      icon(iconName, 'w-10 h-10 mx-auto text-slate-600 mb-3'),
      h('p', { class: 'text-slate-200 text-sm font-semibold' }, title),
      text && h('p', { class: 'text-slate-400 text-sm mt-1' }, text));
  }

  function renderVoter() {
    const root = clear($('#view-voter'));
    const cats = state.categories;
    root.append(h('div', { class: 'relative overflow-hidden rounded-3xl bg-gradient-to-r from-brand-900/60 via-indigo-900/40 to-slate-900 border border-slate-800 p-6 sm:p-10' },
      h('div', { class: 'relative z-10 max-w-2xl' },
        h('h2', { class: 'text-2xl sm:text-4xl font-extrabold text-white tracking-tight' }, 'Cast your vote for excellence'),
        h('p', { class: 'mt-2 text-slate-300 text-sm sm:text-base leading-relaxed' },
          'Recognize outstanding contributions across the organization. Each ballot is final and your choice is kept private.')),
      h('div', { class: 'hidden sm:flex absolute right-6 md:right-10 top-1/2 -translate-y-1/2 p-2.5 bg-white rounded-2xl shadow-xl shadow-brand-950/40 border border-white/20 items-center justify-center' },
        h('img', { src: '/static/img/kobwa-logo.png', alt: 'KOBWA Logo', class: 'h-14 md:h-16 w-auto object-contain' })),
      h('div', { class: 'absolute -right-10 -bottom-10 w-64 h-64 bg-brand-500/10 rounded-full blur-3xl pointer-events-none' })));

    if (!cats.length) {
      root.append(emptyPanel('users', 'No categories yet', 'Voting categories will appear here once an administrator sets them up.'));
      return refreshIcons();
    }
    if (!cats.some((c) => c.id === state.voterCat)) state.voterCat = cats[0].id;

    root.append(h('div', { class: 'flex items-center gap-2 overflow-x-auto pb-2 border-b border-slate-800/80' },
      cats.map((c) => h('button', {
        type: 'button', 'aria-pressed': c.id === state.voterCat ? 'true' : 'false',
        on: { click: () => { state.voterCat = c.id; state.peopleQuery = ''; renderVoter(); } },
        class: c.id === state.voterCat
          ? 'px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold whitespace-nowrap transition duration-200 bg-brand-600 text-white shadow-lg shadow-brand-600/20 flex items-center gap-1.5'
          : 'px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold whitespace-nowrap transition duration-200 bg-slate-900 hover:bg-slate-800 text-slate-400 border border-slate-800 flex items-center gap-1.5',
      }, c.title, c.has_voted && icon('check-circle', 'w-3.5 h-3.5')))));
    root.append(h('div', { id: 'voter-body' }));
    renderVoterBody();
  }

  function renderVoterBody() {
    const body = clear($('#voter-body'));
    const cat = state.categories.find((c) => c.id === state.voterCat);
    if (!cat) return;
    const picked = cat.has_voted ? loadChoice(cat.id) : (state.selection.get(cat.id) || []);

    const status = !cat.active
      ? h('span', { class: 'text-xs font-semibold px-3 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/20 whitespace-nowrap flex-shrink-0' }, 'Voting closed')
      : cat.has_voted
        ? h('span', { class: 'text-xs font-semibold px-3 py-1 rounded-full bg-brand-500/10 text-brand-300 border border-brand-500/30 whitespace-nowrap flex-shrink-0' }, 'Ballot submitted')
        : h('span', { class: 'text-xs font-semibold px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 whitespace-nowrap flex-shrink-0' }, 'Voting open');
    body.append(h('div', { class: 'flex items-start justify-between gap-4 mb-4' },
      h('div', null,
        h('h3', { class: 'text-xl font-bold text-white' }, cat.title),
        h('p', { class: 'text-sm text-slate-400 max-w-2xl' }, cat.description),
        cat.active && !cat.has_voted && cat.max_votes > 1 && h('p', { class: 'text-xs text-brand-300 mt-1' }, `Choose up to ${cat.max_votes} ${cat.mode === 'directory' ? 'people' : 'nominees'}.`)),
      status));

    if (cat.mode === 'directory') return renderDirectoryBody(body, cat, picked);

    if (!cat.nominees.length) {
      body.append(emptyPanel('users', 'No nominees yet', 'Nominees will be listed here once they are added.'));
      return refreshIcons();
    }

    const grid = h('div', { class: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6' });
    for (const nom of cat.nominees) {
      const isPicked = picked.includes(nom.id);
      let action;
      if (!cat.active && !cat.has_voted) action = h('button', { type: 'button', disabled: true, class: 'w-full py-2.5 rounded-xl bg-slate-800 text-slate-500 text-sm font-medium cursor-not-allowed' }, 'Voting closed');
      else if (cat.has_voted) {
        action = isPicked
          ? h('button', { type: 'button', disabled: true, class: 'w-full py-2.5 rounded-xl bg-brand-600/30 text-brand-300 border border-brand-500/40 text-sm font-semibold flex items-center justify-center gap-2' }, icon('check'), 'Your vote')
          : h('button', { type: 'button', disabled: true, class: 'w-full py-2.5 rounded-xl bg-slate-800/60 text-slate-500 text-sm font-medium cursor-not-allowed' }, 'Ballot submitted');
      } else {
        action = h('button', {
          type: 'button', 'aria-pressed': isPicked ? 'true' : 'false', on: { click: () => toggleSelect(cat, nom.id) },
          class: isPicked
            ? 'w-full py-2.5 rounded-xl bg-brand-600 text-white text-sm font-semibold transition flex items-center justify-center gap-2 ring-2 ring-brand-300'
            : 'w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 text-sm font-semibold transition flex items-center justify-center gap-2',
        }, isPicked ? icon('check') : icon('plus'), isPicked ? 'Selected' : `Select ${nom.name.split(' ')[0]}`);
      }
      grid.append(h('div', { class: `glass-panel rounded-2xl overflow-hidden flex flex-col justify-between transition-all duration-300 hover:border-slate-700 ${isPicked ? 'ring-2 ring-brand-500' : ''}` },
        h('div', null,
          h('div', { class: 'relative' },
            avatar(nom.name, nom.image_url, 'h-52 w-full', 'text-5xl'),
            cat.has_voted && isPicked && h('div', { class: 'absolute top-3 right-3 bg-brand-600 text-white text-xs font-bold px-3 py-1 rounded-full shadow-lg flex items-center gap-1' }, icon('check-circle', 'w-3.5 h-3.5'), 'Voted')),
          h('div', { class: 'p-5' },
            h('h4', { class: 'text-lg font-bold text-white mb-2' }, nom.name),
            h('p', { class: 'text-xs text-slate-300 leading-relaxed whitespace-pre-line' }, nom.bio || 'No profile summary provided.'))),
        h('div', { class: 'p-5 pt-0' }, action)));
    }
    body.append(grid);

    if (cat.has_voted && !picked.length) {
      body.append(h('p', { class: 'text-xs text-slate-400 mt-4' }, 'Your ballot is recorded. For privacy the server does not keep which nominee you chose, so it can only be highlighted on the browser you voted from.'));
    }

    const bar = ballotBar(cat);
    if (bar) body.append(bar);
    refreshIcons();
  }

  // Sticky "N of M selected / Cast vote" bar, shared by both category types.
  function ballotBar(cat) {
    const chosen = state.selection.get(cat.id) || [];
    if (!cat.active || cat.has_voted || !chosen.length) return null;
    const names = chosen.map((id) => cat.nominees.find((n) => n.id === id)?.name).filter(Boolean);
    return h('div', { class: 'sticky bottom-20 md:bottom-4 z-30 mt-6 glass-panel rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xl' },
      h('p', { class: 'text-sm text-slate-200' },
        h('span', { class: 'font-semibold text-white' }, `${chosen.length} of ${cat.max_votes} selected: `), names.join(', ')),
      h('div', { class: 'flex gap-2 sm:flex-shrink-0' },
        h('button', { type: 'button', class: BTN_GHOST, on: { click: () => { state.selection.delete(cat.id); renderVoterBody(); } } }, 'Clear'),
        h('button', { type: 'button', class: `${BTN_PRIMARY} flex items-center gap-2`, on: { click: () => castVote(cat, names) } }, icon('vote'), 'Cast vote')));
  }

  // Open-vote category: no curated nominees, the voter searches the staff list and picks a person.
  function renderDirectoryBody(body, cat, picked) {
    if (cat.has_voted) {
      const names = picked.map((id) => cat.nominees.find((n) => n.id === id)?.name).filter(Boolean);
      body.append(h('div', { class: 'glass-panel rounded-2xl p-8 text-center' },
        icon('check-circle', 'w-10 h-10 mx-auto text-brand-400 mb-3'),
        h('p', { class: 'text-white font-semibold' }, 'Your ballot is recorded.'),
        names.length
          ? h('p', { class: 'text-sm text-slate-300 mt-1' }, `You voted for ${names.join(', ')}.`)
          : h('p', { class: 'text-xs text-slate-400 mt-2 max-w-md mx-auto' }, 'For privacy the server does not keep who you chose, so it can only be shown in the browser you voted from.')));
      return refreshIcons();
    }
    if (!cat.active) { body.append(emptyPanel('lock', 'Voting is closed', 'This category is no longer accepting votes.')); return refreshIcons(); }
    if (!cat.nominees.length) { body.append(emptyPanel('users', 'No one to vote for yet', 'People appear here once an administrator adds them to the staff list.')); return refreshIcons(); }

    const LIMIT = 60;
    const list = h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3' });
    const note = h('p', { class: 'text-xs text-slate-400', role: 'status' });
    const fill = () => {
      const q = state.peopleQuery.trim().toLowerCase();
      const matches = cat.nominees.filter((n) => !q || n.name.toLowerCase().includes(q) || (n.bio || '').toLowerCase().includes(q));
      clear(list);
      for (const n of matches.slice(0, LIMIT)) list.append(personRow(cat, n));
      note.textContent = !matches.length ? 'No one matches that search.'
        : matches.length > LIMIT ? `Showing the first ${LIMIT} of ${matches.length} people. Type to narrow the list.`
        : plural(matches.length, 'person', 'people');
      refreshIcons();
    };
    body.append(
      h('input', {
        type: 'search', placeholder: 'Search by name or department', 'aria-label': 'Search the staff list', class: `${INPUT} sm:max-w-sm mb-3`,
        value: state.peopleQuery, on: { input: (e) => { state.peopleQuery = e.target.value; fill(); } },
      }),
      list, h('div', { class: 'mt-3' }, note));
    fill();
    const bar = ballotBar(cat);
    if (bar) body.append(bar);
    refreshIcons();
  }

  function personRow(cat, n) {
    const on = (state.selection.get(cat.id) || []).includes(n.id);
    return h('button', {
      type: 'button', 'aria-pressed': on ? 'true' : 'false', on: { click: () => toggleSelect(cat, n.id) },
      class: on ? 'flex items-center gap-3 p-3 rounded-xl text-left bg-brand-600/20 border border-brand-500 ring-2 ring-brand-500 transition'
                : 'flex items-center gap-3 p-3 rounded-xl text-left bg-slate-900 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 transition',
    },
      avatar(n.name, null, 'w-10 h-10 rounded-full flex-shrink-0', 'text-sm'),
      h('span', { class: 'min-w-0 flex-1' },
        h('span', { class: 'block text-sm font-semibold text-white truncate' }, n.name),
        n.bio && h('span', { class: 'block text-xs text-slate-400 truncate' }, n.bio)),
      on ? icon('check-circle', 'w-5 h-5 text-brand-400 flex-shrink-0') : icon('circle', 'w-5 h-5 text-slate-600 flex-shrink-0'));
  }

  function toggleSelect(cat, nomId) {
    const cur = state.selection.get(cat.id) || [];
    let next;
    if (cur.includes(nomId)) next = cur.filter((x) => x !== nomId);
    else if (cat.max_votes === 1) next = [nomId];
    else if (cur.length >= cat.max_votes) return toast(`You can choose up to ${cat.max_votes} ${cat.mode === 'directory' ? 'people' : 'nominees'} in this category.`, 'error');
    else next = [...cur, nomId];
    state.selection.set(cat.id, next);
    renderVoterBody();
  }

  async function castVote(cat, names) {
    const ids = state.selection.get(cat.id) || [];
    const ok = await confirmDialog({
      title: 'Cast your vote?',
      message: `You are voting for ${names.join(', ')} in “${cat.title}”. A vote is final and cannot be changed afterwards.`,
      confirmLabel: 'Cast vote',
    });
    if (!ok) return;
    try {
      await api(`/api/categories/${cat.id}/ballot`, { method: 'POST', json: { nominee_ids: ids } });
      saveChoice(cat.id, ids);
      state.selection.delete(cat.id);
      toast('Your vote has been recorded.', 'success');
    } catch (ex) { toast(ex.message, 'error'); }
    try { await loadBootstrap(); } catch { /* handled by api() */ }
    if (state.view === 'voter') renderVoter();
  }

  // ----------------------------------------------------------------------- results
  async function loadResults() {
    const data = await api('/api/results');
    state.results = data;
    state.resultsKey = JSON.stringify(data);
  }
  function startPolling() {
    stopPolling();
    state.poll = setInterval(async () => {
      if (document.hidden || state.view !== 'results') return;
      const before = state.resultsKey;
      try { await loadResults(); if (state.resultsKey !== before) renderResults({ animate: false }); } catch { /* try again on the next tick */ }
    }, 5000);
  }
  function stopPolling() { if (state.poll) clearInterval(state.poll); state.poll = null; }

  function celebrate() {
    if (window.confetti) window.confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 }, disableForReducedMotion: true });
    toast('Celebrating the category leaders!');
  }

  async function setResultsPublic(value) {
    try {
      await api('/api/admin/settings', { method: 'PUT', json: { results_public: value } });
      toast(value ? 'Results are now visible to voters.' : 'Results are now hidden from voters.', 'success');
      await loadResults();
      renderResults({ animate: false });
    } catch (ex) { toast(ex.message, 'error'); }
  }

  function renderResults({ animate }) {
    const root = clear($('#view-results'));
    const data = state.results;
    const isAdmin = state.user.role === 'admin';
    const shown = !data.hidden;

    root.append(h('div', { class: 'flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-6 rounded-2xl' },
      h('div', null,
        h('div', { class: 'flex items-center space-x-2' }, icon('bar-chart-3', 'w-6 h-6 text-brand-500'), h('h2', { class: 'text-2xl font-bold text-white' }, 'Live results')),
        h('p', { class: 'text-sm text-slate-400 mt-1' }, 'The leaderboard refreshes automatically as votes are cast.')),
      h('div', { class: 'flex items-center space-x-3' },
        h('button', { type: 'button', on: { click: enterBigScreen }, class: 'flex items-center space-x-2 bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl shadow-lg shadow-sky-600/20 transition duration-200 text-sm', title: 'Launch presentation screen for big displays and projectors' }, icon('tv'), h('span', null, 'Big Screen Mode')),
        shown && h('button', { type: 'button', on: { click: celebrate }, class: 'flex items-center space-x-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-slate-950 font-bold px-4 py-2.5 rounded-xl shadow-lg shadow-orange-500/20 transition duration-200' }, icon('sparkles'), h('span', null, 'Celebrate winners')),
        isAdmin && h('button', { type: 'button', on: { click: () => setResultsPublic(!data.public) }, class: 'flex items-center space-x-2 bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2.5 rounded-xl border border-slate-700 text-sm font-medium transition' },
          icon(data.public ? 'eye-off' : 'eye'), h('span', null, data.public ? 'Hide results from voters' : 'Publish results')))));

    if (!shown) {
      root.append(emptyPanel('eye-off', 'Results are not published yet', 'The administrator will publish them when voting is complete.'));
      return refreshIcons();
    }
    if (isAdmin && !data.public) {
      root.append(h('div', { class: 'bg-amber-500/10 border border-amber-500/30 text-amber-200 p-4 rounded-xl flex items-center space-x-3' },
        icon('eye-off', 'w-5 h-5 text-amber-400 flex-shrink-0'),
        h('p', { class: 'text-sm' }, h('strong', null, 'Hidden from voters. '), 'Only administrators can see these results until you publish them.')));
    }

    const cats = data.categories;
    if (!cats.length) { root.append(emptyPanel('award', 'No categories yet')); return refreshIcons(); }
    if (!cats.some((c) => c.id === state.resultsCat)) state.resultsCat = cats[0].id;
    const cat = cats.find((c) => c.id === state.resultsCat);

    root.append(h('div', { class: 'flex items-center gap-2 overflow-x-auto pb-2' }, cats.map((c) => h('button', {
      type: 'button', 'aria-pressed': c.id === state.resultsCat ? 'true' : 'false',
      on: { click: () => { state.resultsCat = c.id; renderResults({ animate: true }); } },
      class: c.id === state.resultsCat
        ? 'px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold whitespace-nowrap transition duration-200 bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20'
        : 'px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold whitespace-nowrap transition duration-200 bg-slate-900 hover:bg-slate-800 text-slate-400 border border-slate-800',
    }, c.title))));

    const tied = cat.leader_ids.length > 1;
    const tally = h('div', { class: 'space-y-6' });
    if (!cat.nominees.length) tally.append(h('p', { class: 'text-slate-400 text-sm' }, 'No nominees in this category.'));
    for (const n of cat.nominees) {
      const leads = cat.leader_ids.includes(n.id);
      const bar = h('div', {
        class: `h-full rounded-full transition-all duration-700 ${leads ? 'bg-gradient-to-r from-amber-500 to-orange-500' : 'bg-brand-600'}`,
        style: { width: animate ? '0%' : `${n.percentage}%` },
      });
      if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${n.percentage}%`; }));
      tally.append(h('div', { class: 'space-y-2' },
        h('div', { class: 'flex items-center justify-between text-sm' },
          h('div', { class: 'flex items-center space-x-3' },
            h('span', { class: `w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${n.rank === 1 && n.votes > 0 ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-400'}` }, n.rank),
            h('span', { class: 'font-semibold text-white' }, n.name),
            leads && h('span', { class: 'text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold' }, tied ? 'Tied' : 'Leading')),
          h('div', { class: 'text-right' },
            h('span', { class: 'font-bold text-white' }, plural(n.votes, 'vote', 'votes')),
            h('span', { class: 'text-xs text-slate-400 ml-1.5' }, `(${n.percentage}%)`))),
        h('div', { class: 'w-full bg-slate-950 rounded-full h-3 overflow-hidden border border-slate-800/80', role: 'progressbar', 'aria-label': n.name, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': n.percentage }, bar)));
    }

    const leaders = cat.nominees.filter((n) => cat.leader_ids.includes(n.id));
    let leaderBody;
    if (leaders.length === 1) {
      const l = leaders[0];
      leaderBody = [
        h('div', { class: 'mx-auto mb-4 w-24' }, h('div', { class: 'rounded-full overflow-hidden border-4 border-amber-500/40 shadow-xl' }, avatar(l.name, l.image_url, 'w-full aspect-square', 'text-3xl'))),
        h('h4', { class: 'text-xl font-extrabold text-white mb-1' }, l.name),
        h('p', { class: 'text-xs text-slate-400 mb-4' }, cat.title),
        h('div', { class: 'inline-flex items-center px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm font-bold' }, icon('trophy', 'w-4 h-4 mr-2'), `${plural(l.votes, 'vote', 'votes')} (${l.percentage}%)`),
      ];
    } else if (leaders.length > 1) {
      leaderBody = [
        h('div', { class: 'w-20 h-20 mx-auto rounded-full bg-amber-500/10 flex items-center justify-center text-amber-400 mb-3' }, icon('trophy', 'w-10 h-10')),
        h('h4', { class: 'text-lg font-extrabold text-white mb-1' }, 'Tied for the lead'),
        h('p', { class: 'text-sm text-slate-300' }, leaders.map((l) => l.name).join(', ')),
        h('p', { class: 'text-xs text-slate-400 mt-2' }, `${plural(leaders[0].votes, 'vote', 'votes')} each`),
      ];
    } else {
      leaderBody = [
        h('div', { class: 'w-20 h-20 mx-auto rounded-full bg-slate-800 flex items-center justify-center text-slate-600 mb-3' }, icon('award', 'w-10 h-10')),
        h('p', { class: 'text-slate-400 text-sm' }, 'No votes recorded yet for this category.'),
      ];
    }

    root.append(h('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-8' },
      h('div', { class: 'lg:col-span-2 space-y-6' },
        h('div', { class: 'glass-panel p-6 rounded-2xl' },
          h('div', { class: 'flex items-center justify-between mb-6 gap-3' },
            h('h3', { class: 'text-lg font-bold text-white' }, cat.title),
            h('span', { class: 'text-xs bg-brand-500/20 text-brand-300 border border-brand-500/30 px-3 py-1 rounded-full font-semibold whitespace-nowrap' }, `Total votes: ${cat.total_votes}`)),
          tally)),
      h('div', { class: 'lg:col-span-1' },
        h('div', { class: 'glass-panel p-6 rounded-2xl border-amber-500/30 relative overflow-hidden' },
          h('div', { class: 'absolute -top-12 -right-12 w-32 h-32 bg-amber-500/10 rounded-full blur-2xl pointer-events-none' }),
          h('div', { class: 'flex items-center space-x-2 text-amber-400 font-bold text-xs mb-4' }, icon('crown', 'w-4 h-4'), h('span', null, cat.active ? 'Current leader' : 'Winner')),
          h('div', { class: 'text-center py-4' }, leaderBody)))));
    refreshIcons();
  }

  // ----------------------------------------------------------------- Big Screen Mode
  async function refreshBigScreenData() {
    try {
      const data = await api('/api/results');
      state.results = data;
      state.resultsKey = JSON.stringify(data);
      return data;
    } catch {
      return null;
    }
  }

  function startBigScreenTimers() {
    stopBigScreenTimers();
    state.bigScreen.clockTimer = setInterval(() => {
      if (!state.bigScreen.active) return;
      const clock = $('#bigscreen-clock');
      if (clock) {
        const now = new Date();
        clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      if (state.bigScreen.autoRotate && state.results && state.results.categories && state.results.categories.length > 1) {
        state.bigScreen.countdownSec--;
        const bar = $('#bigscreen-progress-bar');
        if (bar) {
          const pct = Math.max(0, (state.bigScreen.countdownSec / state.bigScreen.rotateIntervalSec) * 100);
          bar.style.width = `${pct}%`;
        }
        const badge = $('#bigscreen-rotate-timer');
        if (badge) badge.textContent = `${state.bigScreen.countdownSec}s`;

        if (state.bigScreen.countdownSec <= 0) {
          state.bigScreen.countdownSec = state.bigScreen.rotateIntervalSec;
          state.bigScreen.catIndex = (state.bigScreen.catIndex + 1) % state.results.categories.length;
          renderBigScreenStage({ animate: true });
        }
      }
    }, 1000);

    state.bigScreen.pollTimer = setInterval(async () => {
      if (!state.bigScreen.active || document.hidden) return;
      const before = state.resultsKey;
      const data = await refreshBigScreenData();
      if (data && state.resultsKey !== before) {
        renderBigScreenStage({ animate: false });
        const ballotsEl = $('#bigscreen-ballots');
        if (ballotsEl) ballotsEl.textContent = `${data.total_ballots || 0} Ballots Cast`;
      }
    }, 4000);
  }

  function stopBigScreenTimers() {
    if (state.bigScreen.clockTimer) { clearInterval(state.bigScreen.clockTimer); state.bigScreen.clockTimer = null; }
    if (state.bigScreen.pollTimer) { clearInterval(state.bigScreen.pollTimer); state.bigScreen.pollTimer = null; }
  }

  async function enterBigScreen() {
    state.bigScreen.active = true;
    state.bigScreen.previousView = state.view || 'results';
    state.bigScreen.countdownSec = state.bigScreen.rotateIntervalSec;
    showScreen('bigscreen');
    window.location.hash = 'bigscreen';
    await refreshBigScreenData();
    startBigScreenTimers();
    renderBigScreen();
  }

  function exitBigScreen() {
    state.bigScreen.active = false;
    state.bigScreen.showSettings = false;
    stopBigScreenTimers();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    if (window.location.hash === '#bigscreen' || window.location.hash === '#screen') {
      history.replaceState(null, '', window.location.pathname);
    }
    if (state.user) {
      showScreen('app');
      switchView(state.bigScreen.previousView || 'results');
    } else {
      showScreen('login');
    }
  }

  function toggleBigScreenFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  function toggleBigScreenTheme() {
    state.bigScreen.theme = state.bigScreen.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('bigscreen_theme', state.bigScreen.theme); } catch {}
    renderBigScreen();
    toast(`Switched to ${state.bigScreen.theme === 'light' ? 'Light' : 'Dark'} Display`);
  }

  function renderBigScreen() {
    const root = clear($('#screen-bigscreen'));
    const isLight = state.bigScreen.theme === 'light';
    root.className = isLight
      ? 'fixed inset-0 z-50 bg-slate-50 text-slate-950 flex flex-col overflow-y-auto overflow-x-hidden transition-colors duration-200 bigscreen-light-theme selection:bg-brand-500 selection:text-white'
      : 'fixed inset-0 z-50 bg-slate-950 text-slate-100 flex flex-col overflow-y-auto overflow-x-hidden transition-colors duration-200 bigscreen-dark-theme selection:bg-brand-500 selection:text-white';

    const data = state.results || { hidden: true, categories: [], total_ballots: 0, active_categories: 0 };
    const cats = data.categories || [];

    // Presentation Top Bar
    const topBar = h('header', { class: isLight ? 'sticky top-0 z-30 w-full bg-white border-b-2 border-slate-300 px-4 sm:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4 shadow-sm' : 'sticky top-0 z-30 w-full bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-4 sm:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4 shadow-2xl' },
      h('div', { class: 'flex items-center space-x-3.5' },
        h('div', { class: 'h-11 w-11 rounded-xl bg-white p-1.5 flex items-center justify-center shadow-md border border-slate-300 flex-shrink-0' },
          h('img', { src: '/static/img/kobwa-logo.png', alt: 'KOBWA Logo', class: 'h-full w-full object-contain' })),
        h('div', null,
          h('h1', { class: isLight ? 'text-lg sm:text-2xl font-black tracking-tight text-slate-950 leading-none' : 'text-lg sm:text-2xl font-black tracking-tight text-white leading-none' }, 'KOBWA VOTING PLATFORM'))),

      h('div', { class: 'flex items-center space-x-3 text-xs' },
        h('div', { class: isLight ? 'px-3.5 py-1.5 rounded-xl bg-slate-100 border border-slate-300 font-mono text-slate-950 font-bold flex items-center gap-2 shadow-sm' : 'px-3 py-1.5 rounded-xl bg-slate-800/90 border border-slate-700/80 font-mono text-slate-200 flex items-center gap-2' },
          icon('clock', `w-3.5 h-3.5 ${isLight ? 'text-blue-700' : 'text-sky-400'}`),
          h('span', { id: 'bigscreen-clock' }, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))),
        h('div', { class: isLight ? 'px-3.5 py-1.5 rounded-xl bg-blue-100 border border-blue-300 text-blue-950 font-black flex items-center gap-1.5 shadow-sm' : 'px-3.5 py-1.5 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-300 font-bold flex items-center gap-1.5' },
          icon('users', `w-3.5 h-3.5 ${isLight ? 'text-blue-700' : 'text-sky-400'}`),
          h('span', { id: 'bigscreen-ballots' }, `${data.total_ballots || 0} Ballots Cast`))),

      h('div', { class: 'flex items-center space-x-2' },
        // Settings dropdown wrapper
        h('div', { class: 'relative' },
          h('button', {
            type: 'button',
            on: { click: (e) => {
              e.stopPropagation();
              state.bigScreen.showSettings = !state.bigScreen.showSettings;
              renderBigScreen();
            } },
            class: isLight
              ? `flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-sm ${state.bigScreen.showSettings ? 'bg-slate-900 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300'}`
              : `flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition ${state.bigScreen.showSettings ? 'bg-slate-700 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'}`,
            title: 'Presentation & Display Settings',
          },
            icon('settings', 'w-3.5 h-3.5'),
            h('span', null, 'Settings'),
            state.bigScreen.autoRotate && cats.length > 1 && !data.hidden && h('span', { class: 'w-2 h-2 rounded-full bg-amber-400 animate-pulse' })),

          // Settings Popover Panel
          state.bigScreen.showSettings && h('div', {
            class: isLight
              ? 'absolute right-0 top-full mt-2 w-80 rounded-2xl bg-white border-2 border-slate-300 p-4 shadow-2xl z-50 text-slate-950 animate-fade-in'
              : 'absolute right-0 top-full mt-2 w-80 rounded-2xl bg-slate-900 border border-slate-800 p-4 shadow-2xl z-50 text-white backdrop-blur-xl animate-fade-in',
            on: { click: (e) => e.stopPropagation() },
          },
            // Header
            h('div', { class: `flex items-center justify-between pb-3 border-b ${isLight ? 'border-slate-200' : 'border-slate-800'}` },
              h('div', { class: 'flex items-center gap-2' },
                icon('sliders', 'w-4 h-4 text-brand-500'),
                h('h3', { class: 'text-sm font-black' }, 'Display Settings')),
              h('button', {
                type: 'button',
                on: { click: () => { state.bigScreen.showSettings = false; renderBigScreen(); } },
                class: `p-1 rounded-lg ${isLight ? 'hover:bg-slate-100 text-slate-500' : 'hover:bg-slate-800 text-slate-400'}`,
              }, icon('x', 'w-4 h-4'))),

            // Theme toggle section
            h('div', { class: `py-3 border-b ${isLight ? 'border-slate-200' : 'border-slate-800'}` },
              h('div', { class: 'flex items-center justify-between mb-2' },
                h('span', { class: `text-xs font-bold ${isLight ? 'text-slate-700' : 'text-slate-300'}` }, 'Theme / Visibility'),
                h('span', { class: `text-[11px] font-mono ${isLight ? 'text-slate-500' : 'text-slate-400'}` }, 'Press T')),
              h('div', { class: 'grid grid-cols-2 gap-2' },
                h('button', {
                  type: 'button',
                  on: { click: () => {
                    state.bigScreen.theme = 'light';
                    try { localStorage.setItem('bigscreen_theme', 'light'); } catch {}
                    renderBigScreen();
                    toast('Switched to Light Display');
                  } },
                  class: `flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-black transition ${isLight
                    ? 'bg-amber-400 text-slate-950 shadow-md ring-2 ring-amber-400/50'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'}`,
                }, icon('sun', 'w-3.5 h-3.5 text-amber-600'), 'Light Display'),

                h('button', {
                  type: 'button',
                  on: { click: () => {
                    state.bigScreen.theme = 'dark';
                    try { localStorage.setItem('bigscreen_theme', 'dark'); } catch {}
                    renderBigScreen();
                    toast('Switched to Dark Display');
                  } },
                  class: `flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-black transition ${!isLight
                    ? 'bg-brand-600 text-white shadow-md ring-2 ring-brand-500/50'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300'}`,
                }, icon('moon', 'w-3.5 h-3.5 text-indigo-400'), 'Dark Display'))),

            // Auto-Rotate toggle section
            cats.length > 1 && !data.hidden && h('div', { class: `py-3 border-b ${isLight ? 'border-slate-200' : 'border-slate-800'}` },
              h('div', { class: 'flex items-center justify-between' },
                h('div', null,
                  h('p', { class: `text-xs font-bold ${isLight ? 'text-slate-700' : 'text-slate-300'}` }, 'Auto-Rotate Categories'),
                  h('p', { class: `text-[11px] ${isLight ? 'text-slate-500' : 'text-slate-400'}` }, state.bigScreen.autoRotate ? `Cycling every 12s (${state.bigScreen.countdownSec}s)` : 'Paused (Spacebar)')),
                h('button', {
                  type: 'button',
                  on: { click: () => {
                    state.bigScreen.autoRotate = !state.bigScreen.autoRotate;
                    renderBigScreen();
                    toast(state.bigScreen.autoRotate ? 'Auto-rotate enabled (12s per category)' : 'Auto-rotate paused');
                  } },
                  class: `flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black transition ${state.bigScreen.autoRotate
                    ? 'bg-amber-400 text-slate-950 shadow-sm'
                    : (isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300' : 'bg-slate-800 hover:bg-slate-700 text-slate-400')}`,
                },
                  icon('refresh-cw', 'w-3 h-3'),
                  state.bigScreen.autoRotate ? 'ON' : 'OFF'))),

            // Keyboard Shortcuts Guide
            h('div', { class: `pt-3 text-[11px] ${isLight ? 'text-slate-600' : 'text-slate-400'}` },
              h('p', { class: 'font-bold uppercase tracking-wider mb-1.5 text-[10px]' }, 'Keyboard Shortcuts:'),
              h('div', { class: 'grid grid-cols-2 gap-y-1.5' },
                h('span', null, h('kbd', { class: `px-1.5 py-0.5 rounded ${isLight ? 'bg-slate-100 text-slate-800 border border-slate-300' : 'bg-slate-800 text-slate-200'} font-mono text-[10px] mr-1` }, 'T'), 'Theme'),
                h('span', null, h('kbd', { class: `px-1.5 py-0.5 rounded ${isLight ? 'bg-slate-100 text-slate-800 border border-slate-300' : 'bg-slate-800 text-slate-200'} font-mono text-[10px] mr-1` }, 'Space'), 'Rotate'),
                h('span', null, h('kbd', { class: `px-1.5 py-0.5 rounded ${isLight ? 'bg-slate-100 text-slate-800 border border-slate-300' : 'bg-slate-800 text-slate-200'} font-mono text-[10px] mr-1` }, 'F'), 'Fullscreen'),
                h('span', null, h('kbd', { class: `px-1.5 py-0.5 rounded ${isLight ? 'bg-slate-100 text-slate-800 border border-slate-300' : 'bg-slate-800 text-slate-200'} font-mono text-[10px] mr-1` }, 'C'), 'Celebrate'))))),

        h('button', {
          type: 'button', on: { click: celebrate },
          class: 'flex items-center space-x-1.5 px-3 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 rounded-xl text-xs font-black shadow-md shadow-orange-500/20 transition',
          title: 'Trigger celebration confetti (Press C)',
        }, icon('sparkles', 'w-3.5 h-3.5'), h('span', { class: 'hidden sm:inline' }, 'Celebrate')),

        h('button', {
          type: 'button', on: { click: toggleBigScreenFullscreen },
          class: isLight
            ? 'p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 shadow-sm transition'
            : 'p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition',
          title: 'Toggle Fullscreen Mode (Press F)',
        }, icon('maximize', 'w-4 h-4')),

        h('button', {
          type: 'button', on: { click: exitBigScreen },
          class: isLight
            ? 'flex items-center space-x-1 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-red-600 hover:text-white text-slate-800 border border-slate-300 hover:border-red-600 transition text-xs font-bold'
            : 'flex items-center space-x-1 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-red-600/80 text-slate-300 hover:text-white border border-slate-700 hover:border-red-500 transition text-xs font-medium',
          title: 'Exit Big Screen Mode (Esc)',
        }, icon('x', 'w-4 h-4'), h('span', { class: 'hidden sm:inline' }, 'Exit'))));

    const progressBar = h('div', { class: isLight ? 'h-1.5 w-full bg-slate-200 overflow-hidden' : 'h-1 w-full bg-slate-900/60 overflow-hidden' },
      h('div', { id: 'bigscreen-progress-bar', class: 'h-full bg-gradient-to-r from-sky-500 to-amber-500 transition-all duration-1000 ease-linear', style: { width: state.bigScreen.autoRotate ? '100%' : '0%' } }));

    const catNav = (cats.length > 1 && !data.hidden) ? h('div', { class: isLight ? 'bg-white border-b-2 border-slate-200 px-4 sm:px-8 py-3 flex items-center gap-2 overflow-x-auto shadow-sm' : 'bg-slate-900/60 border-b border-slate-800/80 px-4 sm:px-8 py-2.5 flex items-center gap-2 overflow-x-auto' },
      cats.map((c, idx) => h('button', {
        type: 'button',
        on: { click: () => {
          state.bigScreen.catIndex = idx;
          state.bigScreen.countdownSec = state.bigScreen.rotateIntervalSec;
          renderBigScreenStage({ animate: true });
        } },
        class: idx === state.bigScreen.catIndex
          ? (isLight
              ? 'px-4 py-2 rounded-xl text-xs sm:text-sm font-black whitespace-nowrap bg-blue-600 text-white shadow-md flex items-center gap-2 border border-blue-700'
              : 'px-4 py-1.5 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-lg shadow-sky-500/20 flex items-center gap-2 border border-sky-400/30')
          : (isLight
              ? 'px-4 py-2 rounded-xl text-xs sm:text-sm font-bold whitespace-nowrap bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 shadow-sm'
              : 'px-4 py-1.5 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800/80'),
      }, c.title, c.active && h('span', { class: isLight ? 'w-2.5 h-2.5 rounded-full bg-emerald-500' : 'w-2 h-2 rounded-full bg-emerald-400' })))) : null;

    const stage = h('main', { id: 'bigscreen-stage', class: 'flex-1 max-w-7xl w-full mx-auto p-4 sm:p-8 lg:p-10 flex flex-col justify-center' });

    const settingsBackdrop = state.bigScreen.showSettings
      ? h('div', {
          class: 'fixed inset-0 z-20 bg-transparent',
          on: { click: () => { state.bigScreen.showSettings = false; renderBigScreen(); } },
        })
      : null;

    root.append(...[settingsBackdrop, topBar, progressBar, catNav, stage].filter(Boolean));
    renderBigScreenStage({ animate: true });
    refreshIcons();
  }

  function renderBigScreenStage({ animate = false } = {}) {
    const stage = $('#bigscreen-stage');
    if (!stage) return;
    clear(stage);
    const isLight = state.bigScreen.theme === 'light';
    const data = state.results || { hidden: true, categories: [] };

    if (data.hidden) {
      stage.append(h('div', { class: isLight ? 'text-center max-w-3xl mx-auto py-12 px-6 bg-white rounded-3xl border-2 border-slate-300 shadow-xl relative overflow-hidden animate-fade-in bigscreen-card' : 'text-center max-w-3xl mx-auto py-12 px-6 glass-panel rounded-3xl border border-sky-500/20 shadow-2xl relative overflow-hidden animate-fade-in' },
        h('div', { class: 'absolute -top-24 -left-24 w-72 h-72 bg-sky-500/10 rounded-full blur-3xl pointer-events-none' }),
        h('div', { class: 'absolute -bottom-24 -right-24 w-72 h-72 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none' }),

        h('div', { class: 'inline-block p-4 bg-white rounded-3xl shadow-xl border border-slate-200 mb-8 mx-auto' },
          h('img', { src: '/static/img/kobwa-logo.png', alt: 'KOBWA Logo', class: 'h-24 sm:h-28 w-auto object-contain' })),

        h('div', { class: isLight ? 'inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-950 text-xs sm:text-sm font-extrabold tracking-wider uppercase mb-4 shadow-sm' : 'inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs sm:text-sm font-extrabold tracking-wider uppercase mb-4' },
          h('span', { class: 'w-2.5 h-2.5 rounded-full bg-emerald-600 animate-ping' }),
          'Session Active & Receiving Votes'),

        h('h2', { class: isLight ? 'text-3xl sm:text-5xl font-black text-slate-950 tracking-tight mb-4' : 'text-3xl sm:text-5xl font-black text-white tracking-tight mb-4' }, 'VOTING IN PROGRESS'),
        h('p', { class: isLight ? 'text-base sm:text-lg text-slate-700 max-w-xl mx-auto leading-relaxed mb-10 font-semibold' : 'text-base sm:text-lg text-slate-300 max-w-xl mx-auto leading-relaxed mb-10' },
          'Official secret balloting proceedings are currently underway across Komati Basin Water Authority.'),

        h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mx-auto mb-10' },
          h('div', { class: isLight ? 'p-5 rounded-2xl bg-slate-50 border-2 border-slate-200 shadow-sm' : 'p-5 rounded-2xl bg-slate-900/90 border border-slate-800' },
            h('p', { class: isLight ? 'text-3xl font-black text-slate-950 font-mono' : 'text-3xl font-extrabold text-white font-mono' }, String(data.total_ballots || 0)),
            h('p', { class: isLight ? 'text-xs font-black text-sky-800 uppercase tracking-wider mt-1' : 'text-xs font-semibold text-sky-400 uppercase tracking-wider mt-1' }, 'Ballots Submitted')),
          h('div', { class: isLight ? 'p-5 rounded-2xl bg-slate-50 border-2 border-slate-200 shadow-sm' : 'p-5 rounded-2xl bg-slate-900/90 border border-slate-800' },
            h('p', { class: isLight ? 'text-3xl font-black text-slate-950 font-mono' : 'text-3xl font-extrabold text-white font-mono' }, String(data.active_categories || 0)),
            h('p', { class: isLight ? 'text-xs font-black text-emerald-800 uppercase tracking-wider mt-1' : 'text-xs font-semibold text-emerald-400 uppercase tracking-wider mt-1' }, 'Active Categories'))),

        h('div', { class: isLight ? 'p-4 rounded-xl bg-slate-100 border border-slate-300 text-xs sm:text-sm text-slate-700 font-medium' : 'p-4 rounded-xl bg-slate-900/80 border border-slate-800/80 text-xs sm:text-sm text-slate-400' },
          icon('info', `w-4 h-4 inline mr-1 ${isLight ? 'text-blue-700' : 'text-sky-400'}`),
          'Please submit your ballots via your workstation or mobile portal. Results will be projected live here upon official announcement.')));
      return refreshIcons();
    }

    const cats = data.categories || [];
    if (!cats.length) {
      stage.append(emptyPanel('award', 'No categories defined yet', 'Categories will be displayed once created by an administrator.'));
      return refreshIcons();
    }

    if (state.bigScreen.catIndex >= cats.length) state.bigScreen.catIndex = 0;
    const cat = cats[state.bigScreen.catIndex];

    // Category Header Banner
    const catHeader = h('div', { class: isLight ? 'flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8 pb-6 border-b-2 border-slate-300 animate-fade-in' : 'flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8 pb-6 border-b border-slate-800 animate-fade-in' },
      h('div', null,
        h('div', { class: 'flex items-center gap-3 mb-2' },
          h('span', { class: isLight
            ? `px-3.5 py-1 rounded-full text-xs font-black uppercase tracking-wider flex items-center gap-1.5 shadow-sm ${cat.active ? 'bg-emerald-100 border border-emerald-300 text-emerald-950' : 'bg-slate-200 text-slate-800 border border-slate-300'}`
            : `px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${cat.active ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400' : 'bg-slate-800 text-slate-400 border border-slate-700'}` },
            cat.active && h('span', { class: 'w-2 h-2 rounded-full bg-emerald-600 animate-pulse' }),
            cat.active ? 'Voting Active' : 'Voting Concluded'),
          h('span', { class: isLight ? 'text-xs text-slate-600 font-black uppercase tracking-wider' : 'text-xs text-slate-400 font-semibold uppercase tracking-wider' }, `Category ${state.bigScreen.catIndex + 1} of ${cats.length}`)),
        h('h2', { class: isLight ? 'text-2xl sm:text-4xl lg:text-5xl font-black text-slate-950 tracking-tight' : 'text-2xl sm:text-4xl lg:text-5xl font-black text-white tracking-tight' }, cat.title)),
      h('div', { class: 'flex items-center gap-3' },
        h('div', { class: isLight ? 'px-5 py-2.5 rounded-2xl bg-white border-2 border-slate-300 shadow-sm text-right bigscreen-card' : 'px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 text-right' },
          h('p', { class: isLight ? 'text-xs text-slate-600 font-bold uppercase tracking-wider' : 'text-xs text-slate-400' }, 'Total Ballots'),
          h('p', { class: isLight ? 'text-2xl font-black text-slate-950 font-mono' : 'text-xl font-black text-white font-mono' }, String(cat.ballots || 0))),
        h('div', { class: isLight ? 'px-5 py-2.5 rounded-2xl bg-blue-50 border-2 border-blue-200 shadow-sm text-right' : 'px-4 py-2 rounded-xl bg-sky-500/10 border border-sky-500/30 text-right' },
          h('p', { class: isLight ? 'text-xs text-blue-900 font-bold uppercase tracking-wider' : 'text-xs text-sky-400' }, 'Total Votes'),
          h('p', { class: isLight ? 'text-2xl font-black text-blue-950 font-mono' : 'text-xl font-black text-sky-300 font-mono' }, String(cat.total_votes || 0)))));

    // Top 3 Podium (when nominees >= 3)
    let podium = null;
    const sorted = [...(cat.nominees || [])].sort((a, b) => b.votes - a.votes);
    if (sorted.length >= 3 && sorted[0].votes > 0) {
      const first = sorted[0];
      const second = sorted[1];
      const third = sorted[2];

      const podiumCard = (nom, rank, heightClass, bgGradient, borderClass, trophyColor, label) => h('div', {
        class: `flex-1 flex flex-col items-center justify-end text-center p-6 rounded-3xl ${bgGradient} border-2 ${borderClass} shadow-xl relative overflow-hidden transition-transform duration-300 hover:scale-[1.02] ${heightClass}`,
      },
        h('div', { class: `w-10 h-10 rounded-full flex items-center justify-center font-black text-sm mb-3 shadow-lg ${rank === 1 ? 'bg-amber-400 text-slate-950 ring-4 ring-amber-400/30' : rank === 2 ? (isLight ? 'bg-slate-200 text-slate-950 border border-slate-300' : 'bg-slate-300 text-slate-950') : (isLight ? 'bg-amber-700 text-white' : 'bg-amber-700 text-white')}` },
          `#${rank}`),
        h('div', { class: `rounded-full overflow-hidden mb-3 shadow-xl ${rank === 1 ? 'w-24 h-24 ring-4 ring-amber-400/50' : 'w-20 h-20 ring-2 ring-slate-400'}` },
          avatar(nom.name, nom.image_url, 'w-full h-full', rank === 1 ? 'text-3xl' : 'text-2xl')),
        h('h4', { class: isLight ? 'text-base sm:text-lg font-black text-slate-950 line-clamp-1' : 'text-base sm:text-lg font-black text-white line-clamp-1' }, nom.name),
        h('p', { class: `text-xs font-black uppercase tracking-wider mb-2 ${trophyColor}` }, label),
        h('div', { class: `w-full pt-3 ${isLight ? 'border-t-2 border-slate-200' : 'border-t border-white/10'} flex items-center justify-around text-xs sm:text-sm font-bold` },
          h('span', { class: isLight ? 'text-slate-950 font-black' : 'text-white' }, plural(nom.votes, 'vote', 'votes')),
          h('span', { class: `${trophyColor} font-black` }, `${nom.percentage}%`)));

      podium = h('div', { class: 'grid grid-cols-1 md:grid-cols-3 gap-4 mb-8 items-end' },
        podiumCard(second, 2, 'min-h-[260px] md:order-1', isLight ? 'bg-white bigscreen-card' : 'bg-slate-900/80', isLight ? 'border-slate-300' : 'border-slate-700/80', isLight ? 'text-slate-700' : 'text-slate-300', 'Second Place'),
        podiumCard(first, 1, 'min-h-[300px] md:order-2', isLight ? 'bg-gradient-to-b from-amber-50 to-white' : 'bg-gradient-to-b from-amber-500/20 via-slate-900 to-slate-900', isLight ? 'border-amber-400 border-2' : 'border-amber-500/40', isLight ? 'text-amber-800' : 'text-amber-400', cat.active ? 'Current Leader' : 'Category Winner'),
        podiumCard(third, 3, 'min-h-[240px] md:order-3', isLight ? 'bg-white bigscreen-card' : 'bg-slate-900/80', isLight ? 'border-slate-300' : 'border-slate-800', isLight ? 'text-amber-900' : 'text-amber-600', 'Third Place'));
    }

    // Full Leaderboard Tally Bars
    const tally = h('div', { class: 'space-y-4' });
    if (!cat.nominees.length) {
      tally.append(h('p', { class: isLight ? 'text-slate-600 text-base text-center py-8 font-semibold' : 'text-slate-400 text-base text-center py-8' }, 'No nominees registered for this category yet.'));
    } else {
      for (const n of cat.nominees) {
        const leads = cat.leader_ids.includes(n.id);
        const bar = h('div', {
          class: `h-full rounded-full transition-all duration-700 ${leads ? 'bg-gradient-to-r from-amber-500 via-orange-500 to-amber-400' : (isLight ? 'bg-gradient-to-r from-blue-600 to-indigo-600' : 'bg-gradient-to-r from-sky-600 to-indigo-600')}`,
          style: { width: animate ? '0%' : `${n.percentage}%` },
        });
        if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${n.percentage}%`; }));

        const cardClass = isLight
          ? (leads ? 'p-5 sm:p-6 rounded-2xl bg-amber-50 border-2 border-amber-400 shadow-md bigscreen-card-leader transition-all' : 'p-5 sm:p-6 rounded-2xl bg-white border-2 border-slate-300 shadow-sm bigscreen-card transition-all')
          : (leads ? 'p-4 sm:p-5 rounded-2xl glass-panel border border-amber-500/40 bg-amber-500/5 transition-all' : 'p-4 sm:p-5 rounded-2xl glass-panel border border-slate-800 transition-all');

        tally.append(h('div', { class: cardClass },
          h('div', { class: 'flex items-center justify-between mb-3 gap-3' },
            h('div', { class: 'flex items-center space-x-3 sm:space-x-4 min-w-0' },
              h('span', { class: `w-9 h-9 rounded-full flex items-center justify-center text-sm font-black flex-shrink-0 ${n.rank === 1 && n.votes > 0 ? 'bg-amber-400 text-slate-950 ring-2 ring-amber-400/50 shadow' : (isLight ? 'bg-slate-200 text-slate-950 border border-slate-300 font-black' : 'bg-slate-800 text-slate-400')}` }, String(n.rank)),
              h('div', { class: `w-11 h-11 rounded-xl overflow-hidden flex-shrink-0 border-2 ${isLight ? 'border-slate-300 shadow-sm' : 'border-slate-700'}` },
                avatar(n.name, n.image_url, 'w-full h-full', 'text-xs')),
              h('div', { class: 'min-w-0' },
                h('p', { class: isLight ? 'text-lg sm:text-2xl font-black text-slate-950 truncate tracking-tight' : 'text-base sm:text-xl font-bold text-white truncate' }, n.name)),
              leads && h('span', { class: isLight ? 'text-xs bg-amber-200 text-amber-950 border border-amber-400 px-3 py-1 rounded-full font-black uppercase tracking-wider shadow-sm' : 'text-[11px] sm:text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-full font-extrabold uppercase tracking-wider' }, cat.active ? 'Leader' : 'Winner')),
            h('div', { class: 'text-right flex-shrink-0' },
              h('p', { class: isLight ? 'text-xl sm:text-3xl font-black text-slate-950 font-mono leading-none' : 'text-lg sm:text-2xl font-black text-white font-mono' }, plural(n.votes, 'vote', 'votes')),
              h('p', { class: isLight ? 'text-xs sm:text-sm font-extrabold text-blue-700 font-mono mt-1' : 'text-xs font-semibold text-sky-400 font-mono' }, `${n.percentage}% share`))),
          h('div', { class: isLight ? 'w-full bigscreen-track rounded-full h-4 sm:h-5 overflow-hidden p-0.5 mt-2.5 shadow-inner' : 'w-full bg-slate-950 rounded-full h-3.5 sm:h-4 overflow-hidden border border-slate-800/80 p-0.5 mt-2.5' },
            bar)));
      }
    }

    stage.append(...[catHeader, podium, tally].filter(Boolean));
    refreshIcons();
  }

  // ------------------------------------------------------------------------- admin
  async function loadAudit() {
    const a = state.admin.audit;
    const qs = new URLSearchParams({ page: a.page, per_page: a.per_page });
    if (a.q) qs.set('q', a.q);
    Object.assign(a, await api(`/api/admin/audit?${qs}`));
  }
  async function loadAdminTab() {
    const a = state.admin;
    if (a.tab === 'categories') {
      const d = await api('/api/admin/categories');
      a.categories = d.categories; a.eligible = d.eligible_voters;
    } else if (a.tab === 'voters') a.users = (await api('/api/admin/users')).users;
    else await loadAudit();
  }
  async function refreshAdmin() {
    try { await loadAdminTab(); if (state.view === 'admin') renderAdmin(); }
    catch (ex) { if (ex.status !== 401) toast(ex.message, 'error'); }
  }
  const statusPill = (on) => h('span', {
    class: on ? 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
              : 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-red-500/20 text-red-300 border border-red-500/30',
  }, on ? 'Open' : 'Closed');
  const iconBtn = (name, label, onClick, danger = false, disabled = false) => h('button', {
    type: 'button', title: label, 'aria-label': label, disabled, on: { click: onClick },
    class: `p-1.5 text-slate-400 ${danger ? 'hover:text-red-400' : 'hover:text-brand-400'} hover:bg-slate-800 rounded-lg transition disabled:opacity-30 disabled:hover:bg-transparent`,
  }, icon(name));

  function renderAdmin() {
    const root = clear($('#view-admin'));
    const a = state.admin;
    const actionBtn = (label, iconName, onClick, primary) => h('button', {
      type: 'button', on: { click: onClick },
      class: primary ? 'flex items-center space-x-2 bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded-xl font-medium text-sm transition shadow-lg shadow-brand-600/20'
                     : 'flex items-center space-x-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white px-4 py-2 rounded-xl font-medium text-sm transition',
    }, icon(iconName), h('span', null, label));
    const actions = a.tab === 'categories'
      ? [actionBtn('New category', 'plus', () => openCategoryModal(), true), actionBtn('Add nominee', 'user-plus', () => openNomineeModal({}))]
      : a.tab === 'voters'
        ? [actionBtn('Add person', 'user-plus', openUserModal, true), actionBtn('Import list', 'upload', openImportModal)]
        : [];

    root.append(h('div', { class: 'flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5' },
      h('div', null,
        h('h2', { class: 'text-2xl font-bold text-white flex items-center gap-2' }, icon('shield-check', 'w-7 h-7 text-brand-500'), 'Back-office administration'),
        h('p', { class: 'text-sm text-slate-400' }, 'Set up categories and nominees, manage who can vote, and review everything that has happened.')),
      h('div', { class: 'flex items-center gap-2' }, actions)));

    const tabs = [['categories', 'Categories and nominees'], ['voters', 'Voters'], ['audit', 'Audit log']];
    root.append(h('div', { class: 'flex border-b border-slate-800 space-x-6 overflow-x-auto', role: 'tablist' }, tabs.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': a.tab === id ? 'true' : 'false',
      on: { click: async () => { a.tab = id; await refreshAdmin(); } },
      class: a.tab === id ? 'pb-3 text-sm font-semibold border-b-2 border-brand-500 text-brand-400 transition whitespace-nowrap'
                          : 'pb-3 text-sm font-semibold border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition whitespace-nowrap',
    }, label))));

    root.append(a.tab === 'categories' ? adminCategories() : a.tab === 'voters' ? adminVoters() : adminAudit());
    refreshIcons();
  }

  // ---- categories and nominees
  function adminCategories() {
    const a = state.admin;
    if (!a.categories.length) return emptyPanel('layers', 'No categories yet', 'Create a category to start collecting nominees and votes.');
    return h('div', { class: 'space-y-6' }, a.categories.map((cat) => h('div', { class: 'glass-panel rounded-2xl p-6 space-y-6' },
      h('div', { class: 'flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4' },
        h('div', null,
          h('div', { class: 'flex items-center gap-3 flex-wrap' }, h('h3', { class: 'text-lg font-bold text-white' }, cat.title), statusPill(cat.active),
            cat.mode === 'directory' && h('span', { class: 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' }, 'Open vote')),
          h('p', { class: 'text-xs text-slate-400 mt-1' }, cat.description || 'No description'),
          h('p', { class: 'text-xs text-slate-500 mt-1' }, `${cat.ballots} of ${plural(a.eligible, 'eligible voter', 'eligible voters')} have voted. Each person can choose up to ${cat.max_votes}.`)),
        h('div', { class: 'flex items-center space-x-2' },
          h('button', { type: 'button', on: { click: () => toggleCategory(cat) }, class: 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition border border-slate-700' }, cat.active ? 'Close voting' : 'Open voting'),
          iconBtn('edit-3', `Edit ${cat.title}`, () => openCategoryModal(cat)),
          iconBtn('trash-2', `Delete ${cat.title}`, () => deleteCategory(cat), true))),
      cat.mode === 'directory' ? directoryNote(cat) : h('div', null,
        h('div', { class: 'flex items-center justify-between mb-3' },
          h('h4', { class: 'text-xs font-bold text-slate-400' }, `Nominees (${cat.nominees.length})`),
          h('button', { type: 'button', on: { click: () => openNomineeModal({ categoryId: cat.id }) }, class: 'text-xs text-brand-400 hover:text-brand-300 font-semibold flex items-center gap-1' }, icon('plus', 'w-3.5 h-3.5'), 'Add nominee')),
        cat.nominees.length
          ? h('div', { class: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' }, cat.nominees.map((nom) => h('div', { class: 'bg-slate-950/80 border border-slate-800/80 rounded-xl p-3 flex items-center justify-between space-x-3' },
              h('div', { class: 'flex items-center space-x-3 overflow-hidden' },
                h('div', { class: 'flex-shrink-0 rounded-lg overflow-hidden' }, avatar(nom.name, nom.image_url, 'w-10 h-10', 'text-xs')),
                h('div', { class: 'truncate' },
                  h('p', { class: 'text-sm font-semibold text-white truncate' }, nom.name),
                  h('p', { class: 'text-[11px] text-slate-400 truncate' }, nom.bio || 'No bio'))),
              h('div', { class: 'flex items-center flex-shrink-0' },
                iconBtn('edit-2', `Edit ${nom.name}`, () => openNomineeModal({ nominee: nom })),
                iconBtn('trash', `Delete ${nom.name}`, () => deleteNominee(nom), true)))))
          : h('p', { class: 'text-xs text-slate-500' }, 'No nominees yet.')))));
  }

  function directoryNote(cat) {
    return h('div', { class: 'bg-slate-950/80 border border-slate-800/80 rounded-xl p-4 flex items-start gap-3' },
      icon('users', 'w-5 h-5 text-indigo-300 mt-0.5 flex-shrink-0'),
      h('div', { class: 'text-xs text-slate-300 leading-relaxed' },
        h('p', { class: 'font-semibold text-white text-sm mb-0.5' }, 'Voters pick from the staff list'),
        h('p', null, `${plural(cat.candidates, 'person', 'people')} can currently be voted for${cat.allow_self_vote ? '' : ', and nobody can vote for themselves'}. Manage who appears in the list under the Voters tab.`)));
  }

  async function toggleCategory(cat) {
    try {
      await api(`/api/admin/categories/${cat.id}`, { method: 'PUT', json: { active: !cat.active } });
      toast(cat.active ? 'Voting closed.' : 'Voting opened.', 'success');
      await refreshAdmin();
    } catch (ex) { toast(ex.message, 'error'); }
  }
  async function deleteCategory(cat) {
    const ok = await confirmDialog({
      title: `Delete “${cat.title}”?`, danger: true, confirmLabel: 'Delete category',
      message: `This permanently removes ${plural(cat.nominees.length, 'nominee', 'nominees')}, ${plural(cat.ballots, 'ballot', 'ballots')} and ${plural(cat.votes, 'vote', 'votes')}. The deletion is recorded in the audit log, but the data cannot be restored.`,
    });
    if (!ok) return;
    try { await api(`/api/admin/categories/${cat.id}`, { method: 'DELETE' }); toast('Category deleted.', 'success'); await refreshAdmin(); }
    catch (ex) { toast(ex.message, 'error'); }
  }
  async function deleteNominee(nom) {
    const ok = await confirmDialog({ title: `Delete ${nom.name}?`, danger: true, confirmLabel: 'Delete nominee', message: 'The nominee and their photo will be removed. Nominees who already have votes cannot be deleted.' });
    if (!ok) return;
    try { await api(`/api/admin/nominees/${nom.id}`, { method: 'DELETE' }); toast('Nominee deleted.', 'success'); await refreshAdmin(); }
    catch (ex) { toast(ex.message, 'error'); }
  }

  function openCategoryModal(cat) {
    openModal({
      title: cat ? 'Edit category' : 'New category',
      build(body, close) {
        const title = h('input', { type: 'text', required: true, maxLength: 120, placeholder: 'e.g. Employee of the year', class: INPUT, value: cat ? cat.title : '' });
        const desc = h('textarea', { rows: 3, maxLength: 1000, placeholder: 'What this award recognizes…', class: INPUT }); desc.value = cat ? cat.description : '';
        const max = h('input', { type: 'number', min: 1, max: 50, required: true, class: INPUT, value: cat ? cat.max_votes : 1 });
        const active = h('select', { class: INPUT }, h('option', { value: 'true' }, 'Open for voting'), h('option', { value: 'false' }, 'Closed')); active.value = String(cat ? cat.active : true);
        const mode = h('select', { class: INPUT, disabled: !!cat }, h('option', { value: 'nominees' }, 'Nominees chosen by admins'), h('option', { value: 'directory' }, 'Open vote from the staff list'));
        mode.value = cat ? cat.mode : 'nominees';
        const self = h('input', { type: 'checkbox', class: 'mr-2' }); self.checked = cat ? cat.allow_self_vote : false;
        const selfRow = h('label', { class: 'flex items-center text-xs text-slate-300' }, self, 'Let people vote for themselves');
        const syncSelf = () => selfRow.classList.toggle('hidden', mode.value !== 'directory');
        mode.addEventListener('change', syncSelf); syncSelf();
        const error = formError();
        const save = h('button', { type: 'submit', class: BTN_PRIMARY }, 'Save category');
        body.append(h('form', {
          class: 'space-y-4',
          on: { submit: async (e) => {
            e.preventDefault(); error.classList.add('hidden');
            const json = { title: title.value, description: desc.value, max_votes: Number(max.value), active: active.value === 'true' };
            if (!cat) json.mode = mode.value;
            if (mode.value === 'directory') json.allow_self_vote = self.checked;
            try {
              await busy(save, () => api(cat ? `/api/admin/categories/${cat.id}` : '/api/admin/categories', { method: cat ? 'PUT' : 'POST', json }));
              close(); toast('Category saved.', 'success'); await refreshAdmin();
            } catch (ex) { showInline(error, ex.message); }
          } },
        },
          field('Title', title), field('Description', desc),
          field('Voting type', mode, cat ? 'The type is fixed once a category exists.' : 'Open vote: each voter picks a person from the staff list, so there are no nominees to set up.'),
          selfRow,
          h('div', { class: 'grid grid-cols-2 gap-4' }, field('Votes per person', max, 'How many they may choose.'), field('Status', active)),
          error,
          h('div', { class: 'pt-2 flex justify-end space-x-3' }, h('button', { type: 'button', class: BTN_GHOST, on: { click: () => close() } }, 'Cancel'), save)));
      },
    });
  }

  function openNomineeModal({ categoryId, nominee }) {
    const cats = state.admin.categories.filter((c) => c.mode !== 'directory');
    if (!cats.length) return toast('Create a nominee-based category before adding nominees. Open-vote categories use the staff list.', 'error');
    openModal({
      title: nominee ? 'Edit nominee' : 'Add nominee',
      build(body, close) {
        const cat = h('select', { class: INPUT }, cats.map((c) => h('option', { value: String(c.id) }, c.title)));
        cat.value = String(nominee ? nominee.category_id : (categoryId || cats[0].id));
        const name = h('input', { type: 'text', required: true, maxLength: 120, placeholder: 'Full name or team name', class: INPUT, value: nominee ? nominee.name : '' });
        const bio = h('textarea', { rows: 3, maxLength: 1000, placeholder: 'Key accomplishments and background…', class: INPUT }); bio.value = nominee ? nominee.bio : '';
        const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'hidden', 'aria-label': 'Nominee photo' });
        const remove = h('input', { type: 'checkbox', class: 'mr-2' });
        const preview = h('div', { class: 'w-20 h-20 rounded-xl bg-slate-950 border border-slate-800 overflow-hidden flex items-center justify-center flex-shrink-0' });
        const showPreview = (url) => { clear(preview); preview.append(url ? h('img', { src: url, alt: 'Photo preview', class: 'w-full h-full object-cover' }) : icon('image', 'w-8 h-8 text-slate-600')); refreshIcons(); };
        showPreview(nominee ? nominee.image_url : null);
        file.addEventListener('change', () => {
          const f = file.files[0];
          if (f && !/^image\/(png|jpeg|webp)$/.test(f.type)) { file.value = ''; return toast('Choose a PNG, JPG or WEBP image.', 'error'); }
          if (f) { remove.checked = false; showPreview(URL.createObjectURL(f)); }
        });
        const error = formError();
        const save = h('button', { type: 'submit', class: BTN_PRIMARY }, 'Save nominee');
        body.append(h('form', {
          class: 'space-y-4',
          on: { submit: async (e) => {
            e.preventDefault(); error.classList.add('hidden');
            const form = new FormData();
            form.append('category_id', cat.value); form.append('name', name.value); form.append('bio', bio.value);
            if (file.files[0]) form.append('image', file.files[0]);
            if (remove.checked) form.append('remove_image', 'true');
            try {
              await busy(save, () => api(nominee ? `/api/admin/nominees/${nominee.id}` : '/api/admin/nominees', { method: nominee ? 'PUT' : 'POST', form }));
              close(); toast('Nominee saved.', 'success'); await refreshAdmin();
            } catch (ex) { showInline(error, ex.message); }
          } },
        },
          field('Category', cat), field('Nominee name', name), field('Bio or profile summary', bio),
          h('div', null,
            h('span', { class: 'block text-xs font-semibold text-slate-300 mb-1' }, 'Photo'),
            h('div', { class: 'flex items-start space-x-4' }, preview,
              h('div', { class: 'flex-1' }, file,
                h('button', { type: 'button', class: 'px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 rounded-lg transition', on: { click: () => file.click() } }, 'Choose image'),
                h('p', { class: 'text-[11px] text-slate-400 mt-1.5' }, 'PNG, JPG or WEBP up to 5 MB. Resized and stripped of metadata on upload.'),
                nominee && nominee.image_url && h('label', { class: 'flex items-center text-xs text-slate-300 mt-2' }, remove, 'Remove current photo')))),
          error,
          h('div', { class: 'pt-4 flex justify-end space-x-3 border-t border-slate-800/80' }, h('button', { type: 'button', class: BTN_GHOST, on: { click: () => close() } }, 'Cancel'), save)));
      },
    });
  }

  // ---- voters
  const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };

  function showCredentials({ title, intro, rows, skipped = [] }) {
    openModal({
      title, wide: true,
      build(body, close) {
        const copy = async () => {
          const text = rows.map((r) => `${r.name}\t${r.email}\t${r.temp_password}`).join('\n');
          try { await navigator.clipboard.writeText(text); toast('Copied to the clipboard.', 'success'); }
          catch { toast('Copying is blocked here. Download the CSV instead.', 'error'); }
        };
        const download = () => {
          const csv = ['name,email,temporary_password', ...rows.map((r) => [r.name, r.email, r.temp_password].map(csvCell).join(','))].join('\r\n');
          const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
          const a = h('a', { href: url, download: 'temporary-passwords.csv' });
          document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        body.append(
          h('div', { class: 'bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3 rounded-xl text-sm flex items-start gap-3 mb-4' },
            icon('triangle-alert', 'w-4 h-4 mt-0.5 flex-shrink-0'), h('p', null, intro || 'These temporary passwords are shown once and cannot be retrieved later. Each person must choose their own password at first sign-in.')),
          rows.length ? h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-left text-sm text-slate-300' },
            h('thead', { class: 'bg-slate-800/80 text-xs text-slate-400' }, h('tr', null, ['Name', 'Email', 'Temporary password'].map((t) => h('th', { class: 'p-3 font-semibold' }, t)))),
            h('tbody', { class: 'divide-y divide-slate-800' }, rows.map((r) => h('tr', null,
              h('td', { class: 'p-3 text-white' }, r.name), h('td', { class: 'p-3' }, r.email),
              h('td', { class: 'p-3 font-mono text-brand-300 select-all' }, r.temp_password)))))) : h('p', { class: 'text-sm text-slate-400' }, 'No new people were created.'),
          skipped.length > 0 && h('div', { class: 'mt-4' },
            h('p', { class: 'text-xs font-bold text-slate-400 mb-1' }, `Skipped (${skipped.length})`),
            h('ul', { class: 'text-xs text-slate-400 space-y-0.5 max-h-32 overflow-y-auto' }, skipped.map((s) => h('li', null, `${s.email || '(blank)'}: ${s.reason}`)))),
          h('div', { class: 'pt-6 flex justify-end space-x-3' },
            rows.length > 0 && h('button', { type: 'button', class: BTN_GHOST, on: { click: copy } }, 'Copy all'),
            rows.length > 0 && h('button', { type: 'button', class: BTN_GHOST, on: { click: download } }, 'Download CSV'),
            h('button', { type: 'button', class: BTN_PRIMARY, on: { click: () => close() } }, 'Done')));
      },
    });
  }

  function openUserModal() {
    openModal({
      title: 'Add person',
      build(body, close) {
        const name = h('input', { type: 'text', required: true, maxLength: 120, class: INPUT, autocomplete: 'off' });
        const email = h('input', { type: 'email', required: true, class: INPUT, autocomplete: 'off' });
        const role = h('select', { class: INPUT }, h('option', { value: 'voter' }, 'Voter'), h('option', { value: 'admin' }, 'Administrator'));
        const dept = h('input', { type: 'text', maxLength: 120, class: INPUT, autocomplete: 'off', placeholder: 'Optional' });
        const listed = h('input', { type: 'checkbox', class: 'mr-2', checked: true });
        role.addEventListener('change', () => { listed.checked = role.value === 'voter'; });
        const error = formError();
        const save = h('button', { type: 'submit', class: BTN_PRIMARY }, 'Create account');
        body.append(h('form', {
          class: 'space-y-4',
          on: { submit: async (e) => {
            e.preventDefault(); error.classList.add('hidden');
            try {
              const r = await busy(save, () => api('/api/admin/users', { method: 'POST', json: { name: name.value, email: email.value, role: role.value, department: dept.value, listed: listed.checked } }));
              close(); await refreshAdmin();
              showCredentials({ title: 'Account created', rows: [{ name: r.user.name, email: r.user.email, temp_password: r.temp_password }] });
            } catch (ex) { showInline(error, ex.message); }
          } },
        },
          field('Full name', name), field('Email address', email, 'This is what they sign in with.'),
          field('Department or job title', dept, 'Shown next to their name in open-vote lists.'), field('Role', role),
          h('label', { class: 'flex items-center text-xs text-slate-300' }, listed, 'Appears in staff lists for open-vote categories'),
          error,
          h('div', { class: 'pt-2 flex justify-end space-x-3' }, h('button', { type: 'button', class: BTN_GHOST, on: { click: () => close() } }, 'Cancel'), save)));
      },
    });
  }

  function openEditPersonModal(u) {
    openModal({
      title: `Edit ${u.name}`,
      build(body, close) {
        const name = h('input', { type: 'text', required: true, maxLength: 120, class: INPUT, value: u.name });
        const dept = h('input', { type: 'text', maxLength: 120, class: INPUT, value: u.department, placeholder: 'Optional' });
        const error = formError();
        const save = h('button', { type: 'submit', class: BTN_PRIMARY }, 'Save');
        body.append(h('form', {
          class: 'space-y-4',
          on: { submit: async (e) => {
            e.preventDefault(); error.classList.add('hidden');
            try {
              await busy(save, () => api(`/api/admin/users/${u.id}`, { method: 'PUT', json: { name: name.value, department: dept.value } }));
              close(); toast('Saved.', 'success'); await refreshAdmin();
            } catch (ex) { showInline(error, ex.message); }
          } },
        },
          field('Full name', name), field('Department or job title', dept, 'Shown next to their name in open-vote lists.'), error,
          h('div', { class: 'pt-2 flex justify-end space-x-3' }, h('button', { type: 'button', class: BTN_GHOST, on: { click: () => close() } }, 'Cancel'), save)));
      },
    });
  }

  function openImportModal() {
    openModal({
      title: 'Import voters', wide: true,
      build(body, close) {
        const text = h('textarea', { rows: 8, class: `${INPUT} font-mono`, placeholder: 'name,email,department\nAlice Dlamini,alice@example.com,Engineering\nBob Nkosi,bob@example.com,Operations' });
        const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', class: 'text-xs text-slate-300', 'aria-label': 'Choose a CSV file' });
        file.addEventListener('change', async () => { if (file.files[0]) text.value = await file.files[0].text(); });
        const error = formError();
        const save = h('button', { type: 'submit', class: BTN_PRIMARY }, 'Create accounts');
        body.append(h('form', {
          class: 'space-y-4',
          on: { submit: async (e) => {
            e.preventDefault(); error.classList.add('hidden');
            try {
              const r = await busy(save, () => api('/api/admin/users/import', { method: 'POST', json: { csv: text.value } }));
              close(); await refreshAdmin();
              showCredentials({ title: `${plural(r.created.length, 'account', 'accounts')} created`, rows: r.created, skipped: r.skipped });
            } catch (ex) { showInline(error, ex.message); }
          } },
        },
          h('p', { class: 'text-sm text-slate-400' }, 'One person per line: name, email and (optionally) department, separated by commas. A header row is fine. Up to 250 people at a time. Everyone imported becomes a voter and appears in open-vote lists.'),
          field('Paste list', text), field('Or choose a CSV file', file),
          error,
          h('div', { class: 'pt-2 flex justify-end space-x-3' }, h('button', { type: 'button', class: BTN_GHOST, on: { click: () => close() } }, 'Cancel'), save)));
      },
    });
  }

  function adminVoters() {
    const a = state.admin;
    const tbody = h('tbody', { class: 'divide-y divide-slate-800' });
    const summary = h('p', { class: 'text-xs text-slate-400' });

    const act = async (label, task, done) => {
      try { const r = await task(); await refreshAdmin(); if (done) done(r); else toast(label, 'success'); }
      catch (ex) { toast(ex.message, 'error'); }
    };
    const badge = (text, cls) => h('span', { class: `text-[11px] px-2 py-0.5 rounded-full font-semibold ${cls}` }, text);

    function fill() {
      const q = a.userFilter.trim().toLowerCase();
      const rows = a.users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
      summary.textContent = `${plural(a.users.filter((u) => u.active).length, 'active account', 'active accounts')}, ${a.users.filter((u) => u.role === 'admin').length} administrator(s), ${a.users.filter((u) => u.active && u.listed).length} in vote lists.`;
      clear(tbody);
      if (!rows.length) tbody.append(h('tr', null, h('td', { colSpan: 5, class: 'p-6 text-center text-slate-500 text-xs' }, a.users.length ? 'No one matches that search.' : 'No accounts yet. Add a person or import a list.')));
      for (const u of rows) {
        const me = u.id === state.user.id;
        tbody.append(h('tr', { class: 'hover:bg-slate-800/40 transition' },
          h('td', { class: 'p-3' }, h('p', { class: 'text-sm font-semibold text-white' }, u.name, me && h('span', { class: 'text-xs font-normal text-slate-400' }, ' (you)')), h('p', { class: 'text-xs text-slate-400' }, u.email), u.department && h('p', { class: 'text-xs text-slate-500' }, u.department)),
          h('td', { class: 'p-3' }, h('div', { class: 'flex flex-wrap gap-1.5' },
            badge(u.role === 'admin' ? 'Administrator' : 'Voter', u.role === 'admin' ? 'bg-brand-500/20 text-brand-300 border border-brand-500/30' : 'bg-slate-800 text-slate-300 border border-slate-700'),
            !u.active && badge('Disabled', 'bg-red-500/20 text-red-300 border border-red-500/30'),
            u.active && !u.listed && badge('Not in vote lists', 'bg-slate-800 text-slate-400 border border-slate-700'),
            u.locked && badge('Locked', 'bg-amber-500/20 text-amber-300 border border-amber-500/30'),
            u.must_change_password && badge('Temporary password', 'bg-slate-800 text-slate-400 border border-slate-700'))),
          h('td', { class: 'p-3 text-xs text-slate-300' }, plural(u.ballots_cast, 'ballot', 'ballots')),
          h('td', { class: 'p-3 text-xs text-slate-400' }, u.last_login_at ? fmtTime(u.last_login_at) : 'Never'),
          h('td', { class: 'p-3' }, h('div', { class: 'flex items-center justify-end' },
            iconBtn('pencil', `Edit ${u.name}`, () => openEditPersonModal(u)),
            iconBtn(u.listed ? 'list-x' : 'list-checks', u.listed ? `Remove ${u.name} from open-vote lists` : `Add ${u.name} to open-vote lists`,
              () => act(u.listed ? 'Removed from vote lists.' : 'Added to vote lists.', () => api(`/api/admin/users/${u.id}`, { method: 'PUT', json: { listed: !u.listed } }))),
            iconBtn('key-round', `Issue a new temporary password for ${u.name}`, async () => {
              if (await confirmDialog({ title: `Reset ${u.name}'s password?`, message: 'Their current password stops working, they are signed out everywhere, and they must set a new password after signing in with the temporary one.', confirmLabel: 'Issue temporary password' })) {
                act('', () => api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' }), (r) => showCredentials({ title: 'Temporary password issued', rows: [{ name: r.name, email: r.email, temp_password: r.temp_password }] }));
              }
            }),
            iconBtn(u.role === 'admin' ? 'shield-off' : 'shield', u.role === 'admin' ? `Make ${u.name} a voter` : `Make ${u.name} an administrator`, async () => {
              const toAdmin = u.role !== 'admin';
              if (await confirmDialog({ title: toAdmin ? `Make ${u.name} an administrator?` : `Remove administrator access for ${u.name}?`, message: toAdmin ? 'Administrators can manage categories, nominees, people and see the audit log.' : 'They will keep their account and can still vote.', confirmLabel: 'Confirm' })) {
                act(toAdmin ? 'Administrator added.' : 'Administrator access removed.', () => api(`/api/admin/users/${u.id}`, { method: 'PUT', json: { role: toAdmin ? 'admin' : 'voter' } }));
              }
            }, false, me),
            iconBtn(u.active ? 'user-x' : 'user-check', u.active ? `Disable ${u.name}` : `Enable ${u.name}`, async () => {
              if (!u.active || await confirmDialog({ title: `Disable ${u.name}?`, message: 'They are signed out immediately and cannot sign in until you enable the account again. Ballots they already cast stay counted.', confirmLabel: 'Disable account', danger: true })) {
                act(u.active ? 'Account disabled.' : 'Account enabled.', () => api(`/api/admin/users/${u.id}`, { method: 'PUT', json: { active: !u.active } }));
              }
            }, u.active, me)))));
      }
      refreshIcons();
    }

    const search = h('input', { type: 'search', placeholder: 'Search by name or email', 'aria-label': 'Search people', class: `${INPUT} sm:max-w-xs`, value: a.userFilter, on: { input: (e) => { a.userFilter = e.target.value; fill(); } } });
    const wrap = h('div', { class: 'glass-panel rounded-2xl p-6 space-y-4' },
      h('div', { class: 'flex flex-col sm:flex-row sm:items-center justify-between gap-3' }, search, summary),
      h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-left text-sm text-slate-300' },
        h('thead', { class: 'bg-slate-800/80 text-xs text-slate-400' }, h('tr', null, ['Person', 'Access', 'Turnout', 'Last sign-in', ''].map((t) => h('th', { class: 'p-3 font-semibold' }, t)))), tbody)));
    fill();
    return wrap;
  }

  // ---- audit log
  function adminAudit() {
    const a = state.admin.audit;
    const WARN = new Set(['LOGIN_FAILED', 'ACCOUNT_LOCKED']);
    const tbody = h('tbody', { class: 'divide-y divide-slate-800' });
    const pager = h('div', { class: 'flex items-center justify-between text-xs text-slate-400' });
    const verifyBox = h('div');
    const exportLink = h('a', { href: '#', download: '', class: `${BTN_GHOST} inline-flex items-center gap-2` }, icon('download'), 'Export CSV');

    function fill() {
      exportLink.href = `/api/admin/audit/export.csv${a.q ? `?q=${encodeURIComponent(a.q)}` : ''}`;
      clear(tbody);
      if (!a.items.length) tbody.append(h('tr', null, h('td', { colSpan: 5, class: 'p-6 text-center text-slate-500 text-xs' }, a.q ? 'Nothing matches that search.' : 'No activity recorded yet.')));
      for (const r of a.items) {
        tbody.append(h('tr', { class: 'hover:bg-slate-800/40 transition align-top' },
          h('td', { class: 'p-3 text-xs text-slate-400 font-mono whitespace-nowrap', title: `${r.ts} UTC` }, fmtTime(r.ts)),
          h('td', { class: 'p-3 text-xs font-semibold text-brand-400 break-all' }, r.actor_email, h('span', { class: 'block text-[11px] font-normal text-slate-500' }, r.actor_role)),
          h('td', { class: `p-3 text-xs font-bold ${WARN.has(r.action) ? 'text-red-300' : 'text-white'}` }, r.action),
          h('td', { class: 'p-3 text-xs text-slate-300' }, r.details),
          h('td', { class: 'p-3 text-xs text-slate-500 font-mono hidden md:table-cell' }, r.ip)));
      }
      const pages = Math.max(1, Math.ceil(a.total / a.per_page));
      clear(pager).append(
        h('span', null, `${plural(a.total, 'entry', 'entries')}, page ${a.page} of ${pages}`),
        h('div', { class: 'flex gap-2' },
          h('button', { type: 'button', class: BTN_GHOST, disabled: a.page <= 1, on: { click: () => go(a.page - 1) } }, 'Newer'),
          h('button', { type: 'button', class: BTN_GHOST, disabled: a.page >= pages, on: { click: () => go(a.page + 1) } }, 'Older')));
      refreshIcons();
    }
    async function go(page) { a.page = page; try { await loadAudit(); fill(); } catch (ex) { toast(ex.message, 'error'); } }

    let timer;
    const search = h('input', { type: 'search', placeholder: 'Search actor, action or details', 'aria-label': 'Search the audit log', class: `${INPUT} sm:max-w-sm`, value: a.q,
      on: { input: (e) => { clearTimeout(timer); timer = setTimeout(() => { a.q = e.target.value.trim(); go(1); }, 300); } } });

    async function verify(btn) {
      try {
        const v = await busy(btn, () => api('/api/admin/audit/verify'));
        const good = v.chain_ok && v.reconciliation_ok;
        clear(verifyBox).append(h('div', { class: `rounded-xl p-4 border text-sm space-y-3 ${good ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-100' : 'bg-red-500/10 border-red-500/30 text-red-100'}`, role: 'status' },
          h('p', { class: 'font-semibold flex items-center gap-2' }, icon(good ? 'shield-check' : 'shield-alert', 'w-4 h-4'),
            v.chain_ok ? `Audit chain intact: ${plural(v.entries_checked, 'entry', 'entries')} verified.` : `Audit chain broken at entry #${v.first_bad_id}. Entries from there onward cannot be trusted.`),
          h('p', { class: 'text-xs' }, 'Chain head: ', h('span', { class: 'font-mono break-all select-all' }, v.head_hash)),
          h('p', { class: 'text-xs opacity-80' }, 'Record this hash outside the system (for example in your working papers). A later check against it also exposes removal of the newest entries.'),
          h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-left text-xs' },
            h('thead', null, h('tr', { class: 'opacity-70' }, ['Category', 'Ballots', 'Votes expected', 'Votes stored', 'Match'].map((t) => h('th', { class: 'py-1 pr-3 font-semibold' }, t)))),
            h('tbody', null, v.reconciliation.length ? v.reconciliation.map((r) => h('tr', null,
              h('td', { class: 'py-1 pr-3' }, r.title), h('td', { class: 'py-1 pr-3' }, r.ballots), h('td', { class: 'py-1 pr-3' }, r.expected_votes),
              h('td', { class: 'py-1 pr-3' }, r.votes), h('td', { class: 'py-1 pr-3 font-semibold' }, r.ok ? 'Yes' : 'No — investigate'))) : h('tr', null, h('td', { colSpan: 5, class: 'py-1 opacity-70' }, 'No categories to reconcile.')))))));
        refreshIcons();
      } catch (ex) { toast(ex.message, 'error'); }
    }
    const verifyBtn = h('button', { type: 'button', class: `${BTN_PRIMARY} inline-flex items-center gap-2`, on: { click: () => verify(verifyBtn) } }, icon('shield-check'), 'Verify integrity');

    const wrap = h('div', { class: 'glass-panel rounded-2xl p-6 space-y-4' },
      h('div', { class: 'flex flex-col md:flex-row md:items-center justify-between gap-3' },
        h('div', null, h('h3', { class: 'text-lg font-bold text-white' }, 'Audit log'), h('p', { class: 'text-xs text-slate-400 mt-0.5' }, 'Append-only and hash-chained. Entries record who did what, never who voted for whom.')),
        h('div', { class: 'flex gap-2' }, verifyBtn, exportLink)),
      verifyBox, search,
      h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-left text-sm text-slate-300' },
        h('thead', { class: 'bg-slate-800/80 text-xs text-slate-400' }, h('tr', null,
          h('th', { class: 'p-3 font-semibold' }, 'Time'), h('th', { class: 'p-3 font-semibold' }, 'Actor'), h('th', { class: 'p-3 font-semibold' }, 'Action'),
          h('th', { class: 'p-3 font-semibold' }, 'Details'), h('th', { class: 'p-3 font-semibold hidden md:table-cell' }, 'Address'))), tbody)),
      pager);
    fill();
    return wrap;
  }

  // -------------------------------------------------------------------- start-up
  function init() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-error'); err.classList.add('hidden');
      const email = $('#login-email').value.trim(), password = $('#login-password').value;
      if (!email || !password) return showInline(err, 'Enter your email address and password.');
      try {
        const { user } = await busy($('#login-submit'), () => api('/api/auth/login', { method: 'POST', json: { email, password } }));
        $('#login-password').value = '';
        await afterSignIn(user);
      } catch (ex) { showInline(err, ex.message); }
    });
    $('#btn-signout').addEventListener('click', signOut);
    $('#forced-signout').addEventListener('click', signOut);
    $('#btn-change-password').addEventListener('click', () => openModal({
      title: 'Change password',
      build(body, close) { body.append(passwordForm({ forced: false, onDone: (user) => { state.user = user; close(); toast('Password updated. Other devices were signed out.', 'success'); } })); },
    }));

    // Big Screen Event Listeners
    const btnHeaderBig = $('#btn-header-bigscreen');
    if (btnHeaderBig) btnHeaderBig.addEventListener('click', enterBigScreen);
    const btnLoginBig = $('#btn-login-bigscreen');
    if (btnLoginBig) btnLoginBig.addEventListener('click', enterBigScreen);

    window.addEventListener('keydown', (e) => {
      if (!state.bigScreen.active) return;
      if (e.key === 'Escape') {
        if (state.bigScreen.showSettings) {
          state.bigScreen.showSettings = false;
          renderBigScreen();
          return;
        }
        exitBigScreen();
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        state.bigScreen.autoRotate = !state.bigScreen.autoRotate;
        renderBigScreen();
        toast(state.bigScreen.autoRotate ? 'Auto-rotate resumed' : 'Auto-rotate paused');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (state.results && state.results.categories && state.results.categories.length) {
          state.bigScreen.catIndex = (state.bigScreen.catIndex + 1) % state.results.categories.length;
          state.bigScreen.countdownSec = state.bigScreen.rotateIntervalSec;
          renderBigScreenStage({ animate: true });
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (state.results && state.results.categories && state.results.categories.length) {
          state.bigScreen.catIndex = (state.bigScreen.catIndex - 1 + state.results.categories.length) % state.results.categories.length;
          state.bigScreen.countdownSec = state.bigScreen.rotateIntervalSec;
          renderBigScreenStage({ animate: true });
        }
      } else if (e.key === 'c' || e.key === 'C') {
        celebrate();
      } else if (e.key === 'f' || e.key === 'F') {
        toggleBigScreenFullscreen();
      } else if (e.key === 't' || e.key === 'T') {
        toggleBigScreenTheme();
      } else if (e.key === 's' || e.key === 'S') {
        state.bigScreen.showSettings = !state.bigScreen.showSettings;
        renderBigScreen();
      }
    });

    window.addEventListener('hashchange', () => {
      if ((location.hash === '#bigscreen' || location.hash === '#screen') && !state.bigScreen.active) {
        enterBigScreen();
      } else if (state.bigScreen.active && location.hash !== '#bigscreen' && location.hash !== '#screen') {
        exitBigScreen();
      }
    });

    api('/api/auth/me')
      .then(({ user }) => {
        if (location.hash === '#bigscreen' || location.hash === '#screen') {
          if (user) state.user = user;
          enterBigScreen();
        } else if (user) {
          afterSignIn(user);
        } else {
          showScreen('login');
        }
      })
      .catch(() => {
        if (location.hash === '#bigscreen' || location.hash === '#screen') {
          enterBigScreen();
        } else {
          showScreen('login');
        }
      });
  }
  init();
})();
