// api/stats.js
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { data, error } = await supabase.from('leave_requests').select('status');
  if (error) return res.status(500).json({ error: error.message });
  const stats = { pending:0, approved:0, rejected:0, total: data.length };
  data.forEach(r => { if (r.status in stats) stats[r.status]++; });
  return res.status(200).json(stats);
}
