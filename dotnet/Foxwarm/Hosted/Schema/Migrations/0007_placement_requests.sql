-- reader-floor: 1
-- A request belongs to this grant. A move survives hand-back until the next acquisition.
ALTER TABLE tenant_leases ADD COLUMN requested_action text
    CHECK (requested_action IN ('move','release'));
