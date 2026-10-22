-- Applied on every server start; each statement must be safe to re-run.

create table if not exists users (
  id bigserial primary key,
  google_sub text not null unique,
  email text not null,
  name text,
  picture text,
  -- Remaining call time. Calls are cut off when it runs out.
  balance_seconds integer not null default 0 check (balance_seconds >= 0),
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

create table if not exists sessions (
  -- sha256 of the cookie value, so a leaked table does not leak live sessions.
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id on sessions(user_id);

create table if not exists calls (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  provider text not null,
  options jsonb not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  -- Seconds deducted from the balance (from the tutor picking up to hang-up).
  billed_seconds integer,
  -- [{ role: 'user' | 'assistant', text }]
  transcript jsonb,
  feedback jsonb
);
create index if not exists calls_user_started on calls(user_id, started_at desc);
