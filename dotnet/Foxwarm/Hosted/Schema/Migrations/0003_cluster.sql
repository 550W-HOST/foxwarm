-- reader-floor: 1
-- Multi-tenant cluster state (P2): tenant identity and placement columns, replica roles, the
-- routing drain flag and deletion epoch on the lease row, and the cluster tables the operator
-- role owns. Cluster tables have no row-level security. The runtime role only reads them; it
-- writes its own wake-up row through the lease-checked functions below. The operator role
-- (schema_info.operator_role) owns every other write.

-- Tenants. `name` is the slug: the immutable public identity, a DNS label for new tenants.
ALTER TABLE tenants DROP CONSTRAINT tenants_state_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_state_check
    CHECK (state IN ('importing', 'active', 'suspended', 'deleting'));
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_dns_label
    CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') NOT VALID;
ALTER TABLE tenants
    ADD COLUMN profile text COLLATE "C" NOT NULL DEFAULT 'hosted'
        CHECK (profile IN ('hosted', 'operator')),
    ADD COLUMN pinned_role text COLLATE "C" CHECK (pinned_role IN ('master-host')),
    -- Operator-owned per-tenant settings (journal switch, retention) and limits (§7.2).
    ADD COLUMN settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
    ADD COLUMN limits jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(limits) = 'object');

CREATE FUNCTION foxwarm_tenant_slug_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'a tenant''s slug never changes' USING ERRCODE = 'FW002';
END
$$;
CREATE TRIGGER foxwarm_tenant_slug_immutable BEFORE UPDATE OF name ON tenants
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
    EXECUTE FUNCTION foxwarm_tenant_slug_immutable();

-- Replicas. replica_id stays the per-boot ID (the lease owner); name is the stable logical name.
ALTER TABLE replicas
    ADD COLUMN name text COLLATE "C",
    ADD COLUMN mesh_address text COLLATE "C",
    ADD COLUMN draining boolean NOT NULL DEFAULT false,
    -- Hot tenants, hot-owner bytes and RSS, reported with the heartbeat.
    ADD COLUMN capacity jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(capacity) = 'object');
ALTER TABLE replicas ADD CONSTRAINT replicas_role_check
    CHECK (role IN ('general', 'master-host', 'operator'));

-- Lease rows. The routing drain flag leaves the lease owned, writable and renewable: it isn't
-- part of foxwarm_require_lease. The deletion epoch is the epoch a deletion took the row at.
ALTER TABLE tenant_leases
    ADD COLUMN draining_since timestamptz,
    ADD COLUMN deletion_epoch bigint;

CREATE TABLE tenant_hostnames (
    hostname text COLLATE "C" PRIMARY KEY
        CHECK (hostname = lower(hostname) AND hostname ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
    tenant_id integer NOT NULL REFERENCES tenants (tenant_id),
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('primary', 'custom')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_hostnames_primary ON tenant_hostnames (tenant_id) WHERE kind = 'primary';

-- When a tenant must run without traffic. Written at clean release under the expected epoch;
-- an activation never deletes it: the new generation replaces or clears it under its own epoch.
CREATE TABLE tenant_wakeups (
    tenant_id integer PRIMARY KEY REFERENCES tenants (tenant_id),
    due_at timestamptz NOT NULL,
    -- The occurrence the wake-up was written for, carried through activation (§8.2).
    occurrence jsonb CHECK (occurrence IS NULL OR jsonb_typeof(occurrence) = 'object'),
    -- Failed-start backoff: no activation attempt before this time.
    next_attempt_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_wakeups_due ON tenant_wakeups (due_at, tenant_id);

CREATE TABLE provider_grants (
    tenant_id integer NOT NULL REFERENCES tenants (tenant_id),
    provider_id text COLLATE "C" NOT NULL,
    quotas jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(quotas) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, provider_id)
);

-- Ceiling policies and profile overrides, globally or for one tenant.
CREATE TABLE operator_documents (
    scope text COLLATE "C" NOT NULL CHECK (scope IN ('global', 'tenant')),
    tenant_id integer REFERENCES tenants (tenant_id),
    name text COLLATE "C" NOT NULL,
    text text COLLATE "C" NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope = 'tenant') = (tenant_id IS NOT NULL))
);
CREATE UNIQUE INDEX operator_documents_key ON operator_documents (scope, coalesce(tenant_id, 0), name);

