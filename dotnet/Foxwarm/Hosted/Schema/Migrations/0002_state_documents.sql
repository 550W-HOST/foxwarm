-- reader-floor: 1
-- Whole-document installation state (IStateDocuments): one row per closed document name, the
-- document text verbatim and a generation raised by every replacement.

CREATE TABLE state_documents (
    tenant_id integer NOT NULL,
    name text COLLATE "C" NOT NULL,
    text text COLLATE "C" NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, name)
);
SELECT foxwarm_tenant_table('state_documents', 'SELECT, INSERT, UPDATE, DELETE');
