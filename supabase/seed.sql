-- Phase 1 deliberately does not insert auth.users or publish a shared password.
-- Create fictitious users through Supabase Authentication > Users > Add user:
--   viewer@example.test, operator@example.test, admin@example.test
-- Choose unique passwords privately and enable Auto Confirm for test accounts.
-- The migration creates a Viewer profile for each new account automatically.
-- Assign test roles using the audited SQL examples in docs/DATABASE.md.
-- Business data (materials, LOTs, stock) belongs to Phase 2 and is not seeded here.
select 'Phase 1: create fictitious Auth users using docs/DATABASE.md' as seed_instruction;
