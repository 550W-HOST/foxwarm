-- reader-floor: 1200
-- Older readers do not observe credential rotation or retire a stale generation.
ALTER TABLE tenants
    ADD COLUMN object_identity text COLLATE "C",
    ADD COLUMN settings_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN credential_version bigint NOT NULL DEFAULT 0;

-- Existing rows retain their old blob namespace. Every new tenant takes a new identity,
-- including rows made by import and migration rather than by the operator process.
CREATE FUNCTION foxwarm_set_object_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.object_identity := NEW.tenant_id::text || '-' || to_char(NEW.created_at AT TIME ZONE 'UTC','YYYYMMDD"T"HH24:MI:SS.US"Z"');
    RETURN NEW;
END $$;
CREATE TRIGGER foxwarm_set_object_identity BEFORE INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION foxwarm_set_object_identity();

-- No replica table grants. Its owner can read the active lease's access verifier through
-- the scoped snapshot, never the setup digest. The operator can replace a setup token,
-- but only the migration identity can issue operator credentials.
CREATE TABLE tenant_auth (
    tenant_id integer PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    version bigint NOT NULL CHECK (version > 0),
    setup_hash bytea NOT NULL CHECK (octet_length(setup_hash)=32),
    expires_at timestamptz NOT NULL,
    credential_hash bytea CHECK (octet_length(credential_hash)=32),
    download_key bytea NOT NULL CHECK (octet_length(download_key)=32)
);

CREATE FUNCTION foxwarm_operator_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.settings_revision := OLD.settings_revision + 1;
    RETURN NEW;
END
$$;
CREATE TRIGGER foxwarm_operator_revision BEFORE UPDATE OF settings, limits, credential_version ON tenants
    FOR EACH ROW WHEN (OLD.settings IS DISTINCT FROM NEW.settings OR OLD.limits IS DISTINCT FROM NEW.limits
        OR OLD.credential_version <> NEW.credential_version) EXECUTE FUNCTION foxwarm_operator_revision();
CREATE TRIGGER foxwarm_notify_rotation AFTER UPDATE OF credential_version ON tenants
    FOR EACH STATEMENT EXECUTE FUNCTION foxwarm_notify_tenants();

-- Only the schema owner may insert the wrapped key. Provisioning opens and releases the
-- initial lease in the enclosing creation transaction. No intermediate state is visible.
CREATE FUNCTION foxwarm_provision_key(id integer, key text, kek text, iv bytea, ciphertext bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM set_config('foxwarm.tenant', id::text, true), set_config('foxwarm.epoch', '1', true);
    INSERT INTO tenant_keys (key_id, kek_id, nonce, wrapped) VALUES (key, kek, iv, ciphertext);
END
$$;
REVOKE ALL ON FUNCTION foxwarm_provision_key FROM PUBLIC;

CREATE FUNCTION foxwarm_auth_snapshot() RETURNS TABLE(version bigint, credential_hash bytea, download_key bytea)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM foxwarm_require_lease();
    RETURN QUERY SELECT a.version,a.credential_hash,a.download_key FROM tenant_auth a WHERE tenant_id=current_setting('foxwarm.tenant')::integer;
END $$;
REVOKE ALL ON FUNCTION foxwarm_auth_snapshot FROM PUBLIC;

CREATE FUNCTION foxwarm_redeem_setup(digest bytea, expected_version bigint, verifier bytea) RETURNS text
LANGUAGE plpgsql STRICT SECURITY DEFINER AS $$
DECLARE row tenant_auth%ROWTYPE;
BEGIN
    IF octet_length(digest)<>32 OR octet_length(verifier)<>32 OR expected_version<=0 THEN RETURN 'invalid'; END IF;
    PERFORM foxwarm_require_lease();
    SELECT * INTO row FROM tenant_auth WHERE tenant_id=current_setting('foxwarm.tenant')::integer FOR UPDATE;
    IF NOT FOUND OR row.version<>expected_version OR row.setup_hash<>digest THEN RETURN 'invalid'; END IF;
    IF row.credential_hash IS NOT NULL THEN RETURN 'used'; END IF;
    IF row.expires_at<=clock_timestamp() THEN RETURN 'expired'; END IF;
    UPDATE tenant_auth SET credential_hash=verifier WHERE tenant_id=row.tenant_id;
    RETURN 'redeemed';
END $$;
REVOKE ALL ON FUNCTION foxwarm_redeem_setup FROM PUBLIC;
DO $$
DECLARE operator text := current_setting('foxwarm.operator_role');
BEGIN
    EXECUTE format('ALTER FUNCTION foxwarm_provision_key SET search_path TO pg_catalog, %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION foxwarm_auth_snapshot SET search_path TO pg_catalog, %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION foxwarm_redeem_setup SET search_path TO pg_catalog, %I, pg_temp', current_schema());
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_provision_key TO %I',operator);
    EXECUTE format('GRANT INSERT,UPDATE ON tenant_auth TO %I',operator);
    EXECUTE format('GRANT SELECT (tenant_id) ON tenant_auth TO %I',operator);
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON operator_credentials FROM %I',operator);
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_redeem_setup,foxwarm_auth_snapshot TO %I',current_setting('foxwarm.app_role'));
END $$;
