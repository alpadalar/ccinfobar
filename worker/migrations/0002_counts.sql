-- entry counts kept by triggers, so caps never count rows (CR-01)

ALTER TABLE publishers ADD COLUMN live INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publishers ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publishers ADD COLUMN tombs INTEGER NOT NULL DEFAULT 0;

UPDATE publishers SET
  live = (SELECT COUNT(*) FROM entries e WHERE e.publisher = publishers.handle AND e.state = 'live'),
  pending = (SELECT COUNT(*) FROM entries e WHERE e.publisher = publishers.handle AND e.state = 'pending'),
  tombs = (SELECT COUNT(*) FROM entries e
    WHERE e.publisher = publishers.handle AND e.state IN ('withdrawn', 'removed'));

INSERT INTO counters (k, n) VALUES
  ('live', (SELECT COUNT(*) FROM entries WHERE state = 'live')),
  ('pending', (SELECT COUNT(*) FROM entries WHERE state = 'pending')),
  ('tombs', (SELECT COUNT(*) FROM entries WHERE state IN ('withdrawn', 'removed')));

CREATE TRIGGER entries_count_insert AFTER INSERT ON entries
BEGIN
  UPDATE counters SET n = n + 1 WHERE k = iif(new.state IN ('withdrawn', 'removed'), 'tombs', new.state);
  UPDATE publishers SET live = live + (new.state = 'live'), pending = pending + (new.state = 'pending'),
    tombs = tombs + (new.state IN ('withdrawn', 'removed'))
    WHERE handle = new.publisher;
END;

CREATE TRIGGER entries_count_delete AFTER DELETE ON entries
BEGIN
  UPDATE counters SET n = n - 1 WHERE k = iif(old.state IN ('withdrawn', 'removed'), 'tombs', old.state);
  UPDATE publishers SET live = live - (old.state = 'live'), pending = pending - (old.state = 'pending'),
    tombs = tombs - (old.state IN ('withdrawn', 'removed'))
    WHERE handle = old.publisher;
END;

CREATE TRIGGER entries_count_state AFTER UPDATE OF state ON entries WHEN old.state IS NOT new.state
BEGIN
  UPDATE counters SET n = n - 1 WHERE k = iif(old.state IN ('withdrawn', 'removed'), 'tombs', old.state);
  UPDATE counters SET n = n + 1 WHERE k = iif(new.state IN ('withdrawn', 'removed'), 'tombs', new.state);
  UPDATE publishers SET live = live - (old.state = 'live') + (new.state = 'live'),
    pending = pending - (old.state = 'pending') + (new.state = 'pending'),
    tombs = tombs - (old.state IN ('withdrawn', 'removed')) + (new.state IN ('withdrawn', 'removed'))
    WHERE handle = new.publisher;
END;

-- the index rebuild reads summaries from here only
CREATE INDEX entries_live ON entries (publisher, slug, summary) WHERE state = 'live';
CREATE INDEX publishers_banned ON publishers (handle) WHERE banned_at IS NOT NULL;
