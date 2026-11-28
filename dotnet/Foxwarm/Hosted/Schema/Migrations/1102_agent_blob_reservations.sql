-- reader-floor: 1102
-- One charge for each distinct Agent blob, including a remote PUT with no confirmed outcome.
CREATE TABLE agent_blob_reservations (
    tenant_id integer NOT NULL,
    content_key text COLLATE "C" NOT NULL,
    object_key text COLLATE "C" NOT NULL,
    byte_length numeric NOT NULL CHECK (byte_length >= 0),
    state text COLLATE "C" NOT NULL CHECK (state IN ('pending','stored','pinned','deleting')),
    PRIMARY KEY (tenant_id, content_key),
    UNIQUE (tenant_id, object_key)
);
SELECT foxwarm_tenant_table('agent_blob_reservations', 'SELECT, INSERT, UPDATE');
ALTER TABLE agent_file_usage ADD COLUMN blob_inventory text COLLATE "C";
CREATE INDEX agent_files_blob ON agent_files(tenant_id, blob_key) WHERE blob_key IS NOT NULL;

-- The operator uses the active epoch through TenantDb. It has no direct tenant-table
-- grants. Inventory is atomic: only a complete pass opens the admission gate.
CREATE FUNCTION foxwarm_agent_inventory_lock() RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE destination text;
BEGIN
    INSERT INTO agent_file_usage(tenant_id) VALUES (current_setting('foxwarm.tenant')::integer) ON CONFLICT DO NOTHING;
    SELECT blob_inventory INTO destination FROM agent_file_usage WHERE tenant_id=current_setting('foxwarm.tenant')::integer FOR UPDATE;
    RETURN destination;
END $$;

CREATE FUNCTION foxwarm_agent_inventory_add(key text, size bigint, present boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF foxwarm_agent_inventory_lock() IS NOT NULL THEN RAISE EXCEPTION 'Agent blob inventory already complete'; END IF;
    INSERT INTO agent_blob_reservations(content_key,object_key,byte_length,state)
        VALUES (key,key,size,CASE WHEN present THEN 'stored' ELSE 'deleting' END)
        ON CONFLICT (tenant_id,content_key) DO UPDATE SET byte_length=agent_blob_reservations.byte_length+excluded.byte_length,
            state=CASE WHEN present THEN 'stored' ELSE agent_blob_reservations.state END;
END $$;

CREATE FUNCTION foxwarm_agent_inventory_finish(destination text) RETURNS void LANGUAGE plpgsql STRICT SECURITY DEFINER AS $$
BEGIN
    IF foxwarm_agent_inventory_lock() IS NOT NULL THEN RAISE EXCEPTION 'Agent blob inventory already complete'; END IF;
    UPDATE agent_file_usage SET blob_inventory=destination WHERE tenant_id=current_setting('foxwarm.tenant')::integer;
END $$;

DO $$
DECLARE fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['foxwarm_agent_inventory_lock','foxwarm_agent_inventory_add','foxwarm_agent_inventory_finish'] LOOP
        EXECUTE format('ALTER FUNCTION %I SET search_path TO pg_catalog,%I,pg_temp',fn,current_schema());
        EXECUTE format('REVOKE ALL ON FUNCTION %I FROM PUBLIC',fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %I TO %I',fn,current_setting('foxwarm.operator_role'));
    END LOOP;
END $$;
