-- ============================================================
-- Cometa OS v2 · banco em tabelas + Cometinha + Meta
--
-- Pode rodar mais de uma vez sem estragar nada.
-- Rode em: Supabase › SQL Editor › New query › cole tudo › Run
--
-- O que faz:
--   1. cria as tabelas (clientes, atividades, compromissos, ...)
--   2. liga as permissões de verdade (RLS): cada pessoa só
--      consegue fazer, no banco, o que a tela dela permite
--   3. copia os dados do formato antigo (tabela "estado") para
--      as tabelas novas. A tabela "estado" fica intacta como cópia.
-- ============================================================


-- ---------- funções de conversão seguras (usadas na migração) ----------
create or replace function public._num(t text) returns numeric
language plpgsql immutable as $$
begin return nullif(replace(trim(t), ',', '.'), '')::numeric;
exception when others then return null; end $$;

create or replace function public._int(t text) returns int
language plpgsql immutable as $$
begin return nullif(trim(t), '')::numeric::int;
exception when others then return null; end $$;

create or replace function public._data(t text) returns date
language plpgsql immutable as $$
begin return nullif(trim(t), '')::date;
exception when others then return null; end $$;

create or replace function public._ms(t text) returns timestamptz
language plpgsql immutable as $$
begin
  if t is null or trim(t) = '' then return null; end if;
  return to_timestamp(trim(t)::numeric / 1000.0);
exception when others then return null; end $$;

-- ============================================================
-- 1. TABELAS
-- ============================================================

-- equipe (já existe no Cometa atual; aqui só garante a estrutura)
create table if not exists public.perfis (
  id         uuid primary key references auth.users(id) on delete cascade,
  nome       text not null default '',
  email      text,
  papel      text not null default 'operador',
  permissoes jsonb not null default '{}'::jsonb,
  ativo      boolean not null default true
);
alter table public.perfis add column if not exists whatsapp  text;
alter table public.perfis add column if not exists criado_em timestamptz not null default now();

create table if not exists public.clientes (
  id                text primary key,
  nome              text not null,
  contato           text,
  mensalidade       numeric(12,2),
  dia_venc          int,
  status            text not null default 'ativo',
  criado_em         timestamptz not null default now(),
  -- Meta (contas de anúncio e página ligadas a este cliente)
  meta_conta_id     text,
  meta_conta_nome   text,
  meta_pagina_id    text,
  meta_pagina_nome  text
);

create table if not exists public.atividades (
  id           text primary key,
  cliente_id   text not null references public.clientes(id) on delete cascade,
  titulo       text not null,
  obs          text,
  prioridade   text not null default 'normal',
  responsavel  text,
  recorrencia  text,
  data         date,
  criado_em    timestamptz not null default now(),
  feita_em     timestamptz,
  feita_por    text
);
create index if not exists atividades_cliente_idx on public.atividades(cliente_id);
create index if not exists atividades_abertas_idx on public.atividades(data) where feita_em is null;

create table if not exists public.compromissos (
  id           text primary key,
  tipo         text not null default 'Compromisso',
  cliente_id   text references public.clientes(id) on delete set null,
  data         date,
  hora         text,
  local        text,
  responsavel  text,
  obs          text,
  criado_em    timestamptz not null default now(),
  feito_em     timestamptz,
  feito_por    text
);

create table if not exists public.pagamentos (
  cliente_id  text not null references public.clientes(id) on delete cascade,
  mes         text not null check (mes ~ '^\d{4}-\d{2}$'),
  pago_em     timestamptz not null default now(),
  primary key (cliente_id, mes)
);

create table if not exists public.historico (
  id       text primary key default gen_random_uuid()::text,
  ts       timestamptz not null default now(),
  quem     text,
  acao     text not null,
  detalhe  text
);
create index if not exists historico_ts_idx on public.historico(ts desc);

create table if not exists public.ajustes (
  id        text primary key default 'principal' check (id = 'principal'),
  equipe    jsonb not null default '["Você"]'::jsonb,
  servicos  jsonb not null default '["Captação","Tráfego pago","Edição de vídeo","Postagem","Stories","Reunião","Relatório","Criativo"]'::jsonb
);
insert into public.ajustes (id) values ('principal') on conflict do nothing;

