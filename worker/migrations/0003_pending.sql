-- stored bytes kept by triggers, pending bytes apart, and the publishers count (WR-02)

ALTER TABLE publishers ADD COLUMN pending_bytes INTEGER NOT NULL DEFAULT 0;

UPDATE publishers SET
  bytes = (SELECT COALESCE(SUM(length(CAST(v.body AS BLOB))), 0) FROM versions v
    WHERE v.publisher = publishers.handle),
  pending_bytes = (SELECT COALESCE(SUM(length(CAST(v.body AS BLOB))), 0) FROM versions v
    JOIN entries e ON e.publisher = v.publisher AND e.slug = v.slug
    WHERE v.publisher = publishers.handle AND e.state = 'pending');

INSERT INTO counters (k, n) VALUES ('publishers', (SELECT COUNT(*) FROM publishers));

CREATE TRIGGER publishers_count AFTER INSERT ON publishers
BEGIN
  UPDATE counters SET n = n + 1 WHERE k = 'publishers';
END;

CREATE TRIGGER versions_bytes_insert AFTER INSERT ON versions
BEGIN
  UPDATE publishers SET bytes = bytes + COALESCE(length(CAST(new.body AS BLOB)), 0),
    pending_bytes = pending_bytes + COALESCE(length(CAST(new.body AS BLOB)), 0)
      * COALESCE((SELECT state = 'pending' FROM entries WHERE publisher = new.publisher AND slug = new.slug), 0)
    WHERE handle = new.publisher;
END;

CREATE TRIGGER versions_bytes_update AFTER UPDATE OF body ON versions
BEGIN
  UPDATE publishers SET
    bytes = bytes + COALESCE(length(CAST(new.body AS BLOB)), 0) - COALESCE(length(CAST(old.body AS BLOB)), 0),
    pending_bytes = pending_bytes
      + (COALESCE(length(CAST(new.body AS BLOB)), 0) - COALESCE(length(CAST(old.body AS BLOB)), 0))
      * COALESCE((SELECT state = 'pending' FROM entries WHERE publisher = new.publisher AND slug = new.slug), 0)
    WHERE handle = new.publisher;
END;

CREATE TRIGGER versions_bytes_delete AFTER DELETE ON versions
BEGIN
  UPDATE publishers SET bytes = bytes - COALESCE(length(CAST(old.body AS BLOB)), 0),
    pending_bytes = pending_bytes - COALESCE(length(CAST(old.body AS BLOB)), 0)
      * COALESCE((SELECT state = 'pending' FROM entries WHERE publisher = old.publisher AND slug = old.slug), 0)
    WHERE handle = old.publisher;
END;

-- an entry that enters or leaves pending moves its bytes
CREATE TRIGGER entries_pending_bytes AFTER UPDATE OF state ON entries
  WHEN (old.state = 'pending') <> (new.state = 'pending')
BEGIN
  UPDATE publishers SET pending_bytes = pending_bytes + ((new.state = 'pending') - (old.state = 'pending'))
    * (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM versions
      WHERE publisher = new.publisher AND slug = new.slug)
    WHERE handle = new.publisher;
END;

CREATE TRIGGER entries_pending_bytes_insert AFTER INSERT ON entries WHEN new.state = 'pending'
BEGIN
  UPDATE publishers SET pending_bytes = pending_bytes + (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0)
    FROM versions WHERE publisher = new.publisher AND slug = new.slug)
    WHERE handle = new.publisher;
END;

CREATE TRIGGER entries_pending_bytes_delete AFTER DELETE ON entries WHEN old.state = 'pending'
BEGIN
  UPDATE publishers SET pending_bytes = pending_bytes - (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0)
    FROM versions WHERE publisher = old.publisher AND slug = old.slug)
    WHERE handle = old.publisher;
END;
