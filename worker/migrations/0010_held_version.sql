-- a trusted publisher's version waiting for link review (17-D-17); null when none
ALTER TABLE entries ADD COLUMN held TEXT;
-- the held list reads only these rows
CREATE INDEX entries_held ON entries (publisher, slug) WHERE held IS NOT NULL;