-- Cometinha: conversas e mensagens (o histórico só cresce, nunca é editado)
create table if not exists public.cometinha_conversas (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references public.perfis(id) on delete cascade,
  canal         text not null default 'app' check (canal in ('app','whatsapp')),
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists cometinha_conversas_usuario_idx
  on public.cometinha_conversas(usuario_id, canal, atualizado_em desc);

create table if not exists public.cometinha_mensagens (
  id           bigint generated always as identity primary key,
  conversa_id  uuid not null references public.cometinha_conversas(id) on delete cascade,
  role         text not null check (role in ('user','assistant')),
  content      jsonb not null,
  criado_em    timestamptz not null default now()
);
create index if not exists cometinha_mensagens_conversa_idx on public.cometinha_mensagens(conversa_id, id);

-- WhatsApp: evita responder duas vezes a mesma mensagem (a Meta reenvia)
create table if not exists public.whatsapp_processadas (
  id         text primary key,
  criado_em  timestamptz not null default now()
);

-- Cofre: chaves da Meta. Fica num esquema que o site NÃO enxerga.
-- Só as funções do servidor (Edge Functions) leem daqui.
create schema if not exists privado;
revoke all on schema privado from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema privado from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema privado from authenticated';
  end if;
end $$;

create table if not exists privado.meta_tokens (
  cliente_id  text primary key references public.clientes(id) on delete cascade,
  token       text not null,
  expira_em   date,
  criado_em   timestamptz not null default now()
);

-- ============================================================
-- 2. PERMISSÕES
-- ============================================================

create or replace function public.ativo() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfis where id = auth.uid() and ativo)
$$;

create or replace function public.eh_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfis where id = auth.uid() and ativo and papel = 'admin')
$$;

-- mesma regra da tela: admin pode tudo; operador só o que estiver marcado
create or replace function public.pode(k text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.perfis
    where id = auth.uid() and ativo
      and (papel = 'admin' or permissoes ->> k = 'true')
  )
$$;

create or replace function public.meu_nome() returns text
language sql stable security definer set search_path = public as $$
  select nome from public.perfis where id = auth.uid()
$$;

-- apaga as políticas antigas destas tabelas para não sobrar brecha
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('perfis','clientes','atividades','compromissos','pagamentos',
                        'historico','ajustes','cometinha_conversas','cometinha_mensagens',
                        'whatsapp_processadas')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.perfis               enable row level security;
alter table public.clientes             enable row level security;
alter table public.atividades           enable row level security;
alter table public.compromissos         enable row level security;
alter table public.pagamentos           enable row level security;
alter table public.historico            enable row level security;
alter table public.ajustes              enable row level security;
alter table public.cometinha_conversas  enable row level security;
alter table public.cometinha_mensagens  enable row level security;
alter table public.whatsapp_processadas enable row level security;

-- perfis: cada um vê o seu; admin vê e mexe em todos
create policy perfis_ler    on public.perfis for select to authenticated using (id = auth.uid() or public.eh_admin());
create policy perfis_criar  on public.perfis for insert to authenticated with check (public.eh_admin());
create policy perfis_mudar  on public.perfis for update to authenticated using (public.eh_admin()) with check (public.eh_admin());
create policy perfis_apagar on public.perfis for delete to authenticated using (public.eh_admin() and id <> auth.uid());

-- clientes: toda a equipe ativa vê; só quem tem "editar_clientes" mexe
create policy clientes_ler    on public.clientes for select to authenticated using (public.ativo());
create policy clientes_criar  on public.clientes for insert to authenticated with check (public.pode('editar_clientes'));
create policy clientes_mudar  on public.clientes for update to authenticated using (public.pode('editar_clientes')) with check (public.pode('editar_clientes'));
create policy clientes_apagar on public.clientes for delete to authenticated using (public.pode('editar_clientes'));

