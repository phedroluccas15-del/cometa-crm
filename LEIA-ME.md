# Cometa CRM — produção, aprovações, Meta e Cometinha

CRM de agência de marketing: clientes, tarefas, agenda externa, financeiro,
anúncios da Meta e o **Cometinha**, um assistente com IA que conversa por
texto ou áudio, dentro do CRM e pelo WhatsApp, e executa tarefas no sistema.

Site estático (GitHub Pages) + Supabase (banco, login e 3 funções no servidor).
Funciona no computador e no celular, instalável como aplicativo.

> **Agora ele está em modo demonstração.** Sem Supabase configurado, tudo roda
> no próprio navegador com clientes de exemplo (fictícios). A aba de anúncios e o
> Cometinha mostram respostas de exemplo. Nada é salvo em servidor.

---

## O que tem

- **Visão geral, Minhas tarefas, Agenda, Agenda externa, Lançar, Clientes,
  Financeiro, Equipe, Histórico, Ajustes** (tudo do Cometa OS original).
- **Dados em tabelas**: cada alteração grava só o registro mexido, então duas
  pessoas salvando juntas não apagam o trabalho uma da outra. Outros aparelhos
  abertos se atualizam sozinhos.
- **Permissões no banco**, não só na tela.
- **Anúncios da Meta na ficha do cliente**: gasto, conversas/leads, custo por
  resultado, limite da conta, campanhas (pausar, ativar, mudar orçamento) e
  últimas publicações do Instagram.
- **Cometinha** (OpenAI): lista e prioriza tarefas, lança/conclui/remarca,
  marca compromissos, vê financeiro e anúncios, pausa ou muda orçamento de
  campanha (sempre pedindo confirmação antes). Respeita as permissões de cada
  pessoa. Entende áudio.
- **Cometinha no WhatsApp** pela Evolution API: só responde números da equipe.
- **Central de comando**: postagens atrasadas, para hoje, em risco, aprovações pendentes,
  vídeos na fila, anúncios com problema, semáforo dos clientes, prazos vencendo, quem deve
  material e a carga de cada pessoa. Botão **Emergência** lista tudo que publica nos próximos
  dias e ainda não está pronto.
- **Postagens em 8 etapas** (pauta → produção → captação → edição → revisão → aprovação do
  cliente → agendamento → publicado). O prazo de cada etapa conta para trás a partir da data de
  publicação; se uma etapa atrasa, as próximas são reorganizadas. Etapas, prazos e quem faz
  cada uma se mudam em **Ajustes**.
- **Publicação automática** no Instagram e no Facebook: o post em *Agendamento* com
  “Publicar sozinho” ligado sai no dia e hora marcados (imagem, carrossel, Reels/vídeo e
  Stories). Se der erro, avisa o responsável no WhatsApp e aparece na Central. Tem também o
  botão **Publicar agora**. Nunca publica o mesmo post duas vezes.
- **Calendário** de cada cliente e da agência, com previstas × publicadas.
- **Semáforo**: vermelho = passou da data e não saiu; amarelo = perto da data e não está pronta.
- **Fila de produção** (vídeos) por etapa, ordenada pela data de publicação, com
  **distribuição automática** para quem está com menos coisa.
- **Link de aprovação** exclusivo por cliente (`aprovar.html`): o cliente aprova ou pede ajuste
  sem login; aprovado vai para agendamento, ajuste volta para edição com o comentário.
- **Materiais pedidos ao cliente**, com cobrança pelo WhatsApp (manual ou automática).
- **Monitor de tráfego**: confere as contas sozinho e lista só as exceções, comparando com as
  metas de cada cliente (orçamento/dia, custo máximo, resultados/dia).
- **Relatório mensal** por cliente (postagens, entregas e Meta) em PDF.
- **Checklist de cliente novo**: ao cadastrar, as tarefas de entrada são criadas sozinhas.
- **Cadastro completo**: serviços, contrato, briefing, links, responsáveis.
- **“Bom dia” no WhatsApp** de cada pessoa com o que ela tem no dia.

