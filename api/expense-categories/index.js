// api/expense-categories/index.js
// GET  /api/expense-categories[?include_inactive=true]   清單(任何登入者可看)
// POST /api/expense-categories                           HR/admin 新建類別
//
// 對齊風格:api/attendance-penalties/index.js + api/holidays/index.js

import { requireAuth, requireRole } from '../../lib/auth.js';
import { BACKOFFICE_ROLES } from '../../lib/roles.js';
import { makeExpenseCategoryRepo } from './_repo.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const repo = makeExpenseCategoryRepo();
    try {
      const categories = await repo.listCategories({
        includeInactive: req.query.include_inactive === 'true',
      });
      return res.status(200).json({ categories });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const caller = await requireRole(req, res, BACKOFFICE_ROLES);
    if (!caller) return;

    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: '類別名稱必填' });

    const repo = makeExpenseCategoryRepo();
    try {
      const sortOrder = body.sort_order != null && body.sort_order !== ''
        ? parseInt(body.sort_order)
        : await repo.nextSortOrder();

      const row = {
        id: 'EC' + Date.now(),
        name,
        is_wage:    body.is_wage    === true,                           // default false
        is_taxable: body.is_taxable === undefined ? true : body.is_taxable === true,  // default true
        is_active:  body.is_active  === undefined ? true : body.is_active  === true,  // default true
        sort_order: Number.isInteger(sortOrder) ? sortOrder : 0,
        note: body.note ?? null,
        created_by: caller.id || null,
      };

      const created = await repo.insertCategory(row);
      return res.status(201).json({ category: created });
    } catch (e) {
      // Postgres 23505 = UNIQUE 違反(本表 UNIQUE(name))
      if (e?.code === '23505') {
        return res.status(409).json({ error: '已有同名類別' });
      }
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
