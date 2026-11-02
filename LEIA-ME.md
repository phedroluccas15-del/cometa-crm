# Cometa CRM — com Cometinha e Meta

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

---

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html` | o site inteiro |
| `supabase/migrations/20261102000000_cometa_v2.sql` | estrutura do banco e permissões (e migra dados do Cometa OS antigo, se existirem) |
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
   `supabase/migrations/20261102000000_cometa_v2.sql` › **Run**.
3. **Authentication › Users › Add user**: crie o primeiro acesso (marque
   *Auto Confirm User*). Depois, no SQL Editor, transforme-o em administrador:
   ```sql
   insert into perfis (id, nome, email, papel, ativo)
   select id, 'Seu Nome', email, 'admin', true from auth.users where email = 'seu@email.com';
   ```
4. **Project Settings › API**: copie a *Project URL* e a chave *anon/publishable*
   e cole no começo do `index.html` (`SUPABASE_URL` e `SUPABASE_KEY`).

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

### 3. Subir as funções
```bash
npx supabase login
npx supabase link --project-ref SEU-PROJETO
npx supabase functions deploy cometinha meta whatsapp --use-api
```

### 4. Publicar o site
GitHub › **Settings › Pages › Deploy from a branch › main / (root)**.

### 5. Equipe
Em **Equipe**, crie os acessos e marque as permissões: *Ver anúncios*,
*Pausar/ativar/mudar orçamento*, *Usar o Cometinha*. Preencha o **WhatsApp**
de quem vai falar com o Cometinha pelo celular.

---

## Meta: a chave da agência (uma vez só)

No Gerenciador de Negócios da agência (business.facebook.com):

1. **Configurações › Usuários do sistema › Adicionar** ("Cometa CRM", Administrador).
2. **Atribuir ativos**: contas de anúncio e páginas dos clientes (as que a agência
   acessa como parceira), com controle total.
3. **Gerar token** (validade: nunca expira) com: `ads_read`, `ads_management`,
   `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `business_management`.
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

## Testar sem servidor
- Sem `SUPABASE_URL`, o site roda em **modo demonstração**.
- Com Supabase configurado, `?local=1` no fim do endereço força o modo
  demonstração (não toca no banco).

## Cópia de segurança
**Ajustes › Baixar backup** gera um `.json` com tudo. **Restaurar backup** faz o
banco ficar igual ao arquivo (o que não estiver no arquivo é apagado).
