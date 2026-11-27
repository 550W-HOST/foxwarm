-- reader-floor: 1
-- An interrupted Agent-volume import cannot activate a partially imported tenant, and an
-- Agent-only retry or abandon never completes an interrupted full-installation import.
ALTER TABLE tenants DROP CONSTRAINT tenants_state_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_state_check
    CHECK (state IN ('importing', 'importing-agents', 'active', 'suspended', 'deleting'));
