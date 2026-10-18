-- old rate rows go in small batches, found by window (DoS audit)
CREATE INDEX rate_by_win ON rate (win);
