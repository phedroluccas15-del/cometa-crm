-- ============================================================
-- Cometa CRM · parte 2: produção, aprovações, materiais e monitor
--
-- Rode DEPOIS do arquivo 20261102000000_cometa_v2.sql.
-- Pode rodar mais de uma vez sem estragar nada.
--
-- O que cria:
--   postagens          cada conteúdo (post, reels, vídeo, stories) e a etapa em que está
--   materiais          o que foi pedido ao cliente (fotos, promoções, informações)
--   alertas_anuncios   problemas que o monitor achou nas contas de anúncio
--   + campos novos no cliente (contrato, serviços, briefing, metas de tráfego, link de aprovação)
--   + ajustes novos (etapas, checklist de cliente novo, regras)
-- ============================================================

-- ---------- cliente: cadastro completo ----------
alter table public.clientes add column if not exists servicos            jsonb not null default '[]'::jsonb;
alter table public.clientes add column if not exists contrato_inicio     date;
alter table public.clientes add column if not exists contrato_fim        date;
alter table public.clientes add column if not exists briefing            text;
alter table public.clientes add column if not exists acessos             text;
alter table public.clientes add column if not exists posts_mes           int;
alter table public.clientes add column if not exists resp_social         text;
alter table public.clientes add column if not exists resp_trafego        text;
alter table public.clientes add column if not exists token_aprovacao     text;
-- metas de tráfego: o monitor compara com isto, não com regra genérica
alter table public.clientes add column if not exists meta_orcamento_dia  numeric(12,2);
alter table public.clientes add column if not exists meta_cpl_max        numeric(12,2);
alter table public.clientes add column if not exists meta_resultados_dia numeric(12,2);

update public.clientes set token_aprovacao = replace(gen_random_uuid()::text, '-', '') where token_aprovacao is null;
alter table public.clientes alter column token_aprovacao set default replace(gen_random_uuid()::text, '-', '');
create unique index if not exists clientes_token_aprovacao_idx on public.clientes(token_aprovacao);

-- ---------- postagens (calendário editorial + fila de produção) ----------
create table if not exists public.postagens (
  id                    text primary key,
  cliente_id            text not null references public.clientes(id) on delete cascade,
  titulo                text not null,
  formato               text not null default 'feed',     -- feed, carrossel, reels, video, stories, arte
  etapa                 text not null default 'pauta',    -- chave da etapa (ver ajustes.etapas)
  data_publicacao       date,
  hora                  text,
  prioridade            text not null default 'normal',
  responsavel           text,                             -- social media / dono da postagem
  captador              text,
  editor                text,
  revisor               text,
  data_gravacao         date,
  roteiro               text,
  legenda               text,
  arquivo               text,                             -- link (Drive etc.) ou "storage:caminho"
  link_publicado        text,
  obs                   text,
  aprovacao             text,                             -- null, pendente, aprovado, ajustes
  aprovacao_comentario  text,
  eventos               jsonb not null default '[]'::jsonb, -- histórico de etapas e aprovações
  etapa_desde           timestamptz not null default now(),
  publicado_em          timestamptz,
  criado_em             timestamptz not null default now()
);
create index if not exists postagens_cliente_idx on public.postagens(cliente_id, data_publicacao);
create index if not exists postagens_abertas_idx on public.postagens(data_publicacao) where etapa <> 'publicado';

-- ---------- materiais pedidos ao cliente ----------
create table if not exists public.materiais (
  id               text primary key,
  cliente_id       text not null references public.clientes(id) on delete cascade,
  descricao        text not null,
  prazo            date,
  pedido_em        timestamptz not null default now(),
  recebido_em      timestamptz,
  ultimo_lembrete  timestamptz,
  lembretes        int not null default 0
);
create index if not exists materiais_pendentes_idx on public.materiais(cliente_id) where recebido_em is null;

-- ---------- alertas do monitor de anúncios ----------
create table if not exists public.alertas_anuncios (
  id             text primary key default gen_random_uuid()::text,
  cliente_id     text references public.clientes(id) on delete cascade,
  tipo           text not null,
  gravidade      text not null default 'media',          -- alta, media, baixa
  campanha       text,
  texto          text not null,
  chave          text not null unique,                   -- evita repetir o mesmo alerta no mesmo dia
  criado_em      timestamptz not null default now(),
  resolvido_em   timestamptz,
  resolvido_por  text
);
create index if not exists alertas_abertos_idx on public.alertas_anuncios(criado_em desc) where resolvido_em is null;

-- ---------- ajustes novos ----------
alter table public.ajustes add column if not exists etapas jsonb not null default '[
  {"k":"pauta","nome":"Pauta","dias":10,"quem":"responsavel"},
  {"k":"producao","nome":"Produção solicitada","dias":8,"quem":"responsavel"},
  {"k":"captacao","nome":"Captação","dias":6,"quem":"captador"},
  {"k":"edicao","nome":"Edição","dias":4,"quem":"editor"},
  {"k":"revisao","nome":"Revisão interna","dias":3,"quem":"revisor"},
  {"k":"aprovacao","nome":"Aprovação do cliente","dias":2,"quem":"cliente"},
  {"k":"agendamento","nome":"Agendamento","dias":1,"quem":"responsavel"},
  {"k":"publicado","nome":"Publicado","dias":0,"quem":"responsavel"}
]'::jsonb;
alter table public.ajustes add column if not exists checklist jsonb not null default '[
  {"titulo":"Coletar acessos (Instagram, Facebook, Gerenciador de Anúncios)","dias":0},
  {"titulo":"Reunião de briefing","dias":2},
  {"titulo":"Receber identidade visual (logo, cores, fontes)","dias":3},
  {"titulo":"Planejamento do primeiro mês","dias":5},
  {"titulo":"Montar calendário de postagens","dias":6},
  {"titulo":"Configurar campanhas de anúncio","dias":7}
]'::jsonb;
alter table public.ajustes add column if not exists config jsonb not null default
  '{"capacidade":15,"risco_dias":3,"editores":[],"bom_dia_whatsapp":true,"alerta_whatsapp":true,"lembrete_materiais_auto":false}'::jsonb;

