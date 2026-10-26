-- Kassakoll: databas och bildlagring i Supabase.
-- Klistra in allt i Supabase > SQL Editor och tryck Run. Går att köra flera gånger.

-- All data (kvitton, budgetplaner, inställningar) som rader per användare
create table if not exists public.kassakoll_items (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  store text not null,
  key text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, store, key)
);

-- Varje användare ser och ändrar bara sina egna rader
alter table public.kassakoll_items enable row level security;

drop policy if exists "egna rader läsa" on public.kassakoll_items;
drop policy if exists "egna rader skapa" on public.kassakoll_items;
drop policy if exists "egna rader ändra" on public.kassakoll_items;
drop policy if exists "egna rader ta bort" on public.kassakoll_items;
create policy "egna rader läsa" on public.kassakoll_items for select to authenticated using (auth.uid() = user_id);
create policy "egna rader skapa" on public.kassakoll_items for insert to authenticated with check (auth.uid() = user_id);
create policy "egna rader ändra" on public.kassakoll_items for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "egna rader ta bort" on public.kassakoll_items for delete to authenticated using (auth.uid() = user_id);

-- Privat bucket för kvittobilder. Varje användare har en egen mapp: <user id>/<kvitto id>.jpg
insert into storage.buckets (id, name, public)
values ('kvitton', 'kvitton', false)
on conflict (id) do nothing;

drop policy if exists "kvitton läsa egna" on storage.objects;
drop policy if exists "kvitton skapa egna" on storage.objects;
drop policy if exists "kvitton ändra egna" on storage.objects;
drop policy if exists "kvitton ta bort egna" on storage.objects;
create policy "kvitton läsa egna" on storage.objects for select to authenticated
  using (bucket_id = 'kvitton' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kvitton skapa egna" on storage.objects for insert to authenticated
  with check (bucket_id = 'kvitton' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kvitton ändra egna" on storage.objects for update to authenticated
  using (bucket_id = 'kvitton' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kvitton ta bort egna" on storage.objects for delete to authenticated
  using (bucket_id = 'kvitton' and (storage.foldername(name))[1] = auth.uid()::text);