-- atividades
create policy atividades_ler    on public.atividades for select to authenticated using (public.ativo());
create policy atividades_criar  on public.atividades for insert to authenticated
  with check (public.pode('lancar') or (public.pode('concluir') and recorrencia is not null));
create policy atividades_mudar  on public.atividades for update to authenticated
  using (public.pode('lancar') or public.pode('concluir'))
  with check (public.pode('lancar') or public.pode('concluir'));
create policy atividades_apagar on public.atividades for delete to authenticated using (public.pode('excluir_atividade'));

-- quem só tem "concluir" pode dar OK/reabrir, mas não mudar o resto
create or replace function public.guarda_atividade() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or public.pode('lancar') then return new; end if;
  if (new.id, new.cliente_id, new.titulo, new.obs, new.prioridade, new.responsavel,
      new.recorrencia, new.data, new.criado_em)
     is distinct from
     (old.id, old.cliente_id, old.titulo, old.obs, old.prioridade, old.responsavel,
      old.recorrencia, old.data, old.criado_em) then
    raise exception 'sem permissão para editar esta atividade' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guarda_atividade on public.atividades;
create trigger guarda_atividade before update on public.atividades
  for each row execute function public.guarda_atividade();

-- compromissos
create policy compromissos_ler    on public.compromissos for select to authenticated using (public.ativo());
create policy compromissos_criar  on public.compromissos for insert to authenticated with check (public.pode('criar_compromisso'));
create policy compromissos_mudar  on public.compromissos for update to authenticated
  using (public.pode('criar_compromisso') or public.pode('concluir'))
  with check (public.pode('criar_compromisso') or public.pode('concluir'));
create policy compromissos_apagar on public.compromissos for delete to authenticated using (public.pode('criar_compromisso'));

create or replace function public.guarda_compromisso() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or public.pode('criar_compromisso') then return new; end if;
  if (new.id, new.tipo, new.cliente_id, new.data, new.hora, new.local, new.responsavel, new.obs, new.criado_em)
     is distinct from
     (old.id, old.tipo, old.cliente_id, old.data, old.hora, old.local, old.responsavel, old.obs, old.criado_em) then
    raise exception 'sem permissão para editar este compromisso' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guarda_compromisso on public.compromissos;
create trigger guarda_compromisso before update on public.compromissos
  for each row execute function public.guarda_compromisso();

-- pagamentos
create policy pagamentos_ler    on public.pagamentos for select to authenticated using (public.pode('ver_financeiro'));
create policy pagamentos_criar  on public.pagamentos for insert to authenticated with check (public.pode('editar_financeiro'));
create policy pagamentos_mudar  on public.pagamentos for update to authenticated using (public.pode('editar_financeiro')) with check (public.pode('editar_financeiro'));
create policy pagamentos_apagar on public.pagamentos for delete to authenticated using (public.pode('editar_financeiro'));

-- histórico: todos registram, só admin lê; o nome de quem fez é o do login
create policy historico_ler   on public.historico for select to authenticated using (public.eh_admin());
create policy historico_criar on public.historico for insert to authenticated with check (public.ativo());

create or replace function public.carimba_historico() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then new.quem := public.meu_nome(); end if;
  return new;
end $$;
drop trigger if exists carimba_historico on public.historico;
create trigger carimba_historico before insert on public.historico
  for each row execute function public.carimba_historico();

-- ajustes
create policy ajustes_ler   on public.ajustes for select to authenticated using (public.ativo());
create policy ajustes_mudar on public.ajustes for update to authenticated
  using (public.pode('ajustes') or public.eh_admin()) with check (public.pode('ajustes') or public.eh_admin());

-- Cometinha: cada um lê só as próprias conversas; quem grava é o servidor
create policy conversas_ler on public.cometinha_conversas for select to authenticated using (usuario_id = auth.uid());
create policy mensagens_ler on public.cometinha_mensagens for select to authenticated
  using (exists (select 1 from public.cometinha_conversas c where c.id = conversa_id and c.usuario_id = auth.uid()));
-- whatsapp_processadas: nenhuma política = ninguém do site lê ou grava

