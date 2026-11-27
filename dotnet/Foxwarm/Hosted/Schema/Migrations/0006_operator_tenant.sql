-- reader-floor: 1
-- One master volume and one operator tenant. Existing operator profiles get the explicit
-- pin that placement now requires; a pin never confers the operator profile.
UPDATE tenants SET pinned_role = 'master-host' WHERE profile = 'operator' AND pinned_role IS NULL;
ALTER TABLE tenants ADD CONSTRAINT tenants_operator_pin
    CHECK ((profile = 'operator') = (pinned_role IS NOT DISTINCT FROM 'master-host'));
CREATE UNIQUE INDEX tenants_one_operator ON tenants (profile) WHERE profile = 'operator';
