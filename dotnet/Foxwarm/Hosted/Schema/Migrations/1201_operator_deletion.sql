-- reader-floor: 1201
-- The deleting row stays the durable job. A SQL sweep finishes before S3 settling; the
-- key, terminal state and lease survive until SQL is clear and, for S3, a settled listing was empty.
CREATE TABLE operator_deletions (
    tenant_id integer PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    deletion_epoch bigint NOT NULL,
    sql_done boolean NOT NULL DEFAULT false,
    objects_pending boolean NOT NULL,
    settle_after timestamptz
);

-- No tenant FK: the namespace may receive an already-dispatched write after tenant removal.
CREATE TABLE operator_object_receipts (
    tenant_id integer PRIMARY KEY,
    slug text COLLATE "C" NOT NULL,
    object_identity text COLLATE "C" NOT NULL,
    endpoint text COLLATE "C" NOT NULL,
    bucket text COLLATE "C" NOT NULL,
    observed_empty_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    recheck_after timestamptz NOT NULL,
    found_late_objects boolean NOT NULL DEFAULT false
);

-- Both callers own the row lock and an ownerless epoch. Open only inside their transaction
-- and close before returning. Ordinary fenced writes and FORCE RLS apply throughout.
CREATE FUNCTION foxwarm_maintenance_lease(id integer, expected bigint, opening boolean) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER STRICT AS $$
BEGIN
    UPDATE tenant_leases SET state=CASE WHEN opening THEN 'active' ELSE 'released' END,
        expires_at=CASE WHEN opening THEN clock_timestamp()+interval '1 minute' ELSE clock_timestamp() END
    WHERE tenant_id=id AND epoch=expected AND owner_replica IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'maintenance epoch is no longer current' USING ERRCODE='FW001'; END IF;
    IF opening THEN PERFORM set_config('foxwarm.tenant',id::text,true),set_config('foxwarm.epoch',expected::text,true); END IF;
END $$;
REVOKE ALL ON FUNCTION foxwarm_maintenance_lease FROM PUBLIC;

CREATE OR REPLACE FUNCTION foxwarm_provision_key(id integer, key text, kek text, iv bytea, ciphertext bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM foxwarm_maintenance_lease(id,1,true);
    INSERT INTO tenant_keys(key_id,kek_id,nonce,wrapped) VALUES(key,kek,iv,ciphertext);
    PERFORM foxwarm_maintenance_lease(id,1,false);
END $$;

-- Never resolve an operator-supplied relation outside this installation. Only tables with
-- the tenant policy, forced RLS and the installation's statement fence qualify.
CREATE FUNCTION foxwarm_deletion_tables() RETURNS SETOF name LANGUAGE sql STABLE AS $$
    SELECT c.relname FROM pg_catalog.pg_class c WHERE c.relnamespace=(SELECT pronamespace FROM pg_catalog.pg_proc WHERE oid='foxwarm_deletion_tables'::regproc)
    AND c.relkind='r' AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid=c.oid AND t.tgfoid='foxwarm_fence'::regproc AND t.tgname='foxwarm_fence')
    ORDER BY CASE c.relname WHEN 'task_notes' THEN 0 WHEN 'blob_chunks' THEN 0 WHEN 'session_alias' THEN 0
        WHEN 'session_catalog' THEN 1 WHEN 'tenant_keys' THEN 3 ELSE 2 END,c.relname
$$;
REVOKE ALL ON FUNCTION foxwarm_deletion_tables FROM PUBLIC;

CREATE FUNCTION foxwarm_operator_delete_chunk(requested_tenant integer, expected bigint, target text, chunk integer) RETURNS integer
LANGUAGE plpgsql STRICT SECURITY DEFINER AS $$
DECLARE installation name; relation name; removed integer;
BEGIN
    PERFORM 1 FROM tenant_leases l JOIN tenants t USING(tenant_id) WHERE l.tenant_id=requested_tenant AND t.state='deleting'
        AND l.epoch=expected AND l.deletion_epoch=expected
        AND target<>'tenant_keys'
        FOR UPDATE OF l;
    IF NOT FOUND THEN RAISE EXCEPTION 'tenant deletion epoch is no longer current' USING ERRCODE='FW001'; END IF;
    SELECT d INTO relation FROM foxwarm_deletion_tables() d WHERE d::text=target;
    IF relation IS NULL AND target IN ('provider_grants','operator_documents','tenant_hostnames','tenant_wakeups') THEN relation := target; END IF;
    IF relation IS NULL OR chunk NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'invalid deletion chunk'; END IF;
    SELECT nspname INTO installation FROM pg_catalog.pg_namespace WHERE oid=(SELECT pronamespace FROM pg_catalog.pg_proc WHERE oid='foxwarm_deletion_tables'::regproc);
    PERFORM foxwarm_maintenance_lease(requested_tenant,expected,true);
    -- Imported task graphs can contain cycles. Unlink a bounded group before deleting
    -- parents. Once no parent link remains there is no dependency between task rows.
    IF relation='tasks' THEN
        UPDATE tasks SET "parentTaskId"=NULL WHERE tenant_id=requested_tenant AND ctid IN
            (SELECT ctid FROM tasks WHERE tenant_id=requested_tenant AND "parentTaskId" IS NOT NULL LIMIT chunk);
        GET DIAGNOSTICS removed = ROW_COUNT;
    END IF;
    IF coalesce(removed,0)=0 THEN
        EXECUTE format('DELETE FROM %1$I.%2$I WHERE tenant_id=$1 AND ctid IN (SELECT ctid FROM %1$I.%2$I WHERE tenant_id=$1 LIMIT $2)',installation,relation) USING requested_tenant,chunk;
        GET DIAGNOSTICS removed = ROW_COUNT;
    END IF;
    PERFORM foxwarm_maintenance_lease(requested_tenant,expected,false);
    RETURN removed;
