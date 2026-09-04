-- Chakudya Nutrition Registry
-- Migration: food_log_entries — nutrition diary entries for GET/POST/DELETE
-- /log and the GET /log/summary daily/weekly aggregate. Same public,
-- self-declared-identity model as favorites/view_history (no server-side
-- account system; user_id is whatever the client supplies).
-- Safe to re-run: uses IF NOT EXISTS throughout.

create table if not exists public.food_log_entries (
  id bigint generated always as identity primary key,
  user_id text not null,
  entry_date date not null default current_date,
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'snack', 'dinner')),
  food_name text,
  calories numeric not null check (calories >= 0),
  created_at timestamptz not null default now()
);

create index if not exists food_log_entries_user_date_idx
  on public.food_log_entries (user_id, entry_date);

comment on table public.food_log_entries is
  'Nutrition diary entries — one row per logged item under a meal slot (breakfast/lunch/snack/dinner) for a given day. Aggregated by GET /log/summary.';
