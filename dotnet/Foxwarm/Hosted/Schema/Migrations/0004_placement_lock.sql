-- reader-floor: 1
-- A change of a tenant's placement-relevant columns (profile, pin) locks its lease row, the
-- row an acquisition locks before it checks eligibility. An edit therefore waits for a grant
-- in flight, and an acquisition that starts during the edit waits for it and sees its result:
-- a grant's checked profile is never older than a committed edit. This holds for every
-- writer, including direct SQL by the operator role. FOR NO KEY UPDATE doesn't wait on the
-- lease checks' FOR KEY SHARE.
CREATE FUNCTION foxwarm_lock_lease_for_placement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
    PERFORM 1 FROM tenant_leases WHERE tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION foxwarm_lock_lease_for_placement() FROM PUBLIC;
CREATE TRIGGER foxwarm_lock_lease_for_placement BEFORE UPDATE OF profile, pinned_role ON tenants
    FOR EACH ROW
    WHEN (OLD.profile IS DISTINCT FROM NEW.profile OR OLD.pinned_role IS DISTINCT FROM NEW.pinned_role)
    EXECUTE FUNCTION foxwarm_lock_lease_for_placement();
