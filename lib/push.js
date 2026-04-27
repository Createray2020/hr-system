// lib/push.js — 共用 Web Push 推播輔助函式
import webpush from 'web-push';
import { supabaseAdmin } from './supabase.js';
import { resolveRoleSetToEmployeeIds } from './roles.js';

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@chuwa.hr',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

/**
 * 發送推播通知給指定員工 ID 列表
 */
export async function sendPushToEmployees(employeeIds, { title, body, url = '/dashboard.html', tag }) {
  if (!process.env.VAPID_PUBLIC_KEY || !employeeIds?.length) return { sent: 0 };

  const { data: subs } = await supabaseAdmin
    .from('push_subscriptions')
    .select('employee_id, subscription')
    .in('employee_id', employeeIds);

  if (!subs?.length) return { sent: 0 };

  const results = await Promise.allSettled(
    subs.map(sub =>
      webpush.sendNotification(
        JSON.parse(sub.subscription),
        JSON.stringify({ title, body, url, tag }),
      )
    )
  );

  return {
    sent:  results.filter(r => r.status === 'fulfilled').length,
    total: subs.length,
  };
}

/**
 * 發送推播通知給某些角色的所有員工。
 * 'manager' 會解析為 is_manager=true 的員工（舊 approvals 的 approver_role 相容）。
 */
export async function sendPushToRoles(roles, payload) {
  if (!roles?.length) return { sent: 0 };
  const ids = await resolveRoleSetToEmployeeIds(roles, supabaseAdmin);
  return sendPushToEmployees(ids, payload);
}

/**
 * 寫入 notifications 資料表（讓通知中心可顯示）
 */
export async function createNotification(employeeId, { title, body = '', url = '/dashboard.html', type = 'info' }) {
  try {
    await supabaseAdmin.from('notifications').insert([{
      id: `NOTIF_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      employee_id: employeeId,
      title,
      body,
      url,
      type,
      is_read: false,
    }]);
  } catch(e) {
    console.error('createNotification 失敗：', e);
  }
}

/**
 * 寫入 notifications 給多個員工
 */
export async function createNotifications(employeeIds, payload) {
  await Promise.allSettled((employeeIds || []).map(id => createNotification(id, payload)));
}

/**
 * 寫入 notifications 給某些角色的所有員工。
 * 'manager' 會解析為 is_manager=true 的員工。
 */
export async function createNotificationsForRoles(roles, payload) {
  if (!roles?.length) return;
  const ids = await resolveRoleSetToEmployeeIds(roles, supabaseAdmin);
  await createNotifications(ids, payload);
}
