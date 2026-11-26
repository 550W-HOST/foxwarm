-- reader-floor: 1
-- Tenant configuration documents (IConfigDocumentStore): config, models, tool-authorization,
-- mcp and webui. One row per closed document name with its text verbatim (a byte order mark
-- stays part of the text), a generation raised by every replacement and the text's SHA-256.

CREATE TABLE config_documents (
    tenant_id integer NOT NULL,
    name text COLLATE "C" NOT NULL
        CHECK (name IN ('config', 'models', 'tool-authorization', 'mcp', 'webui')),
    text text COLLATE "C" NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text COLLATE "C",
    PRIMARY KEY (tenant_id, name)
);
SELECT foxwarm_tenant_table('config_documents', 'SELECT, INSERT, UPDATE');
