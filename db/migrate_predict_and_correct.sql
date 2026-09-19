-- Additive migration for existing PantryPulse databases.
-- Safe to run more than once.

ALTER TABLE check_ins
    ADD COLUMN IF NOT EXISTS distribution_model distribution_model;

ALTER TABLE check_ins
    ADD COLUMN IF NOT EXISTS estimated_lbs NUMERIC(8,2);

ALTER TABLE check_ins
    ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb;
