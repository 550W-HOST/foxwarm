-- reader-floor: 1
-- Immutable blobs of the PostgreSQL blob backend (IBlobStore): one object row per key of a
-- store (`images`, `artifacts`) and its content in 1 MiB chunks. A key is written once, the
-- object row and all of its chunks in one transaction; rows are never updated. Deleting
-- unreferenced blobs comes with P3's collection, so the runtime role may only insert.

CREATE TABLE blob_objects (
    tenant_id integer NOT NULL,
    store text COLLATE "C" NOT NULL,
    key text COLLATE "C" NOT NULL,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    chunk_count integer NOT NULL CHECK (chunk_count >= 0),
    sha256 bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, store, key)
);
SELECT foxwarm_tenant_table('blob_objects', 'SELECT, INSERT');

CREATE TABLE blob_chunks (
    tenant_id integer NOT NULL,
    store text COLLATE "C" NOT NULL,
    key text COLLATE "C" NOT NULL,
    chunk integer NOT NULL CHECK (chunk >= 0),
    data bytea NOT NULL,
    PRIMARY KEY (tenant_id, store, key, chunk),
    FOREIGN KEY (tenant_id, store, key) REFERENCES blob_objects (tenant_id, store, key)
);
-- Image and artifact content is mostly compressed already; store it out of line uncompressed.
ALTER TABLE blob_chunks ALTER COLUMN data SET STORAGE EXTERNAL;
SELECT foxwarm_tenant_table('blob_chunks', 'SELECT, INSERT');
