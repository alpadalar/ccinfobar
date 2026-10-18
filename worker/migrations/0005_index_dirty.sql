-- the generation of the last write the index must show, and the daily rebuild budget (WR-03)
INSERT INTO counters (k, n) VALUES
  ('dirty', (SELECT n FROM counters WHERE k = 'gen')),
  ('rebuild_day', 0),
  ('rebuild_rows', 0),
  ('rebuilt_at', 0);
