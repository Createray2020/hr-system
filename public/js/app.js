// public/js/app.js — 所有頁面共用
const SUPABASE_URL = 'https://scsgqxixmbompnoypuuw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjc2dxeGl4bWJvbXBub3lwdXV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MzkxODMsImV4cCI6MjA5MjAxNTE4M30.DRuX4OoQDQSQfvqb71VgSmDysli7e_w8lvsdp3p_VA8';

// API base（自動偵測 local/production）
window.API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3000' : '';

// ── Supabase Auth（前端直連）────────────────────────────
const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window._supabase = _supabase;

// ── API helper ──────────────────────────────────────────
window.api = async function(path, opts = {}) {
  const session = await _supabase.auth.getSession();
  const token   = session?.data?.session?.access_token;
  const res = await fetch(API + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
};

// ── Auth guard（非登入頁呼叫）──────────────────────────
window.requireAuth = async function() {
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return null;
  }
  return session;
};

// ── 登出 ────────────────────────────────────────────────
window.logout = async function() {
  await _supabase.auth.signOut();
  window.location.href = '/login.html';
};

// ── Toast ────────────────────────────────────────────────
window.toast = function(msg, type = 'success') {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    wrap.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

// ── Nav active state ────────────────────────────────────
window.setActiveNav = function(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
};
