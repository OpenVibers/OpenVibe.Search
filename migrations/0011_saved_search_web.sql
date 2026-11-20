-- phase: expand
-- Watching the web (plan AD.34 item 6, 11-20): a saved search may watch the web instead of the network's own index. Once a
-- day the notifier runs it through the fabric's web scope (Exchange search v2) as its owner, and tells the owner when
-- results appear that it has not shown before. `seen` keeps the canonical keys of the results already shown (at most
-- 300, newest first, a JSON array of short hashes: never the pages themselves); `web_checked_at` is the last run (epoch
-- ms). Additive: three columns with defaults, and an index for the day's queue.
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'network';
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS seen text NOT NULL DEFAULT '[]';
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS web_checked_at bigint;
CREATE INDEX IF NOT EXISTS idx_saved_searches_web_due ON saved_searches (web_checked_at) WHERE scope = 'web';
