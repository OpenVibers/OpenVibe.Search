-- phase: expand
-- Trending searches (plan 2026-11-13 §AD.13 (1); server/trending.js): what people type into the network's search boxes,
-- as hourly counts per normalized query and site, so every search box can scroll through what is trending and Report
-- can show search volume. No person and no address is kept: a visitor is a hash under a salt that changes every day and
-- is deleted after two, so yesterday's visitor cannot be matched to today's. Counts go after 8 days, visitors after 2.
-- Additive: three new empty tables.
CREATE TABLE IF NOT EXISTS search_trends (
    hour   bigint NOT NULL,
    site   text COLLATE "C" NOT NULL,
    query  text COLLATE "C" NOT NULL,
    shown  text NOT NULL,
    count  bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, site, query)
);
CREATE INDEX IF NOT EXISTS search_trends_query ON search_trends (query, hour);
CREATE TABLE IF NOT EXISTS search_trend_visitors (
    day     bigint NOT NULL,
    query   text COLLATE "C" NOT NULL,
    visitor text COLLATE "C" NOT NULL,
    PRIMARY KEY (day, query, visitor)
);
CREATE TABLE IF NOT EXISTS search_trend_salts (
    day  bigint PRIMARY KEY,
    salt text NOT NULL
);
