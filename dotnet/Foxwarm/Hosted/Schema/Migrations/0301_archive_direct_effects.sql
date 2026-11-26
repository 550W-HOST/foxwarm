-- reader-floor: 1
-- Direct effect records (ArchiveToolEffects direct rows): effects that never reach a Session
-- Archive, such as unattended ToolScript calls and inbound MCP calls. They are the only record
-- of those effects, so unlike the derived activity index they are stored in hosted mode. The
-- columns are those of the file-mode archive_direct_effects table; id keeps insertion order.

CREATE TABLE archive_direct_effects (
    tenant_id integer NOT NULL,
    id bigint GENERATED ALWAYS AS IDENTITY,
    session_id text COLLATE "C",
    agent text COLLATE "C",
    started_at bigint NOT NULL,
    duration_ms double precision,
    origin text COLLATE "C" NOT NULL,
    tool text COLLATE "C" NOT NULL,
    source text COLLATE "C",
    server text COLLATE "C",
    node text COLLATE "C",
    action text COLLATE "C",
    outcome text COLLATE "C" NOT NULL,
    error_type text COLLATE "C",
    approval text COLLATE "C",
    approver text COLLATE "C",
    rules text COLLATE "C",
    summary text COLLATE "C",
    input_seq bigint,
    initiator_kind text COLLATE "C",
    initiator_id text COLLATE "C",
    initiator_from text COLLATE "C",
    run_id text COLLATE "C",
    refs text COLLATE "C",
    PRIMARY KEY (tenant_id, id)
);
CREATE INDEX archive_direct_effects_time ON archive_direct_effects (tenant_id, started_at);
CREATE INDEX archive_direct_effects_session ON archive_direct_effects (tenant_id, session_id);
SELECT foxwarm_tenant_table('archive_direct_effects', 'SELECT, INSERT, UPDATE (session_id)');
