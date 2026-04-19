// api/calendar/index.js — Google Calendar proxy + Taiwan holidays
// GET ?_resource=holidays&year=YYYY  → 台灣行事曆假日清單
// GET ?_resource=events&start=ISO&end=ISO → Google Calendar 事件（Proxy）

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { _resource, year, start, end } = req.query;

  // ── 台灣國定假日 ─────────────────────────────────────────────────
  if (_resource === 'holidays') {
    const y = parseInt(year) || new Date().getFullYear();
    try {
      const r = await fetch(
        `https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${y}.json`
      );
      if (!r.ok) return res.status(502).json({ error: '無法取得假日資料' });
      const raw = await r.json();
      const holidays = raw
        .filter(d => d.isHoliday)
        .map(d => ({
          date:  `${String(d.date).slice(0,4)}-${String(d.date).slice(4,6)}-${String(d.date).slice(6,8)}`,
          title: d.description || '假日',
          color: 'holiday',
          source: 'holidays',
        }));
      return res.status(200).json(holidays);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── Google Calendar 事件 ─────────────────────────────────────────
  const API_KEY = process.env.GOOGLE_API_KEY;
  const CAL_ID  = process.env.GOOGLE_CALENDAR_ID;

  console.log('[calendar] API_KEY exists:', !!API_KEY);
  console.log('[calendar] CALENDAR_ID:', CAL_ID || '(未設定)');

  if (!API_KEY || !CAL_ID) {
    return res.status(500).json({
      error:         '缺少環境變數，請在 Vercel 設定 GOOGLE_API_KEY 和 GOOGLE_CALENDAR_ID',
      hasKey:        !!API_KEY,
      hasCalendarId: !!CAL_ID,
    });
  }

  try {
    const now = new Date();
    const timeMin = start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const timeMax = end   || new Date(now.getFullYear(), now.getMonth() + 2, 1).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events`
      + `?key=${API_KEY}&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
      + `&singleEvents=true&orderBy=startTime&maxResults=250`;

    console.log('[calendar] Fetching URL:', url.replace(API_KEY, 'API_KEY_HIDDEN'));

    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || 'Google Calendar 錯誤' });
    }
    const data = await r.json();
    const events = (data.items || []).map(e => ({
      id:        e.id,
      title:     e.summary || '(無標題)',
      start:     e.start?.date || e.start?.dateTime?.slice(0, 10),
      end:       e.end?.date   || e.end?.dateTime?.slice(0, 10),
      allDay:    !!e.start?.date,
      // 保留本地時間字串（dateTime 格式含時區偏移，取第 11-16 位即本地 HH:MM）
      startTime: e.start?.dateTime ? e.start.dateTime.substring(11, 16) : null,
      endTime:   e.end?.dateTime   ? e.end.dateTime.substring(11, 16)   : null,
      desc:      e.description || '',
      color:     'gcal',
      source:    'gcal',
    }));
    return res.status(200).json(events);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
