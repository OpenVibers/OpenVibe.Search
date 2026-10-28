-- phase: expand
-- Search Fabric: cached provider answers and per-provider daily call stats (server/fabric).
CREATE TABLE IF NOT EXISTS query_cache (
    key        text PRIMARY KEY,
    scope      text NOT NULL,
    step       text NOT NULL,
    results    jsonb NOT NULL,
    cost_usd   numeric NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS query_cache_expires_at_idx ON query_cache (expires_at);

CREATE TABLE IF NOT EXISTS query_provider_stats (
    day      date NOT NULL,
    provider text NOT NULL,
    calls    integer NOT NULL DEFAULT 0,
    answered integer NOT NULL DEFAULT 0,
    ms_total bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider)
);
