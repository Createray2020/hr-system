// public/js/pwa.js — PWA 初始化 & 推播通知
const VAPID_PUBLIC_KEY = 'BO_tfAfRgPpYgzJvCnZDdxJfpjELOW05Ywuwr_4VA3m34PqqkZFHdmT6-NKEJEEjmjOsPHHxorpG3Ya2-BBvLnk';

const PWA = {
  registration: null,

  // 初始化 Service Worker
  async init() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      PWA.registration = reg;
      await PWA.checkNotificationPermission();
    } catch(e) {
      console.warn('SW registration failed:', e);
    }
  },

  // 檢查通知權限
  async checkNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      await PWA.subscribePush();
    } else if (Notification.permission === 'default') {
      // 延遲顯示提示，等使用者進入頁面後
      setTimeout(() => PWA.showNotificationPrompt(), 3000);
    }
  },

  // 顯示通知提示橫幅
  showNotificationPrompt() {
    if (document.getElementById('notif-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'notif-banner';
    banner.style.cssText = [
      'position:fixed;bottom:20px;left:50%;transform:translateX(-50%)',
      'background:#1E2333;border:1px solid rgba(91,141,239,.35)',
      'border-radius:14px;padding:14px 18px;display:flex;align-items:center',
      'gap:12px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.5)',
      'max-width:380px;width:calc(100% - 40px);animation:slideUp .3s ease',
    ].join(';');
    banner.innerHTML = `
      <span style="font-size:26px;flex-shrink:0">🔔</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:#E8EAF0;margin-bottom:2px">開啟通知提醒</div>
        <div style="font-size:11px;color:rgba(255,255,255,.45);line-height:1.4">接收審批待辦和重要通知</div>
      </div>
      <button onclick="PWA.requestPermission()" style="background:#5B8DEF;border:none;border-radius:8px;padding:7px 14px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">允許</button>
      <button onclick="document.getElementById('notif-banner').remove()" style="background:transparent;border:none;color:rgba(255,255,255,.35);font-size:20px;cursor:pointer;padding:0 2px;flex-shrink:0;line-height:1">✕</button>
    `;
    document.body.appendChild(banner);
    setTimeout(() => banner?.remove(), 15000);
  },

  // 請求通知權限
  async requestPermission() {
    document.getElementById('notif-banner')?.remove();
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await PWA.subscribePush();
      PWA.showLocalNotification('CHUWA HR 通知已開啟 🎉', '你將收到審批待辦和重要通知');
    }
  },

  // 訂閱 Web Push
  async subscribePush() {
    if (!PWA.registration) return;
    try {
      const sub = await PWA.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: PWA.urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      const empId = window.currentUser?.id;
      if (!empId) return;
      await fetch('/api/push', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'subscribe', employee_id: empId, subscription: sub }),
      });
    } catch(e) {
      console.warn('Push subscription failed:', e);
    }
  },

  // 本地通知（不需要推播）
  showLocalNotification(title, body) {
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body,
        icon:  '/icons/icon-192.png',
        badge: '/icons/icon-72.png',
      });
    }
  },

  // 更新通知角標數字
  async updateBadge(count) {
    const badge = document.getElementById('notif-badge');
    if (badge) {
      badge.textContent  = count > 99 ? '99+' : String(count);
      badge.style.display = count > 0 ? 'flex' : 'none';
    }
    try {
      if (count > 0 && 'setAppBadge' in navigator)  await navigator.setAppBadge(count);
      if (count === 0 && 'clearAppBadge' in navigator) await navigator.clearAppBadge();
    } catch(_) {}
  },

  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  },
};
