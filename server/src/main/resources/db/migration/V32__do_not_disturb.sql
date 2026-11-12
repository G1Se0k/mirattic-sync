-- 방해 금지 (decision 121): kept with the account, shown to friends while online.
ALTER TABLE users ADD COLUMN do_not_disturb BOOLEAN NOT NULL DEFAULT FALSE;
