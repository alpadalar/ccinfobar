-- one index rebuild at a time: the start time of the running one, 0 when none (cap audit)
INSERT INTO counters (k, n) VALUES ('rebuilding', 0);
