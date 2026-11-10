-- phase: expand
-- Code sources (server/code/registry.js): the owner console's on/off switch survives a restart. A row is
-- written only when an operator changes a source; the registry's default is the config's (on).
CREATE TABLE IF NOT EXISTS code_source_settings (
    source_id  text COLLATE "C" PRIMARY KEY,
    enabled    bigint NOT NULL DEFAULT 1,
    updated_at text COLLATE "C" NOT NULL
);
