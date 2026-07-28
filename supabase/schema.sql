-- Lodówka — schemat Supabase (Postgres)
-- Uruchom w: Supabase Dashboard → SQL Editor → New query → wklej całość → Run

-- ---------------------------------------------------------------------------
-- households: jedno "gospodarstwo domowe" dla pary. Oboje dołączają przez
-- invite_code (żeby nie trzeba było zapraszać po ID).
-- ---------------------------------------------------------------------------
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Nasza lodówka',
  invite_code text unique not null default substr(md5(random()::text), 1, 6),
  -- Wolny tekst: co domownicy lubią/czego nie lubią jeść, diety, alergie itp.
  -- Uwzględniane przy podpowiedziach przepisów i planu tygodnia.
  food_preferences text,
  created_at timestamptz not null default now()
);
alter table households add column if not exists food_preferences text;

-- profiles: łączy auth.users z household_id (nie było w oryginalnej liście
-- tabel, ale jest niezbędne, żeby wiedzieć "kto należy do jakiej lodówki").
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  email text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  category text not null default 'inne'
    check (category in ('nabiał','mięso','warzywa','owoce','pieczywo','mrożonki','inne')),
  quantity text,
  purchase_date date not null default current_date,
  expiry_date date not null,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists products_household_expiry_idx
  on products (household_id, expiry_date) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table households enable row level security;
alter table profiles enable row level security;
alter table products enable row level security;
alter table push_subscriptions enable row level security;

-- profiles: user widzi/edytuje tylko swój wiersz
create policy "profiles: select own" on profiles
  for select using (auth.uid() = id);
create policy "profiles: insert own" on profiles
  for insert with check (auth.uid() = id);
create policy "profiles: update own" on profiles
  for update using (auth.uid() = id);

-- households: user widzi households tylko jeśli jest jej członkiem,
-- ale musi też móc znaleźć household po invite_code żeby dołączyć —
-- do tego służy funkcja join_household_by_code() poniżej (SECURITY DEFINER).
create policy "households: select own" on households
  for select using (
    id in (select household_id from profiles where id = auth.uid())
  );
create policy "households: insert any authenticated" on households
  for insert with check (auth.role() = 'authenticated');
create policy "households: update own" on households
  for update using (
    id in (select household_id from profiles where id = auth.uid())
  );

-- products: dostęp tylko w ramach własnego household_id
create policy "products: select own household" on products
  for select using (
    household_id in (select household_id from profiles where id = auth.uid())
  );
create policy "products: insert own household" on products
  for insert with check (
    household_id in (select household_id from profiles where id = auth.uid())
  );
create policy "products: update own household" on products
  for update using (
    household_id in (select household_id from profiles where id = auth.uid())
  );
create policy "products: delete own household" on products
  for delete using (
    household_id in (select household_id from profiles where id = auth.uid())
  );

-- push_subscriptions: user zarządza tylko swoimi subskrypcjami
create policy "push: select own" on push_subscriptions
  for select using (auth.uid() = user_id);
create policy "push: insert own" on push_subscriptions
  for insert with check (auth.uid() = user_id);
create policy "push: delete own" on push_subscriptions
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- join_household_by_code: pozwala dołączyć do household znając invite_code,
-- bez potrzeby nadawania ogólnego SELECT na households (RLS by na to nie
-- pozwoliło, bo user przed dołączeniem nie ma jeszcze household_id).
-- ---------------------------------------------------------------------------
create or replace function join_household_by_code(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_household_id uuid;
begin
  select id into target_household_id from households where invite_code = code;
  if target_household_id is null then
    raise exception 'Nieprawidłowy kod zaproszenia';
  end if;

  update profiles set household_id = target_household_id where id = auth.uid();
  return target_household_id;
end;
$$;

-- create_household_for_self: tworzy nowe household i przypisuje bieżącego usera
create or replace function create_household_for_self(household_name text default 'Nasza lodówka')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into households (name) values (household_name) returning id into new_id;
  update profiles set household_id = new_id where id = auth.uid();
  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Auto-tworzenie profilu przy pierwszym logowaniu (magic link)
-- ---------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Realtime: dodaj products do publikacji, żeby zmiany szły na żywo do obu osób
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table products;
