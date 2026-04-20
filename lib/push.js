// lib/push.js — 共用 Web Push 推播輔助函式
import webpush from 'web-push';
import { supabase } from './supabase.js';

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

  const { data: subs } = await supabase
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
 * 發送推播通知給某些角色的所有員工
 */
export async function sendPushToRoles(roles, payload) {
  if (!roles?.length) return { sent: 0 };
  const { data: emps } = await supabase
    .from('employees').select('id').in('role', roles).eq('status', 'active');
  return sendPushToEmployees((emps || []).map(e => e.id), payload);
}
