INSERT INTO expense_categories (id, name, is_wage, is_taxable, is_active, sort_order, note, created_at, updated_at, created_by)
VALUES ('EC0007', '油資', false, false, true, 7, '汽油費/油資實報實銷代墊', now(), now(), 'EMP_01250901')
ON CONFLICT (id) DO NOTHING;
