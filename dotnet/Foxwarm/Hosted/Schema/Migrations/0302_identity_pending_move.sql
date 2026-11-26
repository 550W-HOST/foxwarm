-- reader-floor: 1
-- The pending Session identity move (IIdentityLedger): at most one intent per tenant, the
-- record text verbatim. Startup recovery replays it in its recorded direction. Committed
-- mappings are session_id_reservations (0300).

CREATE TABLE session_identity_pending_move (
    tenant_id integer NOT NULL,
    record text COLLATE "C" NOT NULL,
    written_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id)
);
SELECT foxwarm_tenant_table('session_identity_pending_move', 'SELECT, INSERT, UPDATE, DELETE');