-- Operator tokens, stored as hashes only. The runtime role has no access at all.
CREATE TABLE operator_credentials (
    id text COLLATE "C" PRIMARY KEY,
    hash text COLLATE "C" NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

-- Signals for the replicas' hostname caches and live operator settings. Only columns that
-- change routing or tenant settings signal; a reader-version raise doesn't.
CREATE FUNCTION foxwarm_notify_tenants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('foxwarm_tenants', '');
    RETURN NULL;
END
$$;
CREATE TRIGGER foxwarm_notify_tenants
    AFTER INSERT OR DELETE OR UPDATE OF state, profile, pinned_role, settings, limits ON tenants
    FOR EACH STATEMENT EXECUTE FUNCTION foxwarm_notify_tenants();
CREATE TRIGGER foxwarm_notify_tenants
    AFTER INSERT OR UPDATE OR DELETE ON tenant_hostnames
    FOR EACH STATEMENT EXECUTE FUNCTION foxwarm_notify_tenants();
CREATE FUNCTION foxwarm_notify_operator() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('foxwarm_operator', '');
    RETURN NULL;
END
$$;
CREATE TRIGGER foxwarm_notify_operator
    AFTER INSERT OR UPDATE OR DELETE ON operator_documents
    FOR EACH STATEMENT EXECUTE FUNCTION foxwarm_notify_operator();
CREATE TRIGGER foxwarm_notify_operator
    AFTER INSERT OR UPDATE OR DELETE ON provider_grants
    FOR EACH STATEMENT EXECUTE FUNCTION foxwarm_notify_operator();

-- The transaction tenant's wake-up row, under its current lease epoch (foxwarm_require_lease).
-- Replacing it clears any failed-start backoff.
CREATE FUNCTION foxwarm_set_wakeup(due timestamptz, due_occurrence jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
    PERFORM foxwarm_require_lease();
    INSERT INTO tenant_wakeups (tenant_id, due_at, occurrence)
    VALUES (current_setting('foxwarm.tenant')::integer, due, due_occurrence)
    ON CONFLICT (tenant_id) DO UPDATE
       SET due_at = EXCLUDED.due_at, occurrence = EXCLUDED.occurrence,
           next_attempt_at = NULL, attempts = 0, updated_at = now();
END
$$;
REVOKE ALL ON FUNCTION foxwarm_set_wakeup(timestamptz, jsonb) FROM PUBLIC;

CREATE FUNCTION foxwarm_clear_wakeup() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
    PERFORM foxwarm_require_lease();
    DELETE FROM tenant_wakeups WHERE tenant_id = current_setting('foxwarm.tenant')::integer;
END
$$;
REVOKE ALL ON FUNCTION foxwarm_clear_wakeup() FROM PUBLIC;

-- Records a failed start: no attempt before next_attempt. Keeps the due time and occurrence of
-- an existing row; with create, a tenant without one gets a row due now, so a scan retries it.
CREATE FUNCTION foxwarm_wakeup_backoff(next_attempt timestamptz, "create" boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
    tenant integer := current_setting('foxwarm.tenant')::integer;
BEGIN
    PERFORM foxwarm_require_lease();
    UPDATE tenant_wakeups
       SET next_attempt_at = next_attempt, attempts = attempts + 1, updated_at = now()
     WHERE tenant_id = tenant;
    IF NOT FOUND AND "create" THEN
        INSERT INTO tenant_wakeups (tenant_id, due_at, next_attempt_at, attempts)
        VALUES (tenant, now(), next_attempt, 1);
    END IF;
END
$$;
REVOKE ALL ON FUNCTION foxwarm_wakeup_backoff(timestamptz, boolean) FROM PUBLIC;

DO $$
DECLARE
    app text := current_setting('foxwarm.app_role');
    operator text := current_setting('foxwarm.operator_role');
BEGIN
    EXECUTE format('GRANT SELECT ON tenant_hostnames, tenant_wakeups, provider_grants, operator_documents TO %I', app);
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_set_wakeup(timestamptz, jsonb) TO %I', app);
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_clear_wakeup() TO %I', app);
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_wakeup_backoff(timestamptz, boolean) TO %I', app);
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, tenant_hostnames, tenant_wakeups,'
        ' provider_grants, operator_documents, operator_credentials TO %I', operator);
    -- Lease rows are created with their tenant and changed under FOR UPDATE by suspension and
    -- deletion; they're never deleted while dependent rows remain.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON tenant_leases TO %I', operator);
    EXECUTE format('GRANT SELECT, UPDATE ON replicas TO %I', operator);
    EXECUTE format('GRANT SELECT ON schema_migrations, schema_info TO %I', operator);
END
$$;
