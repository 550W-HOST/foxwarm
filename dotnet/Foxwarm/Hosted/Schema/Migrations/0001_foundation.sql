-- reader-floor: 1
-- Cluster tables (no tenant_id): tenants, replicas and the tenant leases that fence writes.
-- The helpers below give every tenant table its row-level security, fence trigger, tenant
-- default and runtime grants; SchemaLintTests checks that every tenant table has them.

CREATE TABLE tenants (
    tenant_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text COLLATE "C" NOT NULL UNIQUE,
    state text COLLATE "C" NOT NULL DEFAULT 'active'
        CHECK (state IN ('importing', 'active', 'suspended')),
    -- Mirrors the tenant's Installation minimumReaderVersion; raised, never lowered.
    min_reader_version integer NOT NULL DEFAULT 0 CHECK (min_reader_version >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE replicas (
    replica_id text COLLATE "C" PRIMARY KEY,
    advertise_address text COLLATE "C",
    role text COLLATE "C" NOT NULL DEFAULT 'general',
    binary_level integer NOT NULL,
    reader_version integer NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_leases (
    tenant_id integer PRIMARY KEY REFERENCES tenants (tenant_id),
    owner_replica text COLLATE "C",
    -- Raised by every acquisition; a write transaction is fenced by the epoch it was given.
    epoch bigint NOT NULL DEFAULT 0,
    state text COLLATE "C" NOT NULL DEFAULT 'released' CHECK (state IN ('active', 'released')),
    acquired_at timestamptz,
    expires_at timestamptz NOT NULL DEFAULT '-infinity'
);

-- The transaction's tenant lease is active, unexpired and at the transaction's epoch. Locks the
-- lease row FOR KEY SHARE, so a takeover (which takes FOR UPDATE before raising the epoch) waits
-- for every such transaction, and no write of an older epoch can commit after it. The owner's
-- renewal changes only non-key columns and doesn't conflict with the lock.
CREATE FUNCTION foxwarm_require_lease() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
    PERFORM 1 FROM tenant_leases
     WHERE tenant_id = nullif(current_setting('foxwarm.tenant', true), '')::integer
       AND epoch = nullif(current_setting('foxwarm.epoch', true), '')::bigint
       AND state = 'active'
       AND expires_at > now()
       FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tenant write without the current lease epoch' USING ERRCODE = 'FW001';
    END IF;
END
$$;
REVOKE ALL ON FUNCTION foxwarm_require_lease() FROM PUBLIC;

-- Statement-level guard on every tenant table.
CREATE FUNCTION foxwarm_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
    PERFORM foxwarm_require_lease();
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION foxwarm_fence() FROM PUBLIC;

-- Raises the transaction tenant's minimum reader version (never lowers it). The state-document
-- store calls it in the transaction that writes the Installation document.
CREATE FUNCTION foxwarm_raise_reader_version(level integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
    PERFORM foxwarm_require_lease();
    UPDATE tenants SET min_reader_version = greatest(min_reader_version, level)
     WHERE tenant_id = current_setting('foxwarm.tenant')::integer;
END
$$;
REVOKE ALL ON FUNCTION foxwarm_raise_reader_version(integer) FROM PUBLIC;

-- Makes target a tenant table: tenant default, forced row-level security, the fence trigger and
-- the runtime role's privileges. Migrations call it right after CREATE TABLE.
CREATE FUNCTION foxwarm_tenant_table(target regclass, privileges text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    app text := current_setting('foxwarm.app_role');
BEGIN
    EXECUTE format(
        'ALTER TABLE %s ALTER COLUMN tenant_id SET DEFAULT current_setting(''foxwarm.tenant'')::integer',
        target);
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
        'CREATE POLICY tenant_isolation ON %s'
        ' USING (tenant_id = current_setting(''foxwarm.tenant'')::integer)'
        ' WITH CHECK (tenant_id = current_setting(''foxwarm.tenant'')::integer)',
        target);
    EXECUTE format(
        'CREATE TRIGGER foxwarm_fence BEFORE INSERT OR UPDATE OR DELETE ON %s'
        ' FOR EACH STATEMENT EXECUTE FUNCTION foxwarm_fence()',
        target);
    EXECUTE format('GRANT %s ON %s TO %I', privileges, target, app);
END
$$;
REVOKE ALL ON FUNCTION foxwarm_tenant_table(regclass, text) FROM PUBLIC;

DO $$
DECLARE
    app text := current_setting('foxwarm.app_role');
BEGIN
    EXECUTE format('GRANT SELECT ON tenants TO %I', app);
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_raise_reader_version(integer) TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON replicas TO %I', app);
    EXECUTE format('GRANT SELECT, UPDATE ON tenant_leases TO %I', app);
    EXECUTE format('GRANT SELECT ON schema_migrations TO %I', app);
END
$$;
