-- Е-Тарих: QR-викторина кестелері
-- Supabase SQL Editor ішінде бір рет орындаңыз.

create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  access_code_id uuid not null references public.access_codes(id) on delete cascade,
  teacher_id uuid references public.teacher_accounts(id) on delete set null,
  title text not null,
  subject text not null default '',
  grade text not null default '',
  questions jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  student_name text not null,
  answers jsonb not null default '[]'::jsonb,
  score integer not null default 0,
  total integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists quizzes_access_created_idx on public.quizzes (access_code_id, created_at desc);
create index if not exists quiz_attempts_quiz_score_idx on public.quiz_attempts (quiz_id, score desc, created_at asc);

alter table public.quizzes enable row level security;
alter table public.quiz_attempts enable row level security;
revoke all on public.quizzes from anon, authenticated;
revoke all on public.quiz_attempts from anon, authenticated;
