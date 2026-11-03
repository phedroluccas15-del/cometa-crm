-- ============================================================
-- Cometa CRM · parte 3: publicação automática no Instagram e Facebook
-- Rode DEPOIS dos outros dois arquivos. Pode rodar mais de uma vez.
--
-- O post em "Agendamento" com "publicar sozinho" ligado é publicado
-- pelo servidor no dia e hora marcados (rotina "publicar", a cada 5 min).
-- ============================================================

alter table public.postagens add column if not exists publicar_auto  boolean not null default false;
alter table public.postagens add column if not exists destinos       jsonb   not null default '["instagram"]'::jsonb;
alter table public.postagens add column if not exists midias         jsonb   not null default '[]'::jsonb;  -- arquivos na ordem (carrossel)
-- controlados pelo servidor (o site só lê; para "tentar de novo" ele zera pub_status/pub_erro)
alter table public.postagens add column if not exists pub_status     text;      -- null, processando, publicando, erro, publicado
alter table public.postagens add column if not exists pub_erro       text;
alter table public.postagens add column if not exists pub_container  jsonb not null default '{}'::jsonb;
alter table public.postagens add column if not exists pub_tentativas int   not null default 0;
alter table public.postagens add column if not exists pub_desde      timestamptz;

create index if not exists postagens_publicar_idx on public.postagens(data_publicacao)
  where etapa = 'agendamento' and publicar_auto;

-- quem só move etapa não liga/desliga a publicação automática nem muda os destinos
create or replace function public.guarda_postagem() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or public.pode('postagens_editar') then return new; end if;
  if (new.id, new.cliente_id, new.titulo, new.formato, new.data_publicacao, new.hora, new.prioridade,
      new.responsavel, new.captador, new.editor, new.revisor, new.data_gravacao, new.roteiro, new.legenda,
      new.obs, new.criado_em, new.publicar_auto, new.destinos)
     is distinct from
     (old.id, old.cliente_id, old.titulo, old.formato, old.data_publicacao, old.hora, old.prioridade,
      old.responsavel, old.captador, old.editor, old.revisor, old.data_gravacao, old.roteiro, old.legenda,
      old.obs, old.criado_em, old.publicar_auto, old.destinos) then
    raise exception 'sem permissão para editar esta postagem' using errcode = '42501';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------
-- Correção: o site guarda horários com precisão de milésimos e o banco
-- de microssegundos. Ao comparar "o que mudou", o criado_em parecia
-- diferente e quem só pode concluir/avançar levava "sem permissão".
-- Agora a comparação ignora essa diferença.
-- ------------------------------------------------------------
create or replace function public.guarda_atividade() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or public.pode('lancar') then return new; end if;
  if (new.id, new.cliente_id, new.titulo, new.obs, new.prioridade, new.responsavel,
      new.recorrencia, new.data, date_trunc('milliseconds', new.criado_em))
     is distinct from
     (old.id, old.cliente_id, old.titulo, old.obs, old.prioridade, old.responsavel,
      old.recorrencia, old.data, date_trunc('milliseconds', old.criado_em)) then
    raise exception 'sem permissão para editar esta atividade' using errcode = '42501';
  end if;
  new.criado_em := old.criado_em;
  return new;
end $$;

create or replace function public.guarda_compromisso() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or public.pode('criar_compromisso') then return new; end if;
  if (new.id, new.tipo, new.cliente_id, new.data, new.hora, new.local, new.responsavel, new.obs, date_trunc('milliseconds', new.criado_em))
     is distinct from
     (old.id, old.tipo, old.cliente_id, old.data, old.hora, old.local, old.responsavel, old.obs, date_trunc('milliseconds', old.criado_em)) then
    raise exception 'sem permissão para editar este compromisso' using errcode = '42501';
  end if;
  new.criado_em := old.criado_em;
  return new;
end $$;

create or replace function public.guarda_postagem() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or public.pode('postagens_editar') then return new; end if;
  if (new.id, new.cliente_id, new.titulo, new.formato, new.data_publicacao, new.hora, new.prioridade,
      new.responsavel, new.captador, new.editor, new.revisor, new.data_gravacao, new.roteiro, new.legenda,
      new.obs, date_trunc('milliseconds', new.criado_em), new.publicar_auto, new.destinos)
     is distinct from
     (old.id, old.cliente_id, old.titulo, old.formato, old.data_publicacao, old.hora, old.prioridade,
      old.responsavel, old.captador, old.editor, old.revisor, old.data_gravacao, old.roteiro, old.legenda,
      old.obs, date_trunc('milliseconds', old.criado_em), old.publicar_auto, old.destinos) then
    raise exception 'sem permissão para editar esta postagem' using errcode = '42501';
  end if;
  new.criado_em := old.criado_em;
  return new;
end $$;
