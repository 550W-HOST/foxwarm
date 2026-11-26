-- reader-floor: 1
-- Session authority (ISessionAuthorityBackend): a head per Session plus immutable history
-- segments and envelope parts keyed by the head's lifetime, so an identity move rewrites only
-- the head. Segment and part rows are never updated: a commit inserts the new ones and deletes
-- the replaced ones in the same transaction.

CREATE TABLE session_heads (
    tenant_id integer NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    lifetime_id uuid NOT NULL,
    doc_version bigint NOT NULL,
    commit_id uuid NOT NULL,
    -- The prepared state without history: compact UTF-8 JSON keeping the position of the
    -- history property, with null in place of each member stored as a part.
    envelope bytea COMPRESSION lz4 NOT NULL,
    -- Member name to the hex SHA-256 of its part.
    parts jsonb NOT NULL,
    segment_ids bigint[] NOT NULL,
    segment_counts integer[] NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, session_id),
    UNIQUE (tenant_id, lifetime_id)
);
SELECT foxwarm_tenant_table('session_heads', 'SELECT, INSERT, UPDATE, DELETE');

CREATE TABLE session_segments (
    tenant_id integer NOT NULL,
    lifetime_id uuid NOT NULL,
    segment_id bigint NOT NULL,
    record_count integer NOT NULL,
    byte_length integer NOT NULL,
    -- 0: a JSON array of the records as the authority writer serializes them.
    codec smallint NOT NULL,
    records bytea COMPRESSION lz4 NOT NULL,
    PRIMARY KEY (tenant_id, lifetime_id, segment_id)
);
SELECT foxwarm_tenant_table('session_segments', 'SELECT, INSERT, DELETE');

CREATE TABLE session_envelope_parts (
    tenant_id integer NOT NULL,
    lifetime_id uuid NOT NULL,
    sha256 bytea NOT NULL,
    -- The member's string value as UTF-8.
    value bytea COMPRESSION lz4 NOT NULL,
    PRIMARY KEY (tenant_id, lifetime_id, sha256)
);
SELECT foxwarm_tenant_table('session_envelope_parts', 'SELECT, INSERT, DELETE');
