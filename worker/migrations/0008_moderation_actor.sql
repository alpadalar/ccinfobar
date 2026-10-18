-- who acted: an admin, or a publisher on their own entry (IN-02)
ALTER TABLE moderation ADD COLUMN actor TEXT NOT NULL DEFAULT 'admin' CHECK (actor IN ('admin', 'publisher'));
UPDATE moderation SET actor = 'publisher' WHERE action = 'withdraw-pending';
