-- reader-floor: 1
-- The Archive (IArchiveStore): immutable message and block rows, branch lineage and committed
-- Session-ID reservations. Rows are never updated except by an identity rename, so the runtime
-- role may UPDATE only the identity columns that rename rewrites. DELETE serves the exact
-- rollback of rows an attempt inserted.

CREATE TABLE archive_messages (
    tenant_id integer NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    seq bigint NOT NULL,
    agent text COLLATE "C" NOT NULL,
    timestamp double precision NOT NULL,
    role text COLLATE "C" NOT NULL,
    message_json text COLLATE "C" NOT NULL,
    -- Extracted from message_json at insert: its modelVisible flag, and the small projection
    -- the sequence view reads (ArchiveSequenceProjection).
    model_visible boolean,
    sequence_data text COLLATE "C" NOT NULL,
    PRIMARY KEY (tenant_id, session_id, seq)
);
SELECT foxwarm_tenant_table('archive_messages', 'SELECT, INSERT, DELETE, UPDATE (session_id)');

CREATE TABLE archive_blocks (
    tenant_id integer NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    id bigint NOT NULL,
    agent text COLLATE "C" NOT NULL,
    level integer NOT NULL,
    source_kind text COLLATE "C" NOT NULL,
    source_start bigint NOT NULL,
    source_end bigint NOT NULL,
    source_block_ids_json text COLLATE "C",
    raw_start_seq bigint NOT NULL,
    raw_end_seq bigint NOT NULL,
    raw_start_timestamp double precision,
    raw_end_timestamp double precision,
    summary text COLLATE "C" NOT NULL,
    memory_facts_json text COLLATE "C",
    created_at bigint NOT NULL,
    friction_score integer,
    PRIMARY KEY (tenant_id, session_id, id)
);
SELECT foxwarm_tenant_table('archive_blocks', 'SELECT, INSERT, DELETE, UPDATE (session_id)');

CREATE TABLE archive_branches (
    tenant_id integer NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    parent_session_id text COLLATE "C",
    fork_message_seq bigint NOT NULL DEFAULT 0,
    fork_block_id bigint NOT NULL DEFAULT 0,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX archive_branches_parent ON archive_branches (tenant_id, parent_session_id);
SELECT foxwarm_tenant_table(
    'archive_branches',
    'SELECT, INSERT, DELETE, UPDATE (session_id, parent_session_id, updated_at)'
);

-- Committed identity mappings: a retired Session ID and the identity it now resolves to. The
-- one authority both the Archive readers and the identity ledger use (file mode keeps a JSONL
-- ledger with a SQLite mirror).
CREATE TABLE session_id_reservations (
    tenant_id integer NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    canonical_session_id text COLLATE "C" NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX session_id_reservations_canonical
    ON session_id_reservations (tenant_id, canonical_session_id);
SELECT foxwarm_tenant_table('session_id_reservations', 'SELECT, INSERT');
