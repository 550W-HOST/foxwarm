-- reader-floor: 1200
-- Older readers do not observe credential rotation or retire a stale generation.
ALTER TABLE tenants
    ADD COLUMN object_identity text COLLATE "C",
    ADD COLUMN settings_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN credential_version bigint NOT NULL DEFAULT 0,
    ADD COLUMN setup_hash bytea,
    ADD COLUMN setup_expires_at timestamptz,
    ADD COLUMN setup_redeemed_at timestamptz;

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

-- The owner may redeem only the current setup token for the credential its runtime holds.
-- Locking the tenant row orders concurrent redemptions and rotations; keep the hash until
-- rotation so only the original token can receive the already-used diagnosis.
CREATE FUNCTION foxwarm_redeem_setup(digest bytea, version bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    row tenants%ROWTYPE;
BEGIN
    PERFORM foxwarm_require_lease();
    SELECT * INTO row FROM tenants WHERE tenant_id = current_setting('foxwarm.tenant')::integer FOR UPDATE;
    IF row.setup_hash IS NULL OR row.setup_hash <> digest OR row.credential_version <> version THEN RETURN 'invalid'; END IF;
    IF row.setup_redeemed_at IS NOT NULL THEN RETURN 'used'; END IF;
    IF row.setup_expires_at <= clock_timestamp() THEN RETURN 'expired'; END IF;
    UPDATE tenants SET setup_redeemed_at = clock_timestamp() WHERE tenant_id = row.tenant_id;
    RETURN 'redeemed';
END
$$;
REVOKE ALL ON FUNCTION foxwarm_redeem_setup FROM PUBLIC;
DO $$ BEGIN
    EXECUTE format('ALTER FUNCTION foxwarm_provision_key SET search_path TO pg_catalog, %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION foxwarm_redeem_setup SET search_path TO pg_catalog, %I, pg_temp', current_schema());
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_provision_key TO %I', current_setting('foxwarm.operator_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_redeem_setup TO %I', current_setting('foxwarm.app_role'));
END $$;
