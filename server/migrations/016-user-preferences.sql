ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('system','light','dark'));
ALTER TABLE users ADD COLUMN sound_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sound_enabled IN (0,1));
