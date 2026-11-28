-- reader-floor: 1103
-- An admission retains its keys until publication, failed-call cleanup or a lease move.
ALTER TABLE agent_blob_reservations ADD COLUMN claim uuid, ADD COLUMN claim_epoch bigint,
    ADD COLUMN gc_attempt timestamptz, ADD COLUMN conditional_put boolean NOT NULL DEFAULT false;
ALTER TABLE agent_blob_reservations DROP CONSTRAINT agent_blob_reservations_state_check,
    ADD CHECK (state IN ('reserved','pending','stored','pinned','deleting'));

-- Reclaim only Agent content, under the same lock as reference edits and admission.
-- The caller cannot delete blobs directly. Chunk, object and ledger deletion are atomic.
CREATE FUNCTION foxwarm_collect_agent_pg(needed numeric) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE id integer := current_setting('foxwarm.tenant')::integer; epoch bigint := current_setting('foxwarm.epoch')::bigint; item record;
BEGIN
    PERFORM foxwarm_require_lease();
    PERFORM 1 FROM agent_file_usage WHERE tenant_id=id AND blob_inventory='postgres' FOR UPDATE;
    IF NOT FOUND OR needed<=0 THEN RETURN; END IF;
    FOR item IN SELECT r.content_key,r.object_key,r.byte_length FROM agent_blob_reservations r
        WHERE r.tenant_id=id AND r.claim_epoch IS DISTINCT FROM epoch AND NOT EXISTS
        (SELECT 1 FROM agent_files f WHERE f.tenant_id=id AND f.blob_key=r.object_key)
        ORDER BY r.byte_length DESC,r.content_key LOOP
        DELETE FROM blob_chunks WHERE tenant_id=id AND store='agent-files' AND key=item.object_key;
        DELETE FROM blob_objects WHERE tenant_id=id AND store='agent-files' AND key=item.object_key;
        DELETE FROM agent_blob_reservations WHERE tenant_id=id AND content_key=item.content_key;
        needed := needed-item.byte_length;
        EXIT WHEN needed<=0;
    END LOOP;
END $$;

-- Retire an incarnation durably before dispatching even the first remote DELETE. Multiple
-- operators can retry the same cleanup: names of retired incarnations are never reused.
CREATE FUNCTION foxwarm_agent_gc_next(destination text) RETURNS TABLE(key text, status text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE id integer := current_setting('foxwarm.tenant')::integer; epoch bigint := current_setting('foxwarm.epoch')::bigint;
BEGIN
    IF foxwarm_agent_inventory_lock() IS DISTINCT FROM destination THEN RETURN; END IF;
    RETURN QUERY WITH candidate AS (
        SELECT r.content_key FROM agent_blob_reservations r WHERE r.tenant_id=id AND r.state<>'pinned'
            AND r.claim_epoch IS DISTINCT FROM epoch AND NOT EXISTS
            (SELECT 1 FROM agent_files f WHERE f.tenant_id=id AND f.blob_key=r.object_key)
            ORDER BY r.gc_attempt NULLS FIRST,r.content_key LIMIT 1
    ) UPDATE agent_blob_reservations r SET state=CASE WHEN r.state='pending' THEN 'pending' ELSE 'deleting' END,
        gc_attempt=clock_timestamp() FROM candidate c WHERE r.tenant_id=id AND r.content_key=c.content_key
        RETURNING r.object_key,r.state;
END $$;

-- Seeing a single-dispatch pending object proves that PUT reached storage. An absent
-- object proves nothing. A conditional retry may already have pinned the charge since
-- the listing, so recheck its state under the lock and leave retirement to the next pass.
CREATE FUNCTION foxwarm_agent_gc_observed(destination text, object_name text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF foxwarm_agent_inventory_lock()=destination THEN
        UPDATE agent_blob_reservations SET state='stored' WHERE tenant_id=current_setting('foxwarm.tenant')::integer
            AND object_key=object_name AND state='pending';
    END IF;
END $$;

CREATE FUNCTION foxwarm_agent_gc_finish(destination text, object_name text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE id integer := current_setting('foxwarm.tenant')::integer;
BEGIN
    IF foxwarm_agent_inventory_lock()=destination THEN
        DELETE FROM agent_blob_reservations r WHERE r.tenant_id=id AND r.object_key=object_name AND r.state='deleting'
            AND NOT EXISTS (SELECT 1 FROM agent_files f WHERE f.tenant_id=id AND f.blob_key=object_name);
    END IF;
END $$;

DO $$
DECLARE fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['foxwarm_collect_agent_pg','foxwarm_agent_gc_next','foxwarm_agent_gc_observed','foxwarm_agent_gc_finish'] LOOP
        EXECUTE format('ALTER FUNCTION %I SET search_path TO pg_catalog,%I,pg_temp',fn,current_schema());
        EXECUTE format('REVOKE ALL ON FUNCTION %I FROM PUBLIC',fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I TO %I',fn,current_setting(CASE WHEN fn='foxwarm_collect_agent_pg' THEN 'foxwarm.app_role' ELSE 'foxwarm.operator_role' END));
    END LOOP;
END $$;
