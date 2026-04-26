// lib/attendance/absence-sweep.js — cron：曠職判定（純函式 + repo 注入式）
//
// 對應設計文件：docs/attendance-system-design-v1.md §4.2.4 / §6.4
// 對應實作計畫：docs/attendance-system-implementation-plan-v1.md §6.3
//
// cron schedule：每天 00:15（透過 api/cron-absence-detection.js）
//
// 規則（嚴格依規範）：
//   1. 找昨日（today - 1）的 schedules 中其 period.status='locked' 的所有員工×段次
//   2. 對每筆 (employee_id, date, segment_no)：
//      a. 已有 attendance 且有 clock_in → normal_count++（不動）
//      b. 該天有 approved leave_request 涵蓋 → 寫 status='leave'，is_anomaly=false
//      c. 否則 → 寫 status='absent'、is_anomaly=false（先當曠職，HR 之後可改）
//   3. 寫 absent 的同時觸發推播給：員工 + 主管 + HR

/**
 * Repo 介面契約：
 *   findLockedSchedulesByDate(date): Array<{ id, employee_id, segment_no, period_id, ... }>
 *     只回 schedule_periods.status='locked' 對應的 schedules
 *   findAttendanceByDateSegment(employee_id, date, segment_no): row | null
 *   findApprovedLeaveCovering(employee_id, date): leave_request row | null
 *     某天有沒有 approved 的請假涵蓋（start_at <= date_end 且 end_at >= date_start）
 *   getEmployeeManager(employee_id): { id, manager_id } | null
 *   upsertAttendance(row): row
 *   notifyAbsence({ employee_id, manager_id, work_date, segment_no }): { ok }
 */

export async function runAbsenceSweep(repo, today) {
  requireRepo(repo, [
    'findLockedSchedulesByDate', 'findAttendanceByDateSegment',
    'findApprovedLeaveCovering', 'getEmployeeManager',
    'upsertAttendance', 'notifyAbsence',
  ]);
  if (!today) throw new Error('today required');

  const yesterday = subtractDay(today);
  const schedules = await repo.findLockedSchedulesByDate(yesterday);

  let absent_count = 0, leave_count = 0, normal_count = 0;

  for (const s of (schedules || [])) {
    const att = await repo.findAttendanceByDateSegment(
      s.employee_id, yesterday, s.segment_no,
    );
    if (att && att.clock_in) {
      normal_count += 1;
      continue;
    }

    const leave = await repo.findApprovedLeaveCovering(s.employee_id, yesterday);
    if (leave) {
      await repo.upsertAttendance({
        id: att?.id || `A_${s.employee_id}_${yesterday.replace(/-/g, '')}_${s.segment_no}`,
        employee_id: s.employee_id,
        work_date: yesterday,
        schedule_id: s.id,
        segment_no: s.segment_no,
        clock_in: null,
        clock_out: null,
        late_minutes: 0,
        early_leave_minutes: 0,
        status: 'leave',
        is_anomaly: false,
        anomaly_note: null,
      });
      leave_count += 1;
      continue;
    }

    // 曠職：先當 absent，is_anomaly=false（HR 之後可透過 anomaly API 標）
    await repo.upsertAttendance({
      id: att?.id || `A_${s.employee_id}_${yesterday.replace(/-/g, '')}_${s.segment_no}`,
      employee_id: s.employee_id,
      work_date: yesterday,
      schedule_id: s.id,
      segment_no: s.segment_no,
      clock_in: null,
      clock_out: null,
      late_minutes: 0,
      early_leave_minutes: 0,
      status: 'absent',
      is_anomaly: false,
      anomaly_note: null,
    });
    absent_count += 1;

    const empInfo = await repo.getEmployeeManager(s.employee_id);
    await repo.notifyAbsence({
      employee_id: s.employee_id,
      manager_id: empInfo?.manager_id || null,
      work_date: yesterday,
      segment_no: s.segment_no,
    });
  }

  return { absent_count, leave_count, normal_count, swept_date: yesterday };
}

// ─── internal ─────────────────────────────────────────────

function requireRepo(repo, methods) {
  if (!repo) throw new Error('repo required');
  for (const m of methods) {
    if (typeof repo[m] !== 'function') {
      throw new Error(`repo.${m} is required`);
    }
  }
}

function subtractDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
