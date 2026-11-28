-- reader-floor: 1202
-- Full import preserves an installation's inbound trust. A deleting tenant no longer
-- serves it, even when data cleanup and object settling still have work to do.
ALTER TABLE tenants ADD COLUMN import_fingerprint bytea CHECK (octet_length(import_fingerprint)=32);
CREATE UNIQUE INDEX tenants_live_import ON tenants(import_fingerprint)
    WHERE import_fingerprint IS NOT NULL AND state<>'deleting';