---

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html` | o site inteiro |
| `config.js` | endereço e chave do Supabase (vale para o site e para a página de aprovação) |
| `aprovar.html` | página que o cliente abre para aprovar |
| `supabase/migrations/20261102000000_cometa_v2.sql` | estrutura do banco e permissões (e migra dados do Cometa OS antigo, se existirem) |
| `supabase/migrations/20261102010000_producao.sql` | postagens, materiais, alertas, campos novos do cliente |
| `supabase/functions/aprovacao` | o link de aprovação do cliente |
| `supabase/functions/rotinas` | o que roda sozinho (monitor, bom dia, materiais, publicações) |
| `supabase/functions/cometinha` | o Cometinha dentro do CRM |
| `supabase/functions/meta` | aba de anúncios (a chave da Meta fica só no servidor) |
| `supabase/functions/whatsapp` | o Cometinha no WhatsApp (Evolution) |
| `supabase/functions/_shared` | código comum (ferramentas do Cometinha, regras, Meta, áudio) |
| `testes/` | testes automáticos: `cd testes && npm install && npm test` |

---

## Ligar de verdade (passo a passo)

### 1. Supabase
1. Crie um projeto em <https://supabase.com> (região São Paulo).
2. **SQL Editor › New query** › cole todo o arquivo
   `supabase/migrations/20261102000000_cometa_v2.sql` › **Run**. Depois faça o mesmo com
   `supabase/migrations/20261102010000_producao.sql` e
   `supabase/migrations/20261103000000_publicacao.sql`, nessa ordem.
3. **Authentication › Users › Add user**: crie o primeiro acesso (marque
   *Auto Confirm User*). Depois, no SQL Editor, transforme-o em administrador:
   ```sql
   insert into perfis (id, nome, email, papel, ativo)
   select id, 'Seu Nome', email, 'admin', true from auth.users where email = 'seu@email.com';
   ```
4. **Project Settings › API**: copie a *Project URL* e a chave *anon/publishable*
   e cole no arquivo `config.js` (`SUPABASE_URL` e `SUPABASE_KEY`).

### 2. Chaves do servidor
Supabase › **Edge Functions › Secrets** (ou `npx supabase secrets set NOME=valor`):

| Nome | O que é | Precisa para |
|---|---|---|
| `OPENAI_API_KEY` | chave da OpenAI (platform.openai.com) | Cometinha e áudio |
| `OPENAI_MODEL` | modelo. Padrão `gpt-6.1-terra`. Mais barato: `gpt-6-luna` | opcional |
| `OPENAI_EFFORT` | quanto ele "pensa": `low`, `medium`, `high` (vazio = padrão do modelo) | opcional |
| `STT_MODEL` | modelo de transcrição. Padrão `gpt-transcribe` | opcional |
| `META_TOKEN` | chave do "usuário do sistema" do Gerenciador de Negócios | anúncios |
| `META_GRAPH_VERSION` | versão da API da Meta. Padrão `v25.0` | opcional |
| `EVO_URL` | endereço da Evolution, ex.: `https://evolution.seudominio.com.br` | WhatsApp |
| `EVO_KEY` | apikey da Evolution | WhatsApp |
| `EVO_INSTANCIA` | nome da instância do chip do Cometinha | WhatsApp |
| `EVO_SEGREDO` | uma senha longa que você inventa (vai no endereço do webhook) | WhatsApp |
| `ROTINAS_SEGREDO` | outra senha longa que você inventa (o agendador usa) | rotinas automáticas |

### 3. Subir as funções
```bash
npx supabase login
npx supabase link --project-ref SEU-PROJETO
npx supabase functions deploy cometinha meta whatsapp aprovacao rotinas --use-api
```

### 3b. Ligar as rotinas automáticas
**Database › Extensions**: ligue `pg_cron` e `pg_net`. Depois, no **SQL Editor**, troque
`SEU-PROJETO` e `SEU-SEGREDO` (o mesmo `ROTINAS_SEGREDO`) e rode:

```sql
-- horários em UTC (Brasília = UTC-3)
select cron.schedule('cometa-publicar', '*/5 * * * *', $$select net.http_post(
  url := 'https://SEU-PROJETO.supabase.co/functions/v1/rotinas?tarefa=publicar',
  headers := '{"x-segredo":"SEU-SEGREDO"}'::jsonb, body := '{}'::jsonb)$$);   -- a cada 5 min: publica o que chegou na hora
select cron.schedule('cometa-monitor', '0 10,14,18,22 * * *', $$select net.http_post(
  url := 'https://SEU-PROJETO.supabase.co/functions/v1/rotinas?tarefa=monitor',
  headers := '{"x-segredo":"SEU-SEGREDO"}'::jsonb, body := '{}'::jsonb)$$);   -- 7h, 11h, 15h, 19h
select cron.schedule('cometa-bom-dia', '0 11 * * 1-6', $$select net.http_post(
  url := 'https://SEU-PROJETO.supabase.co/functions/v1/rotinas?tarefa=bom_dia',
  headers := '{"x-segredo":"SEU-SEGREDO"}'::jsonb, body := '{}'::jsonb)$$);   -- 8h, seg a sáb
select cron.schedule('cometa-publicacoes', '30 * * * *', $$select net.http_post(
  url := 'https://SEU-PROJETO.supabase.co/functions/v1/rotinas?tarefa=publicacoes',
  headers := '{"x-segredo":"SEU-SEGREDO"}'::jsonb, body := '{}'::jsonb)$$);   -- de hora em hora
select cron.schedule('cometa-materiais', '0 13 * * 1-5', $$select net.http_post(
  url := 'https://SEU-PROJETO.supabase.co/functions/v1/rotinas?tarefa=materiais',
  headers := '{"x-segredo":"SEU-SEGREDO"}'::jsonb, body := '{}'::jsonb)$$);   -- 10h, seg a sex
```