-- ============================================================
-- PERMISSÕES
-- ============================================================
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and tablename in ('postagens','materiais','alertas_anuncios')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.postagens        enable row level security;
alter table public.materiais        enable row level security;
alter table public.alertas_anuncios enable row level security;

-- postagens: todos veem; "postagens_editar" cria e muda tudo; "postagens_mover" só anda com as etapas
create policy postagens_ler    on public.postagens for select to authenticated using (public.ativo());
create policy postagens_criar  on public.postagens for insert to authenticated with check (public.pode('postagens_editar'));
create policy postagens_mudar  on public.postagens for update to authenticated
  using (public.pode('postagens_editar') or public.pode('postagens_mover'))
  with check (public.pode('postagens_editar') or public.pode('postagens_mover'));
create policy postagens_apagar on public.postagens for delete to authenticated using (public.pode('postagens_editar'));

create or replace function public.guarda_postagem() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or public.pode('postagens_editar') then return new; end if;
  -- quem só move etapa pode mudar: etapa, histórico, arquivo e dados de publicação/aprovação
  if (new.id, new.cliente_id, new.titulo, new.formato, new.data_publicacao, new.hora, new.prioridade,
      new.responsavel, new.captador, new.editor, new.revisor, new.data_gravacao, new.roteiro, new.legenda,
      new.obs, new.criado_em)
     is distinct from
     (old.id, old.cliente_id, old.titulo, old.formato, old.data_publicacao, old.hora, old.prioridade,
      old.responsavel, old.captador, old.editor, old.revisor, old.data_gravacao, old.roteiro, old.legenda,
      old.obs, old.criado_em) then
    raise exception 'sem permissão para editar esta postagem' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guarda_postagem on public.postagens;
create trigger guarda_postagem before update on public.postagens
  for each row execute function public.guarda_postagem();

-- materiais
create policy materiais_ler    on public.materiais for select to authenticated using (public.ativo());
create policy materiais_criar  on public.materiais for insert to authenticated with check (public.pode('materiais') or public.pode('editar_clientes'));
create policy materiais_mudar  on public.materiais for update to authenticated
  using (public.pode('materiais') or public.pode('editar_clientes')) with check (public.pode('materiais') or public.pode('editar_clientes'));
create policy materiais_apagar on public.materiais for delete to authenticated using (public.pode('materiais') or public.pode('editar_clientes'));

-- alertas: quem vê anúncios lê e marca como resolvido; quem cria é o servidor (monitor)
create policy alertas_ler   on public.alertas_anuncios for select to authenticated using (public.pode('meta_ver'));
create policy alertas_mudar on public.alertas_anuncios for update to authenticated
  using (public.pode('meta_ver')) with check (public.pode('meta_ver'));

create or replace function public.guarda_alerta() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.id, new.cliente_id, new.tipo, new.gravidade, new.campanha, new.texto, new.chave, new.criado_em)
     is distinct from
     (old.id, old.cliente_id, old.tipo, old.gravidade, old.campanha, old.texto, old.chave, old.criado_em) then
    raise exception 'só dá para marcar o alerta como resolvido' using errcode = '42501';
  end if;
  if new.resolvido_em is not null then new.resolvido_por := public.meu_nome(); end if;
  return new;
end $$;
drop trigger if exists guarda_alerta on public.alertas_anuncios;
create trigger guarda_alerta before update on public.alertas_anuncios
  for each row execute function public.guarda_alerta();

-- ============================================================
-- SINCRONISMO AO VIVO
-- ============================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['postagens','materiais','alertas_anuncios'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- ARQUIVOS (vídeos e artes enviados pelo CRM) · Supabase Storage
-- Pasta privada "arquivos": só a equipe logada abre; o cliente vê pelo link de aprovação.
-- ============================================================
do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets (id, name, public) values ('arquivos', 'arquivos', false) on conflict (id) do nothing;
  execute 'drop policy if exists cometa_arquivos_ler on storage.objects';
  execute 'drop policy if exists cometa_arquivos_enviar on storage.objects';
  execute 'drop policy if exists cometa_arquivos_mudar on storage.objects';
  execute 'drop policy if exists cometa_arquivos_apagar on storage.objects';
  execute $p$create policy cometa_arquivos_ler on storage.objects for select to authenticated
           using (bucket_id = 'arquivos' and public.ativo())$p$;
  execute $p$create policy cometa_arquivos_enviar on storage.objects for insert to authenticated
           with check (bucket_id = 'arquivos' and (public.pode('postagens_editar') or public.pode('postagens_mover')))$p$;
  execute $p$create policy cometa_arquivos_mudar on storage.objects for update to authenticated
           using (bucket_id = 'arquivos' and (public.pode('postagens_editar') or public.pode('postagens_mover')))$p$;
  execute $p$create policy cometa_arquivos_apagar on storage.objects for delete to authenticated
           using (bucket_id = 'arquivos' and public.pode('postagens_editar'))$p$;
end $$;
