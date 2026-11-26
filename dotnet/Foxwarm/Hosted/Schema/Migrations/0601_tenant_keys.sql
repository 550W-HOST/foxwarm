-- reader-floor: 1
-- The tenant data key (DEK), wrapped with AES-256-GCM by the deployment's key-encryption key
-- (KEK), and the instance credentials encrypted under a DEK-derived key. P1 keeps one DEK per
-- tenant (UNIQUE (tenant_id)); DEK rotation drops that constraint.

CREATE TABLE tenant_keys (
    tenant_id integer NOT NULL,
    key_id text COLLATE "C" NOT NULL,
    kek_id text COLLATE "C" NOT NULL,
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    wrapped bytea NOT NULL CHECK (octet_length(wrapped) = 48),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key_id),
    UNIQUE (tenant_id)
);
SELECT foxwarm_tenant_table('tenant_keys', 'SELECT, INSERT, UPDATE');

CREATE TABLE instance_credentials (
    tenant_id integer NOT NULL,
    name text COLLATE "C" NOT NULL
        CHECK (name IN ('http-token', 'node-pairing-token', 'node-event-capability')),
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    value bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, name)
);
SELECT foxwarm_tenant_table('instance_credentials', 'SELECT, INSERT');

-- Whether the transaction's tenant has data encrypted under a DEK. A tenant with such data and
-- no DEK is locked: a new DEK would never decrypt it. Tables of other stores are checked when
-- they exist, so this function doesn't depend on their migrations.
CREATE FUNCTION foxwarm_tenant_has_encrypted_data() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
    found boolean;
    store text;
BEGIN
    IF EXISTS (SELECT 1 FROM state_documents WHERE name = 'secrets')
        OR EXISTS (SELECT 1 FROM instance_credentials) THEN
        RETURN true;
    END IF;
    FOREACH store IN ARRAY ARRAY['text_redaction_slots', 'text_redaction_known'] LOOP
        IF to_regclass(store) IS NOT NULL THEN
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', store) INTO found;
            IF found THEN
                RETURN true;
            END IF;
        END IF;
    END LOOP;
    RETURN false;
END
$$;
DO $$
BEGIN
    EXECUTE format(
        'GRANT EXECUTE ON FUNCTION foxwarm_tenant_has_encrypted_data() TO %I',
        current_setting('foxwarm.app_role'));
END
$$;