O lembrete de materiais só manda mensagem ao cliente se estiver ligado em **Ajustes**.
O “bom dia” e o aviso de anúncios usam o chip do Cometinha (Evolution).

### 4. Publicar o site
GitHub › **Settings › Pages › Deploy from a branch › main / (root)**.

### 5. Equipe
Em **Equipe**, crie os acessos e marque as permissões: *Ver anúncios*,
*Pausar/ativar/mudar orçamento*, *Usar o Cometinha*, *Criar e editar postagens*,
*Avançar etapas* (para quem grava/edita), *Pedir e marcar materiais*. Preencha o **WhatsApp**
de quem vai falar com o Cometinha pelo celular.

---

## Meta: a chave da agência (uma vez só)

No Gerenciador de Negócios da agência (business.facebook.com):

1. **Configurações › Usuários do sistema › Adicionar** ("Cometa CRM", Administrador).
2. **Atribuir ativos**: contas de anúncio e páginas dos clientes (as que a agência
   acessa como parceira), com controle total.
3. **Gerar token** (validade: nunca expira) com: `ads_read`, `ads_management`,
   `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `business_management`
   e, para **publicar sozinho**: `pages_manage_posts` e `instagram_content_publish`.
   Ao atribuir as páginas ao usuário do sistema, marque a permissão de **criar conteúdo**.
4. Coloque em `META_TOKEN`.

Depois, em cada cliente: **ficha › Anúncios · Meta › Ligar conta da Meta**.

---

## WhatsApp do Cometinha (Evolution API)

1. Um **chip só para o Cometinha**, conectado numa instância da Evolution
   (v2) que fique ligada 24 h e acessível pela internet.
2. Na Evolution, configure o **webhook da instância**:
   - URL: `https://SEU-PROJETO.supabase.co/functions/v1/whatsapp?segredo=EVO_SEGREDO`
   - Evento: **MESSAGES_UPSERT**
   - (opcional) "Webhook base64" ligado: o áudio já chega junto e fica mais rápido.
3. Preencha `EVO_URL`, `EVO_KEY`, `EVO_INSTANCIA` e `EVO_SEGREDO`.

Só respondem os números cadastrados em **Equipe** com a permissão do Cometinha.
Mensagem de outro número, de grupo ou do próprio chip é ignorada.
Mandar `/nova` começa uma conversa do zero.

---

## Publicação automática: o que saber
- O arquivo precisa ser **enviado pelo CRM** (botão “enviar arquivos”) ou ser um link direto
  de imagem/vídeo (`.jpg`, `.mp4`). Link do Drive/WeTransfer serve para o cliente aprovar,
  mas a Meta não consegue baixar dele para publicar.
- Imagem em PNG é convertida para JPEG sozinha (o Instagram só aceita JPEG).
- No plano grátis do Supabase cada arquivo pode ter até **50 MB**. Vídeo maior: plano Pro
  (Storage › Settings › limite por arquivo) ou um link direto de outro lugar.
- Carrossel: de 2 a 10 arquivos, na ordem da lista. Stories: só Instagram.
- Reels/vídeo: a Meta processa o arquivo; o post sai em alguns minutos depois do horário.
- O Instagram limita a 50 publicações por dia por conta (pela API).

## Testar sem servidor
- Sem `SUPABASE_URL`, o site roda em **modo demonstração**.
- Com Supabase configurado, `?local=1` no fim do endereço força o modo
  demonstração (não toca no banco).
- No modo demonstração a publicação automática é **simulada** (não posta de verdade).
- Testes: `cd testes && npm install && npm test`. Roteiro de uso do dia a dia num
  navegador, com as permissões de verdade: `NUVEM=1 npm run dia`.

## Cópia de segurança
**Ajustes › Baixar backup** gera um `.json` com tudo. **Restaurar backup** faz o
banco ficar igual ao arquivo (o que não estiver no arquivo é apagado).
