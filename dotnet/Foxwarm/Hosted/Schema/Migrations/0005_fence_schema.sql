-- reader-floor: 1
-- Preserve grants and trigger bindings while making both levels of the tenant fence use
-- the installation schema, even when a session has a temporary namespace.
DO $$
DECLARE installation text := current_schema();
BEGIN
    EXECUTE format($ddl$
        CREATE OR REPLACE FUNCTION %1$I.foxwarm_require_lease() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,%1$I,pg_temp AS $body$
        BEGIN
            PERFORM 1 FROM %1$I.tenant_leases
             WHERE tenant_id = nullif(current_setting('foxwarm.tenant',true),'')::integer
               AND epoch = nullif(current_setting('foxwarm.epoch',true),'')::bigint
               AND state='active' AND expires_at>now() FOR KEY SHARE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'tenant write without the current lease epoch' USING ERRCODE='FW001';
            END IF;
        END
        $body$
    $ddl$,installation);
    EXECUTE format($ddl$
        CREATE OR REPLACE FUNCTION %1$I.foxwarm_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,%1$I,pg_temp AS $body$
        BEGIN
            PERFORM %1$I.foxwarm_require_lease();
            RETURN NULL;
        END
        $body$
    $ddl$,installation);
    EXECUTE format($ddl$
        CREATE OR REPLACE FUNCTION %1$I.foxwarm_raise_reader_version(level integer) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $body$
        BEGIN
            PERFORM %1$I.foxwarm_require_lease();
            UPDATE %1$I.tenants SET min_reader_version = greatest(min_reader_version, level)
             WHERE tenant_id = current_setting('foxwarm.tenant')::integer;
        END
        $body$
    $ddl$,installation);
    EXECUTE format($ddl$
        CREATE OR REPLACE FUNCTION %1$I.foxwarm_set_wakeup(due timestamptz, due_occurrence jsonb) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $body$
        BEGIN
            PERFORM %1$I.foxwarm_require_lease();
            INSERT INTO %1$I.tenant_wakeups (tenant_id, due_at, occurrence)
            VALUES (current_setting('foxwarm.tenant')::integer, due, due_occurrence)
            ON CONFLICT (tenant_id) DO UPDATE
               SET due_at = EXCLUDED.due_at, occurrence = EXCLUDED.occurrence,
                   next_attempt_at = NULL, attempts = 0, updated_at = now();
        END
        $body$
    $ddl$,installation);
    EXECUTE format($ddl$
        CREATE OR REPLACE FUNCTION %1$I.foxwarm_clear_wakeup() RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $body$
        BEGIN
            PERFORM %1$I.foxwarm_require_lease();
            DELETE FROM %1$I.tenant_wakeups WHERE tenant_id = current_setting('foxwarm.tenant')::integer;
        END
        $body$
    $ddl$,installation);
    EXECUTE format($ddl$
        CREATE OR REPLACE FUNCTION %1$I.foxwarm_wakeup_backoff(next_attempt timestamptz, "create" boolean) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $body$
        DECLARE
            tenant integer := current_setting('foxwarm.tenant')::integer;
        BEGIN
            PERFORM %1$I.foxwarm_require_lease();
            UPDATE %1$I.tenant_wakeups
               SET next_attempt_at = next_attempt, attempts = attempts + 1, updated_at = now()
             WHERE tenant_id = tenant;
            IF NOT FOUND AND "create" THEN
                INSERT INTO %1$I.tenant_wakeups (tenant_id, due_at, next_attempt_at, attempts)
                VALUES (tenant, now(), next_attempt, 1);
            END IF;
        END
        $body$
    $ddl$,installation);
END $$;
