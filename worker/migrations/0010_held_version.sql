-- a trusted publisher's version waiting for link review (17-D-02); null when none
ALTER TABLE entries ADD COLUMN held TEXT;