-- ============================================================
-- 3. SINCRONISMO AO VIVO (outros aparelhos atualizam na hora)
-- ============================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['clientes','atividades','compromissos','pagamentos','historico','ajustes'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- 4. MIGRAÇÃO: copia o formato antigo (estado.dados) para as tabelas
--    Só insere o que ainda não existe. A tabela "estado" não é tocada.
-- ============================================================
do $$
declare d jsonb;
begin
  if to_regclass('public.estado') is null then return; end if;
  select dados into d from public.estado where id = 'principal';
  if d is null then return; end if;

  insert into public.clientes (id, nome, contato, mensalidade, dia_venc, status, criado_em)
  select x->>'id', coalesce(nullif(x->>'nome',''), 'Sem nome'), nullif(x->>'contato',''),
         public._num(x->>'mensalidade'), public._int(x->>'diaVenc'),
         coalesce(nullif(x->>'status',''), 'ativo'),
         coalesce(public._ms(x->>'criadoEm'), now())
  from jsonb_array_elements(coalesce(d->'clientes','[]'::jsonb)) x
  where x->>'id' is not null
  on conflict (id) do nothing;

  insert into public.atividades (id, cliente_id, titulo, obs, prioridade, responsavel, recorrencia,
                                 data, criado_em, feita_em, feita_por)
  select x->>'id', x->>'clienteId', coalesce(nullif(x->>'titulo',''), 'Atividade'), nullif(x->>'obs',''),
         coalesce(nullif(x->>'prioridade',''), 'normal'), nullif(x->>'responsavel',''),
         nullif(x->>'recorrencia',''), public._data(x->>'data'),
         coalesce(public._ms(x->>'criadoEm'), now()), public._ms(x->>'feitaEm'), nullif(x->>'feitaPor','')
  from jsonb_array_elements(coalesce(d->'atividades','[]'::jsonb)) x
  where x->>'id' is not null
    and exists (select 1 from public.clientes c where c.id = x->>'clienteId')
  on conflict (id) do nothing;

  insert into public.compromissos (id, tipo, cliente_id, data, hora, local, responsavel, obs,
                                   criado_em, feito_em, feito_por)
  select x->>'id', coalesce(nullif(x->>'tipo',''), 'Compromisso'),
         case when exists (select 1 from public.clientes c where c.id = x->>'clienteId') then x->>'clienteId' end,
         public._data(x->>'data'), nullif(x->>'hora',''), nullif(x->>'local',''),
         nullif(x->>'responsavel',''), nullif(x->>'obs',''),
         coalesce(public._ms(x->>'criadoEm'), now()), public._ms(x->>'feitoEm'), nullif(x->>'feitoPor','')
  from jsonb_array_elements(coalesce(d->'compromissos','[]'::jsonb)) x
  where x->>'id' is not null
  on conflict (id) do nothing;

  insert into public.pagamentos (cliente_id, mes, pago_em)
  select split_part(p.key, ':', 1), split_part(p.key, ':', 2), coalesce(public._ms(p.value #>> '{}'), now())
  from jsonb_each(case when jsonb_typeof(d->'pagamentos') = 'object' then d->'pagamentos' else '{}'::jsonb end) p
  where split_part(p.key, ':', 2) ~ '^\d{4}-\d{2}$'
    and exists (select 1 from public.clientes c where c.id = split_part(p.key, ':', 1))
  on conflict do nothing;

  -- histórico antigo: só se a tabela nova ainda estiver vazia (evita duplicar)
  if not exists (select 1 from public.historico) then
    insert into public.historico (ts, quem, acao, detalhe)
    select coalesce(public._ms(x->>'ts'), now()), x->>'quem', coalesce(x->>'acao','—'), x->>'detalhe'
    from jsonb_array_elements(coalesce(d->'log','[]'::jsonb)) x;
  end if;

  update public.ajustes set
    equipe   = case when jsonb_typeof(d->'equipe')   = 'array' then d->'equipe'   else equipe end,
    servicos = case when jsonb_typeof(d->'servicos') = 'array' then d->'servicos' else servicos end
  where id = 'principal' and equipe = '["Você"]'::jsonb;
end $$;
