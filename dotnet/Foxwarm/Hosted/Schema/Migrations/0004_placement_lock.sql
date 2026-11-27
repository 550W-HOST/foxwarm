-- reader-floor: 1
-- A change of a tenant's placement-relevant columns (profile, pin) locks its lease row, the
-- row an acquisition locks before it checks eligibility. An edit therefore waits for a grant
-- in flight, and an acquisition that starts during the edit waits for it and sees its result:
-- a grant's checked profile is never older than a committed edit. This holds for every
-- writer, including direct SQL by the operator role. FOR NO KEY UPDATE doesn't wait on the
-- lease checks' FOR KEY SHARE.
--
-- The function runs with the editor's own rights (the operator role may update lease rows),
-- and names the lease table in the installation schema, with pg_temp searched last, so no
-- other relation can stand in for it.
DO $$
DECLARE
    installation text := current_schema();
BEGIN
    EXECUTE format(
        'CREATE FUNCTION %1$I.foxwarm_lock_lease_for_placement() RETURNS trigger'
        ' LANGUAGE plpgsql SECURITY INVOKER SET search_path = %1$I, pg_temp AS $body$'
        ' BEGIN'
        '     PERFORM 1 FROM %1$I.tenant_leases WHERE tenant_id = NEW.tenant_id FOR NO KEY UPDATE;'
        '     RETURN NEW;'
        ' END'
        ' $body$',
        installation
    );
END
$$;
REVOKE ALL ON FUNCTION foxwarm_lock_lease_for_placement() FROM PUBLIC;
CREATE TRIGGER foxwarm_lock_lease_for_placement BEFORE UPDATE OF profile, pinned_role ON tenants
    FOR EACH ROW
    WHEN (OLD.profile IS DISTINCT FROM NEW.profile OR OLD.pinned_role IS DISTINCT FROM NEW.pinned_role)
    EXECUTE FUNCTION foxwarm_lock_lease_for_placement();
