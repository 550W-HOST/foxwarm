-- reader-floor: 2
-- The persistent text-redaction cache (ITextRedactionStore). Record identities and payloads
-- are the file store's bytes: keyed hashes and AES-GCM records under the tenant's derived
-- redaction key. `text_redaction_meta` holds the key check.

CREATE TABLE text_redaction_meta (
    tenant_id integer NOT NULL,
    key text COLLATE "C" NOT NULL,
    value bytea NOT NULL,
    PRIMARY KEY (tenant_id, key)
);
SELECT foxwarm_tenant_table('text_redaction_meta', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE text_redaction_slots (
    tenant_id integer NOT NULL,
    identity bytea NOT NULL,
    slot bytea NOT NULL,
    data bytea NOT NULL,
    used bigint NOT NULL,
    PRIMARY KEY (tenant_id, identity, slot)
);
SELECT foxwarm_tenant_table('text_redaction_slots', 'SELECT, INSERT, UPDATE, DELETE');
CREATE INDEX text_redaction_slots_used ON text_redaction_slots (tenant_id, used, identity, slot);

CREATE TABLE text_redaction_known (
    tenant_id integer NOT NULL,
    id bytea NOT NULL,
    data bytea NOT NULL,
    seq bigint NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
SELECT foxwarm_tenant_table('text_redaction_known', 'SELECT, INSERT, UPDATE, DELETE');
CREATE INDEX text_redaction_known_seq ON text_redaction_known (tenant_id, seq);
