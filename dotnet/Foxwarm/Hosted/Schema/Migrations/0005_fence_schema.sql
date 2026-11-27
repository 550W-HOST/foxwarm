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
END $$;
