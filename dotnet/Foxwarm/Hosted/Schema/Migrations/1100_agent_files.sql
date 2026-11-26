-- reader-floor: 1
-- The Agent store (IAgentFileStore in hosted mode): one row per file of an Agent, per empty
-- directory, and one root row (path '') per existing Agent. agent '' is the installation level
-- beside the Agent folders. Content of up to 256 KiB is inline; larger content is a blob of the
-- tenant's blob store, written before the row that references it. generation comes from the
-- tenant's agent_file_usage counter, so it is unique per tenant and never reused for a path.

CREATE TABLE agent_files (
    tenant_id integer NOT NULL,
    agent text COLLATE "C" NOT NULL,
    path text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('file', 'dir')),
    size bigint NOT NULL DEFAULT 0 CHECK (size >= 0),
    sha256 bytea,
    generation bigint NOT NULL,
    inline bytea,
    blob_key text COLLATE "C",
    mode_flags integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, agent, path),
    CHECK (
        kind = 'dir' AND size = 0 AND sha256 IS NULL AND inline IS NULL AND blob_key IS NULL
        OR kind = 'file' AND sha256 IS NOT NULL AND (inline IS NULL) <> (blob_key IS NULL)
    ),
    CHECK (path <> '' OR kind = 'dir')
);
SELECT foxwarm_tenant_table('agent_files', 'SELECT, INSERT, UPDATE, DELETE');

-- One row per tenant: the measured usage the limits apply to, and the generation counter.
-- Every write locks it, which serializes the tenant's Agent file writes and makes the limit
-- checks exact.
CREATE TABLE agent_file_usage (
    tenant_id integer NOT NULL,
    bytes bigint NOT NULL DEFAULT 0,
    entries bigint NOT NULL DEFAULT 0,
    generation bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id)
);
SELECT foxwarm_tenant_table('agent_file_usage', 'SELECT, INSERT, UPDATE');
