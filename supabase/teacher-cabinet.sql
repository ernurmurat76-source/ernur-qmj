-- Е-Тарих: мұғалімнің жеке кабинеті
-- Supabase SQL Editor ішінде бір рет орындаңыз.

create extension if not exists pgcrypto;

create table if not exists public.teacher_accounts (
  id uuid primary key default gen_random_uuid(),
  access_code_id uuid not null unique references public.access_codes(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  phone text not null default '',
  school text not null default '',
  subject text not null default '',
  password_salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teacher_documents (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teacher_accounts(id) on delete cascade,
  title text not null,
  subject text not null default '',
  grade text not null default '',
  term text not null default '',
  topic text not null default '',
  form_data jsonb not null default '{}'::jsonb,
  generated_html text not null,
  generated_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teacher_documents_teacher_created_idx
  on public.teacher_documents (teacher_id, created_at desc);

alter table public.teacher_accounts enable row level security;
alter table public.teacher_documents enable row level security;

-- Кестелер тек сервердегі service role кілті арқылы қолданылады.
revoke all on public.teacher_accounts from anon, authenticated;
revoke all on public.teacher_documents from anon, authenticated;
