-- Deck Forge: online backup of each person's card collection, saved decks and history,
-- plus "wrong scan" reports (photo + the right card) used to improve the scanner.
-- Same Supabase project as Frisbee Stats / Soccer Stats, so the same accounts sign in.
-- Safe to run more than once.

-- One row per account: the latest copy of everything.
create table if not exists public.deck_forge_data (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  device     text
);
alter table public.deck_forge_data enable row level security;
drop policy if exists "own deck forge data: read"   on public.deck_forge_data;
drop policy if exists "own deck forge data: add"    on public.deck_forge_data;
drop policy if exists "own deck forge data: change" on public.deck_forge_data;
create policy "own deck forge data: read"   on public.deck_forge_data for select using (user_id = auth.uid());
create policy "own deck forge data: add"    on public.deck_forge_data for insert with check (user_id = auth.uid());
create policy "own deck forge data: change" on public.deck_forge_data for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- (no delete policy: the app can never delete the online copy)

-- Snapshots kept forever (at most one a day from the app), so an older copy can always be
-- restored. Add-only: the app can't change or delete them.
create table if not exists public.deck_forge_backups (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  reason     text,
  created_at timestamptz not null default now()
);
create index if not exists deck_forge_backups_user on public.deck_forge_backups (user_id, created_at desc);
alter table public.deck_forge_backups enable row level security;
drop policy if exists "own deck forge backups: read" on public.deck_forge_backups;
drop policy if exists "own deck forge backups: add"  on public.deck_forge_backups;
create policy "own deck forge backups: read" on public.deck_forge_backups for select using (user_id = auth.uid());
create policy "own deck forge backups: add"  on public.deck_forge_backups for insert with check (user_id = auth.uid());

-- Wrong-scan reports: what the scanner guessed, what the card really was, and the photo.
create table if not exists public.deck_forge_scan_reports (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  guess        jsonb,
  correct_id   text,
  correct_name text,
  photo_path   text,
  details      jsonb,
  created_at   timestamptz not null default now()
);
alter table public.deck_forge_scan_reports enable row level security;
drop policy if exists "own scan reports: read" on public.deck_forge_scan_reports;
drop policy if exists "own scan reports: add"  on public.deck_forge_scan_reports;
create policy "own scan reports: read" on public.deck_forge_scan_reports for select using (user_id = auth.uid());
create policy "own scan reports: add"  on public.deck_forge_scan_reports for insert with check (user_id = auth.uid());

-- Private photo storage for the reports: each account can only use its own folder (<user id>/...).
insert into storage.buckets (id, name, public) values ('deck-forge-scans', 'deck-forge-scans', false)
on conflict (id) do nothing;
drop policy if exists "deck forge scans: add own"  on storage.objects;
drop policy if exists "deck forge scans: read own" on storage.objects;
create policy "deck forge scans: add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'deck-forge-scans' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "deck forge scans: read own" on storage.objects for select to authenticated
  using (bucket_id = 'deck-forge-scans' and (storage.foldername(name))[1] = auth.uid()::text);
