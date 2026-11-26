-- reader-floor: 2
CREATE TABLE toolscript_runs (
    tenant_id integer NOT NULL,
    run_id text COLLATE "C" NOT NULL,
    owner text COLLATE "C",
    status text COLLATE "C",
    updated_at double precision NOT NULL,
    record bytea NOT NULL,
    PRIMARY KEY (tenant_id, run_id)
);
SELECT foxwarm_tenant_table('toolscript_runs', 'SELECT, INSERT, UPDATE');
CREATE INDEX toolscript_runs_owner_latest
    ON toolscript_runs (tenant_id, owner, updated_at DESC NULLS LAST, run_id ASC NULLS FIRST);
