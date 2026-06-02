-- 夜間津貼資格改採「班別分類」:晚班/夜班領、日班/中班不領;另留逐筆 override 空間
ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS night_allowance_eligible BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN shift_types.night_allowance_eligible IS '此班別是否享夜間津貼(晚班/夜班=true);可調';

-- 晚班(flex) ST002 / 晚班 ST006 / 夜班 ST007 設為 eligible
UPDATE shift_types SET night_allowance_eligible = true WHERE id IN ('ST002','ST006','ST007');

-- 單筆排班特殊個案 override:null=依班別預設、true/false=強制
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS night_eligible_override BOOLEAN;
COMMENT ON COLUMN schedules.night_eligible_override IS '夜間津貼資格逐筆覆寫:null 依 shift_types.night_allowance_eligible、true/false 強制';