END $$;
REVOKE ALL ON FUNCTION foxwarm_operator_delete_chunk FROM PUBLIC;

-- Finalization does not trust a caller's claim that all SQL chunks finished. Check every
-- fenced table including the key before removing the terminal row and its lease.
CREATE FUNCTION foxwarm_operator_finish_delete(requested_tenant integer, expected bigint) RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER AS $$
DECLARE installation name; relation name; remaining boolean;
BEGIN
    PERFORM 1 FROM tenants WHERE tenant_id=requested_tenant AND state='deleting' FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM 1 FROM tenant_leases l JOIN operator_deletions d USING(tenant_id,deletion_epoch)
        WHERE l.tenant_id=requested_tenant AND l.epoch=expected AND l.deletion_epoch=expected
            AND d.sql_done AND NOT d.objects_pending FOR UPDATE OF l;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM set_config('foxwarm.tenant',requested_tenant::text,true);
    SELECT nspname INTO installation FROM pg_catalog.pg_namespace WHERE oid=(SELECT pronamespace FROM pg_catalog.pg_proc WHERE oid='foxwarm_deletion_tables'::regproc);
    remaining := false;
    FOR relation IN SELECT d FROM foxwarm_deletion_tables() d WHERE d<>'tenant_keys' LOOP
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE tenant_id=$1)',installation,relation) INTO remaining USING requested_tenant;
        EXIT WHEN remaining;
    END LOOP;
    IF remaining OR EXISTS (SELECT 1 FROM tenant_hostnames WHERE tenant_id=requested_tenant) OR EXISTS (SELECT 1 FROM tenant_wakeups WHERE tenant_id=requested_tenant)
       OR EXISTS (SELECT 1 FROM provider_grants WHERE tenant_id=requested_tenant) OR EXISTS (SELECT 1 FROM operator_documents WHERE tenant_id=requested_tenant) THEN
        UPDATE operator_deletions SET sql_done=false WHERE tenant_id=requested_tenant AND deletion_epoch=expected;
        RETURN false;
    END IF;
    PERFORM foxwarm_maintenance_lease(requested_tenant,expected,true);
    DELETE FROM tenant_keys WHERE tenant_id=requested_tenant;
    PERFORM foxwarm_maintenance_lease(requested_tenant,expected,false);
    DELETE FROM tenant_leases WHERE tenant_id=requested_tenant;
    DELETE FROM tenants WHERE tenant_id=requested_tenant;
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION foxwarm_operator_finish_delete FROM PUBLIC;

DO $$
DECLARE fn text;
BEGIN
    -- The catalog delete trigger and its nested subtree refresh do DML with the caller's
    -- rights. During cleanup that caller is the schema owner: pin all four catalog paths.
    FOREACH fn IN ARRAY ARRAY['foxwarm_maintenance_lease','foxwarm_provision_key','foxwarm_deletion_tables','foxwarm_operator_delete_chunk','foxwarm_operator_finish_delete',
        'session_catalog_after_insert','session_catalog_after_update','session_catalog_after_delete','session_catalog_refresh_subtree'] LOOP
        EXECUTE format('ALTER FUNCTION %I SET search_path TO pg_catalog,%I,pg_temp',fn,current_schema());
    END LOOP;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON operator_object_receipts TO %I',current_setting('foxwarm.operator_role'));
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON operator_deletions TO %I',current_setting('foxwarm.operator_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION foxwarm_deletion_tables(),foxwarm_operator_delete_chunk(integer,bigint,text,integer),foxwarm_operator_finish_delete(integer,bigint) TO %I',current_setting('foxwarm.operator_role'));
END $$;
