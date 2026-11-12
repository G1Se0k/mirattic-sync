-- 오프라인으로 표시 (decision 120): friends see the user as offline while they are online.
ALTER TABLE users ADD COLUMN appear_offline BOOLEAN NOT NULL DEFAULT FALSE;
