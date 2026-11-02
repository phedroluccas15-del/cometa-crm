// O que o Cometinha consegue fazer dentro do CRM.
// Cada ferramenta confere a permissão de quem está falando, igual à tela.

import {
  acharPorNome, carregarPerfil, dataBR, diaDaSemana, diasEntre, ehDataISO, hojeSP, normalizar, novoId,
  NOME_RECORRENCIA, pode, RECORRENCIA, somaDias, type Consulta, type Perfil,
} from './regras.ts';
import * as meta from './meta.ts';
import {
  donoAtual, EH_VIDEO, etapasValidas, FORMATOS, indiceEtapa, prazosEtapas, semaforo, situacao, type Etapa, type Postagem,
} from './producao.ts';
import { COLS_POST } from './rotinas.ts';

export type Ctx = {
  q: Consulta;
  perfil: Perfil;
  agora: Date;
  meta?: { tokenPadrao?: string; versao?: string; fetch?: typeof fetch };
  /** alterações de campanha que a pessoa já confirmou nesta conversa */
  confirmaveis?: Set<string>;
};

type Resultado = Record<string, unknown>;
class Recusa extends Error {}
const recusa = (m: string) => { throw new Recusa(m); };
const exigir = (ctx: Ctx, k: string, oQue: string) => {
  if (!pode(ctx.perfil, k)) recusa(`${ctx.perfil.nome} não tem permissão para ${oQue}. Peça para um administrador liberar em Equipe.`);
};

// ============================================================
// Definições (o que o modelo vê). A ordem fica fixa para o cache funcionar.
// ============================================================
const QUANDO_TAREFA = ['atrasadas', 'hoje', 'amanha', 'semana', 'abertas', 'sem_data', 'concluidas_7d'];
const PERIODO_META = Object.keys(meta.PERIODOS);
const TIPOS_COMP = ['Captação', 'Reunião', 'Visita', 'Gravação', 'Entrega'];

export const FERRAMENTAS = [
  {
    name: 'panorama',
    description: 'Resumo da agência agora: o que está atrasado, o que vence hoje e amanhã, carga de cada pessoa, ' +
      'semáforo dos clientes (vermelho = postagem que passou da data e não saiu ou tarefa atrasada, amarelo = postagem em risco, verde = em dia), ' +
      'números das postagens (atrasadas, em risco, aprovações pendentes, vídeos na edição) e compromissos de hoje e amanhã. ' +
      'Use para "como estamos?", "o que tem pra hoje?", "quem está atrasado?".',
    type: 'function', parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'listar_tarefas',
    description: 'Lista atividades (tarefas) do CRM com filtros. Devolve o id de cada uma, necessário para concluir ou editar. ' +
      'responsavel aceita "eu" para quem está falando.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        quando: { type: 'string', enum: QUANDO_TAREFA, description: 'semana = de hoje até 7 dias; abertas = tudo que não foi feito' },
        responsavel: { type: 'string', description: 'nome da pessoa da equipe, ou "eu"' },
        cliente: { type: 'string', description: 'nome do cliente (pode ser aproximado)' },
      },
      required: ['quando'],
      additionalProperties: false,
    },
  },
  {
    name: 'criar_tarefa',
    description: 'Lança uma atividade nova para um cliente. Datas sempre em AAAA-MM-DD (calcule a partir da data de hoje informada).',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        titulo: { type: 'string', description: 'o serviço, ex.: "Postagem", "Captação", "Stories da promoção"' },
        data: { type: 'string', description: 'AAAA-MM-DD; omita se não tiver data' },
        responsavel: { type: 'string', description: 'nome da pessoa ou "eu"' },
        prioridade: { type: 'string', enum: ['normal', 'alta'] },
        repetir: { type: 'string', enum: Object.keys(RECORRENCIA) },
        obs: { type: 'string' },
      },
      required: ['cliente', 'titulo'],
      additionalProperties: false,
    },
  },
  {
    name: 'concluir_tarefa',
    description: 'Dá OK (conclui) uma atividade pelo id. Se ela se repete, a próxima é criada sozinha.',
    type: 'function', parameters: {
      type: 'object', properties: { tarefa_id: { type: 'string' } }, required: ['tarefa_id'], additionalProperties: false,
    },
  },
  {
    name: 'editar_tarefa',
    description: 'Muda título, data, responsável, prioridade ou observação de uma atividade pelo id. Mande só o que muda. ' +
      'data = "" tira a data.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        tarefa_id: { type: 'string' },
        titulo: { type: 'string' },
        data: { type: 'string' },
        responsavel: { type: 'string' },
        prioridade: { type: 'string', enum: ['normal', 'alta'] },
        obs: { type: 'string' },
      },
      required: ['tarefa_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'reabrir_tarefa',
    description: 'Desfaz o OK de uma atividade concluída por engano.',
    type: 'function', parameters: {
      type: 'object', properties: { tarefa_id: { type: 'string' } }, required: ['tarefa_id'], additionalProperties: false,
    },
  },
  {
    name: 'listar_compromissos',
    description: 'Agenda externa: captações, reuniões, visitas, gravações e entregas com horário e local.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        quando: { type: 'string', enum: ['hoje', 'amanha', 'semana', 'atrasados', 'abertos'] },
        responsavel: { type: 'string' },
      },
      required: ['quando'],
      additionalProperties: false,
    },
  },
  {
    name: 'marcar_compromisso',
    description: 'Marca um compromisso na agenda externa.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: TIPOS_COMP },
        data: { type: 'string', description: 'AAAA-MM-DD' },
        hora: { type: 'string', description: 'HH:MM' },
        cliente: { type: 'string' },
        local: { type: 'string' },
        responsavel: { type: 'string' },
        obs: { type: 'string' },
      },
      required: ['tipo', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'concluir_compromisso',
    description: 'Marca um compromisso da agenda externa como feito, pelo id.',
    type: 'function', parameters: {
      type: 'object', properties: { compromisso_id: { type: 'string' } }, required: ['compromisso_id'], additionalProperties: false,
    },
  },
  {
    name: 'ver_cliente',
    description: 'Ficha de um cliente: contato, situação, pendências, entregas do mês, mensalidade (se a pessoa pode ver) e se tem conta de anúncio ligada.',
    type: 'function', parameters: {
      type: 'object', properties: { cliente: { type: 'string' } }, required: ['cliente'], additionalProperties: false,
    },
  },
  {
    name: 'financeiro',
    description: 'Mensalidades do mês: previsto, recebido, quem está em atraso e quanto falta entrar.',
    type: 'function', parameters: {
      type: 'object',
      properties: { mes: { type: 'string', description: 'AAAA-MM; omita para o mês atual' } },
      additionalProperties: false,
    },
  },
  {
    name: 'marcar_pagamento',
    description: 'Marca (ou desmarca) a mensalidade de um cliente como recebida no mês.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        mes: { type: 'string', description: 'AAAA-MM; omita para o mês atual' },
        recebido: { type: 'boolean', description: 'false desfaz' },
      },
      required: ['cliente', 'recebido'],
      additionalProperties: false,
    },
  },
  {
    name: 'anuncios_cliente',
    description: 'Meta Ads de um cliente: gasto no período, conversas/leads, custo por resultado, limite e saldo da conta, ' +
      'campanhas (com id, situação e orçamento) e alertas (campanha sem entrega, gastando sem resultado, limite acabando).',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        periodo: { type: 'string', enum: PERIODO_META },
      },
      required: ['cliente'],
      additionalProperties: false,
    },
  },
  {
    name: 'publicacoes_cliente',
    description: 'Últimas publicações do Instagram (ou Facebook) do cliente, com data, legenda, curtidas e comentários.',
    type: 'function', parameters: {
      type: 'object', properties: { cliente: { type: 'string' } }, required: ['cliente'], additionalProperties: false,
    },
  },
  {
    name: 'alterar_campanha',
    description: 'Pausa, ativa, muda o orçamento diário (em reais) ou renomeia uma campanha/conjunto da Meta de um cliente. ' +
      'SEMPRE chame primeiro com confirmado=false: o sistema devolve o resumo. Leia o resumo para a pessoa e só chame de novo com ' +
      'confirmado=true depois que ela responder que sim, numa mensagem nova.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        campanha_id: { type: 'string', description: 'id da campanha ou do conjunto (veio de anuncios_cliente)' },
        acao: { type: 'string', enum: ['pausar', 'ativar', 'orcamento_diario', 'renomear'] },
        valor: { type: 'string', description: 'orcamento_diario: valor em reais, ex. "35"; renomear: o novo nome' },
        confirmado: { type: 'boolean' },
      },
      required: ['cliente', 'campanha_id', 'acao', 'confirmado'],
      additionalProperties: false,
    },
  },
  {
    name: 'listar_postagens',
    description: 'Calendário editorial e fila de produção: postagens/vídeos com etapa atual (pauta, produção, captação, edição, revisão, ' +
      'aprovação do cliente, agendamento, publicado), data de publicação, quem precisa agir e situação (atrasada, em risco, ok). ' +
      'Use para "o que tem pra postar", "o que está atrasado", "fila de edição", "o que está esperando aprovação".',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        filtro: { type: 'string', enum: ['atrasadas', 'em_risco', 'hoje', 'semana', 'aguardando_aprovacao', 'fila_edicao', 'abertas', 'publicadas_mes'] },
        cliente: { type: 'string' },
        responsavel: { type: 'string', description: 'quem precisa agir agora; "eu" para quem está falando' },
      },
      required: ['filtro'],
      additionalProperties: false,
    },
  },
  {
    name: 'criar_postagem',
    description: 'Coloca uma postagem/vídeo no calendário de um cliente. Datas em AAAA-MM-DD.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        titulo: { type: 'string', description: 'tema do conteúdo' },
        formato: { type: 'string', enum: Object.keys(FORMATOS) },
        data_publicacao: { type: 'string' },
        hora: { type: 'string', description: 'HH:MM' },
        responsavel: { type: 'string' }, captador: { type: 'string' }, editor: { type: 'string' },
        roteiro: { type: 'string' }, legenda: { type: 'string' },
        prioridade: { type: 'string', enum: ['normal', 'alta'] },
      },
      required: ['cliente', 'titulo', 'formato'],
      additionalProperties: false,
    },
  },
  {
    name: 'mover_postagem',
    description: 'Muda a etapa de uma postagem pelo id (ex.: captação feita → edição). etapa = "proxima" avança uma. ' +
      'Para publicado, mande o link se tiver.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        postagem_id: { type: 'string' },
        etapa: { type: 'string', description: '"proxima" ou a chave da etapa (pauta, producao, captacao, edicao, revisao, aprovacao, agendamento, publicado)' },
        link: { type: 'string' },
        comentario: { type: 'string' },
      },
      required: ['postagem_id', 'etapa'],
      additionalProperties: false,
    },
  },
  {
    name: 'alertas_anuncios',
    description: 'Exceções encontradas pelo monitor de anúncios (campanha sem entrega, gastando sem resultado, custo acima da meta, ' +
      'queda de resultados, orçamento estourado, conta sem acompanhamento) ainda não resolvidas.',
    type: 'function', parameters: {
      type: 'object', properties: { cliente: { type: 'string' } }, additionalProperties: false,
    },
  },
  {
    name: 'materiais',
    description: 'Materiais pedidos aos clientes (fotos, informações, promoções): lista os pendentes, pede um novo ou marca como recebido.',
    type: 'function', parameters: {
      type: 'object',
      properties: {
        acao: { type: 'string', enum: ['listar', 'pedir', 'recebido'] },
        cliente: { type: 'string' },
        descricao: { type: 'string', description: 'pedir: o que foi pedido' },
        prazo: { type: 'string', description: 'pedir: AAAA-MM-DD' },
        material_id: { type: 'string', description: 'recebido: id que veio da lista' },
      },
      required: ['acao'],
      additionalProperties: false,
    },
  },
  {
    name: 'equipe',
    description: 'Nomes das pessoas da equipe (para saber a quem atribuir uma tarefa).',
    type: 'function', parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ============================================================
// Apoio
// ============================================================
type Cliente = {
  id: string; nome: string; status: string; contato: string | null; mensalidade: string | null; dia_venc: number | null;
  meta_conta_id: string | null; meta_conta_nome: string | null; meta_pagina_id: string | null; meta_pagina_nome: string | null;
};

async function clientes(ctx: Ctx): Promise<Cliente[]> {
  return ctx.q(`select id, nome, status, contato, mensalidade::text, dia_venc, meta_conta_id, meta_conta_nome,
                       meta_pagina_id, meta_pagina_nome from public.clientes order by nome`);
}

async function umCliente(ctx: Ctx, nome: string): Promise<Cliente> {
  const todos = await clientes(ctx);
  const achados = acharPorNome(todos, nome);
  if (achados.length === 1) return achados[0];
  if (!achados.length) recusa(`Não achei cliente parecido com "${nome}". Clientes: ${todos.map(c => c.nome).join(', ')}.`);
  recusa(`"${nome}" pode ser mais de um cliente: ${achados.map(c => c.nome).join(', ')}. Pergunte qual.`);
  throw 0;
}

async function nomesEquipe(ctx: Ctx): Promise<string[]> {
  const [aj] = await ctx.q(`select equipe from public.ajustes where id = 'principal'`);
  const perf = await ctx.q(`select nome from public.perfis where ativo and nome <> ''`);
  const lista = [...(aj?.equipe || []), ...perf.map((p: any) => p.nome)].filter(Boolean);
  return [...new Set(lista.map(String))];
}

async function umaPessoa(ctx: Ctx, nome?: string): Promise<string | null> {
  if (!nome) return null;
  const n = normalizar(nome);
  if (['eu', 'mim', 'eu mesmo', 'eu mesma', 'comigo'].includes(n)) return ctx.perfil.nome;
  const equipe = await nomesEquipe(ctx);
  const achados = acharPorNome(equipe.map(e => ({ id: e, nome: e })), nome);
  if (achados.length === 1) return achados[0].nome;
  if (!achados.length) recusa(`Não tem "${nome}" na equipe. Equipe: ${equipe.join(', ')}.`);
  recusa(`"${nome}" pode ser: ${achados.map(a => a.nome).join(', ')}. Pergunte quem.`);
  return null;
}

async function registrar(ctx: Ctx, acao: string, detalhe: string) {
  await ctx.q(`insert into public.historico (quem, acao, detalhe) values ($1, $2, $3)`,
    [ctx.perfil.nome + ' (Cometinha)', acao, detalhe]);
}

const fmtData = (iso: string | null, hoje: string) => {
  if (!iso) return 'sem data';
  const d = diasEntre(hoje, iso);
  if (d === 0) return 'hoje';
  if (d === 1) return 'amanhã';
  if (d === -1) return 'ontem (1 dia atrasada)';
  if (d < 0) return `${dataBR(iso)} (${-d} dias atrasada)`;
  return `${diaDaSemana(iso)} ${dataBR(iso).slice(0, 5)}`;
};

const linhaTarefa = (a: any, hoje: string) => ({
  id: a.id, cliente: a.cliente, titulo: a.titulo, quando: fmtData(a.data, hoje),
  responsavel: a.responsavel || 'ninguém', ...(a.prioridade === 'alta' ? { prioridade: 'alta' } : {}),
  ...(a.recorrencia ? { repete: NOME_RECORRENCIA[a.recorrencia] || 'sim' } : {}),
  ...(a.obs ? { obs: a.obs } : {}),
});

const SQL_TAREFAS = `select a.id, a.titulo, a.data::text, a.responsavel, a.prioridade, a.recorrencia, a.obs,
       a.feita_em, a.feita_por, c.nome as cliente, c.id as cliente_id
  from public.atividades a join public.clientes c on c.id = a.cliente_id`;

const mesDe = (hoje: string) => hoje.slice(0, 7);
const reais = (v: unknown) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function cfgMeta(ctx: Ctx, token: string) {
  return { token, versao: ctx.meta?.versao, fetch: ctx.meta?.fetch };
}

/** chave do cliente (exceção) ou a chave da Cometa (padrão) */
export async function tokenMeta(ctx: Ctx, clienteId: string): Promise<string> {
  let r: any[] = [];
  try { r = await ctx.q(`select token from privado.meta_tokens where cliente_id = $1`, [clienteId]); } catch { /* sem cofre */ }
  const t = r[0]?.token || ctx.meta?.tokenPadrao;
  if (!t) recusa('A integração com a Meta ainda não foi ligada (falta a chave da Cometa no servidor).');
  return t!;
}

function exigirConta(c: Cliente) {
  if (!c.meta_conta_id) recusa(`${c.nome} ainda não tem conta de anúncio ligada. Ligue na ficha do cliente, na parte "Anúncios".`);
}


// ---------- postagens ----------
async function etapasDe(ctx: Ctx): Promise<{ E: Etapa[]; risco: number }> {
  const [a] = await ctx.q(`select etapas, config from public.ajustes where id = 'principal'`);
  return { E: etapasValidas(a?.etapas), risco: Number(a?.config?.risco_dias) || 3 };
}
const SQL_POSTS = `select ${COLS_POST}, p.link_publicado, p.publicado_em, p.eventos, c.nome as cliente
  from public.postagens p join public.clientes c on c.id = p.cliente_id`;

function linhaPost(p: any, E: Etapa[], hoje: string, risco: number) {
  const e = E[indiceEtapa(E, p.etapa)];
  const dono = donoAtual(p, E);
  const prazo = prazosEtapas(p, E, hoje).prazos[p.etapa];
  return {
    id: p.id, cliente: p.cliente, titulo: p.titulo, formato: FORMATOS[p.formato] || p.formato,
    etapa: e?.nome || p.etapa, publica: fmtData(p.data_publicacao, hoje).replace('atrasada', 'atrasado') + (p.hora ? ' ' + p.hora : ''),
    situacao: situacao(p, E, hoje, risco), ...(dono ? { com: dono === 'cliente' ? 'esperando o cliente aprovar' : dono } : {}),
    ...(prazo && p.etapa !== 'publicado' ? { prazo_da_etapa: fmtData(prazo, hoje) } : {}),
    ...(p.prioridade === 'alta' ? { prioridade: 'alta' } : {}),
  };
}

// ============================================================
// Execução
// ============================================================
const ACOES: Record<string, (ctx: Ctx, e: any) => Promise<Resultado>> = {

  async panorama(ctx) {
    const hoje = hojeSP(ctx.agora);
    const tudo = pode(ctx.perfil, 'ver_geral') || pode(ctx.perfil, 'ver_agenda');
    const abertas = await ctx.q(SQL_TAREFAS + ` where a.feita_em is null order by a.data nulls last`);
    const minhas = (a: any) => tudo || a.responsavel === ctx.perfil.nome;
    const vis = abertas.filter(minhas);
    const atras = vis.filter(a => a.data && a.data < hoje);
    const deHoje = vis.filter(a => a.data === hoje);
    const amanha = vis.filter(a => a.data === somaDias(hoje, 1));

    const porPessoa: Record<string, { abertas: number; atrasadas: number }> = {};
    for (const a of vis) {
      const p = a.responsavel || 'sem responsável';
      porPessoa[p] ??= { abertas: 0, atrasadas: 0 };
      porPessoa[p].abertas++;
      if (a.data && a.data < hoje) porPessoa[p].atrasadas++;
    }

    const ativos = (await clientes(ctx)).filter(c => c.status !== 'pausado');
    const sem = { vermelho: [] as string[], amarelo: [] as string[], verde: [] as string[] };
    let postagens: Resultado = {};
    if (tudo) {
      const { E, risco } = await etapasDe(ctx);
      const posts: Postagem[] = await ctx.q(SQL_POSTS + ` where p.etapa <> 'publicado'`);
      for (const c of ativos) {
        const cor = semaforo(posts.filter(p => p.cliente_id === c.id), E, hoje, risco);
        // tarefa atrasada também deixa o cliente vermelho
        const atrasoTarefa = abertas.some(a => a.cliente_id === c.id && a.data && a.data < hoje);
        sem[atrasoTarefa ? 'vermelho' : cor].push(c.nome);
      }
      const s = (k: string) => posts.filter(p => situacao(p, E, hoje, risco) === k).length;
      postagens = { atrasadas: s('atrasada'), em_risco: s('risco'), publicar_hoje: posts.filter(p => p.data_publicacao === hoje).length,
        aguardando_aprovacao: posts.filter(p => p.etapa === 'aprovacao').length,
        videos_na_edicao: posts.filter(p => EH_VIDEO(p.formato) && p.etapa === 'edicao').length };
    }
    const comp = await ctx.q(`select k.id, k.tipo, k.data::text, k.hora, k.local, k.responsavel, c.nome as cliente
        from public.compromissos k left join public.clientes c on c.id = k.cliente_id
       where k.feito_em is null and k.data <= $1 order by k.data, k.hora nulls last`, [somaDias(hoje, 1)]);
    const [entregues] = await ctx.q(`select count(*)::int as n from public.atividades
       where feita_em > now() - interval '7 days'`);

    return {
      hoje: `${diaDaSemana(hoje)}, ${dataBR(hoje)}`,
      visao: tudo ? 'agência inteira' : `só as tarefas de ${ctx.perfil.nome}`,
      em_aberto: vis.length,
      atrasadas: { total: atras.length, itens: atras.slice(0, 15).map(a => linhaTarefa(a, hoje)) },
      hoje_vence: { total: deHoje.length, itens: deHoje.slice(0, 15).map(a => linhaTarefa(a, hoje)) },
      amanha_vence: { total: amanha.length, itens: amanha.slice(0, 10).map(a => linhaTarefa(a, hoje)) },
      por_pessoa: porPessoa,
      ...(tudo ? { semaforo_clientes: sem, postagens, entregues_7_dias: entregues?.n ?? 0 } : {}),
      compromissos_hoje_amanha: comp.filter((k: any) => tudo || k.responsavel === ctx.perfil.nome).map((k: any) => ({
        id: k.id, tipo: k.tipo, cliente: k.cliente, quando: fmtData(k.data, hoje), hora: k.hora, local: k.local, responsavel: k.responsavel,
      })),
    };
  },

  async listar_tarefas(ctx, e) {
    const hoje = hojeSP(ctx.agora);
    if (!QUANDO_TAREFA.includes(e.quando)) recusa('Período inválido.');
    let resp = await umaPessoa(ctx, e.responsavel);
    if (!pode(ctx.perfil, 'ver_agenda') && !pode(ctx.perfil, 'ver_geral')) {
      if (resp && resp !== ctx.perfil.nome) recusa(`${ctx.perfil.nome} só pode ver as próprias tarefas.`);
      resp = ctx.perfil.nome;
    }
    const cli = e.cliente ? await umCliente(ctx, e.cliente) : null;
    const filtros: string[] = [], p: unknown[] = [];
    const add = (sql: string, v?: unknown) => { if (v !== undefined) p.push(v); filtros.push(sql.replace('?', '$' + p.length)); };
    if (e.quando === 'concluidas_7d') add(`a.feita_em > now() - interval '7 days'`);
    else add('a.feita_em is null');
    if (e.quando === 'atrasadas') add('a.data < ?', hoje);
    if (e.quando === 'hoje') add('a.data = ?', hoje);
    if (e.quando === 'amanha') add('a.data = ?', somaDias(hoje, 1));
    if (e.quando === 'semana') add('a.data <= ?', somaDias(hoje, 7));
    if (e.quando === 'sem_data') add('a.data is null');
    if (resp) add('a.responsavel = ?', resp);
    if (cli) add('a.cliente_id = ?', cli.id);
    const ordem = e.quando === 'concluidas_7d' ? 'a.feita_em desc' : 'a.data nulls last, c.nome';
    const r = await ctx.q(`${SQL_TAREFAS} where ${filtros.join(' and ')} order by ${ordem} limit 41`, p);
    return {
      filtro: { quando: e.quando, responsavel: resp || 'todos', cliente: cli?.nome || 'todos' },
      total: r.length > 40 ? 'mais de 40 (mostrando 40)' : r.length,
      tarefas: r.slice(0, 40).map(a => e.quando === 'concluidas_7d'
        ? { id: a.id, cliente: a.cliente, titulo: a.titulo, feita_por: a.feita_por, feita_em: new Date(a.feita_em).toISOString().slice(0, 10) }
        : linhaTarefa(a, hoje)),
    };
  },

  async criar_tarefa(ctx, e) {
    exigir(ctx, 'lancar', 'lançar atividades');
    const cli = await umCliente(ctx, e.cliente);
    const titulo = String(e.titulo || '').trim();
    if (!titulo) recusa('Falta dizer qual é a atividade.');
    if (e.data && !ehDataISO(e.data)) recusa('Data inválida, use AAAA-MM-DD.');
    const resp = await umaPessoa(ctx, e.responsavel);
    const rec = e.repetir ? RECORRENCIA[e.repetir] : null;
    if (e.repetir && rec === undefined) recusa('Repetição inválida.');
    const id = novoId();
    await ctx.q(`insert into public.atividades (id, cliente_id, titulo, obs, prioridade, responsavel, recorrencia, data)
                 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, cli.id, titulo, e.obs || null, e.prioridade === 'alta' ? 'alta' : 'normal', resp, rec, e.data || null]);
    await registrar(ctx, 'Lançou atividades', `${cli.nome} — ${titulo}`);
    return {
      feito: true, id, cliente: cli.nome, titulo, quando: fmtData(e.data || null, hojeSP(ctx.agora)),
      responsavel: resp || 'ninguém', ...(rec ? { repete: NOME_RECORRENCIA[rec] } : {}),
    };
  },

  async concluir_tarefa(ctx, e) {
    exigir(ctx, 'concluir', 'dar OK em atividades');
    const [a] = await ctx.q(SQL_TAREFAS + ' where a.id = $1', [e.tarefa_id]);
    if (!a) recusa('Não achei essa tarefa (o id pode estar errado). Liste as tarefas de novo.');
    if (a.feita_em) return { feito: false, motivo: `"${a.titulo}" de ${a.cliente} já estava concluída.` };
    await ctx.q(`update public.atividades set feita_em = now(), feita_por = $2 where id = $1`, [a.id, ctx.perfil.nome]);
    let proxima: string | null = null;
    if (a.recorrencia) {
      proxima = somaDias(a.data || hojeSP(ctx.agora), Number(a.recorrencia));
      await ctx.q(`insert into public.atividades (id, cliente_id, titulo, obs, prioridade, responsavel, recorrencia, data)
                   select $2, cliente_id, titulo, obs, prioridade, responsavel, recorrencia, $3 from public.atividades where id = $1`,
        [a.id, novoId(), proxima]);
    }
    await registrar(ctx, 'Concluiu atividade', `${a.cliente} — ${a.titulo}`);
    return { feito: true, cliente: a.cliente, titulo: a.titulo, ...(proxima ? { proxima: fmtData(proxima, hojeSP(ctx.agora)) } : {}) };
  },

  async editar_tarefa(ctx, e) {
    exigir(ctx, 'lancar', 'editar atividades');
    const [a] = await ctx.q(SQL_TAREFAS + ' where a.id = $1', [e.tarefa_id]);
    if (!a) recusa('Não achei essa tarefa.');
    const sets: string[] = [], p: unknown[] = [a.id];
    const set = (col: string, v: unknown) => { p.push(v); sets.push(`${col} = $${p.length}`); };
    if (e.titulo !== undefined) { if (!String(e.titulo).trim()) recusa('Título vazio.'); set('titulo', String(e.titulo).trim()); }
    if (e.data !== undefined) { if (e.data && !ehDataISO(e.data)) recusa('Data inválida.'); set('data', e.data || null); }
    if (e.responsavel !== undefined) set('responsavel', e.responsavel ? await umaPessoa(ctx, e.responsavel) : null);
    if (e.prioridade !== undefined) set('prioridade', e.prioridade === 'alta' ? 'alta' : 'normal');
    if (e.obs !== undefined) set('obs', e.obs || null);
    if (!sets.length) recusa('Nada para mudar.');
    await ctx.q(`update public.atividades set ${sets.join(', ')} where id = $1`, p);
    await registrar(ctx, 'Editou atividade', `${a.cliente} — ${e.titulo ?? a.titulo}`);
    const [n] = await ctx.q(SQL_TAREFAS + ' where a.id = $1', [a.id]);
    return { feito: true, tarefa: linhaTarefa(n, hojeSP(ctx.agora)) };
  },

  async reabrir_tarefa(ctx, e) {
    exigir(ctx, 'concluir', 'reabrir atividades');
    const [a] = await ctx.q(SQL_TAREFAS + ' where a.id = $1', [e.tarefa_id]);
    if (!a) recusa('Não achei essa tarefa.');
    if (!a.feita_em) return { feito: false, motivo: 'Ela já está em aberto.' };
    await ctx.q(`update public.atividades set feita_em = null, feita_por = null where id = $1`, [a.id]);
    await registrar(ctx, 'Reabriu atividade', `${a.cliente} — ${a.titulo}`);
    return { feito: true, cliente: a.cliente, titulo: a.titulo };
  },

  async listar_compromissos(ctx, e) {
    const hoje = hojeSP(ctx.agora);
    let resp = await umaPessoa(ctx, e.responsavel);
    if (!pode(ctx.perfil, 'ver_compromissos')) resp = ctx.perfil.nome;
    const f = ['k.feito_em is null'], p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); f.push(sql.replace('?', '$' + p.length)); };
    if (e.quando === 'hoje') add('k.data = ?', hoje);
    if (e.quando === 'amanha') add('k.data = ?', somaDias(hoje, 1));
    if (e.quando === 'semana') add('k.data <= ?', somaDias(hoje, 7));
    if (e.quando === 'atrasados') add('k.data < ?', hoje);
    if (resp) add('k.responsavel = ?', resp);
    const r = await ctx.q(`select k.id, k.tipo, k.data::text, k.hora, k.local, k.responsavel, k.obs, c.nome as cliente
        from public.compromissos k left join public.clientes c on c.id = k.cliente_id
       where ${f.join(' and ')} order by k.data nulls last, k.hora nulls last limit 40`, p);
    return {
      responsavel: resp || 'todos',
      compromissos: r.map((k: any) => ({
        id: k.id, tipo: k.tipo, cliente: k.cliente || null, quando: fmtData(k.data, hoje), hora: k.hora,
        local: k.local, responsavel: k.responsavel, obs: k.obs,
      })),
    };
  },

  async marcar_compromisso(ctx, e) {
    exigir(ctx, 'criar_compromisso', 'marcar compromissos');
    if (!TIPOS_COMP.includes(e.tipo)) recusa('Tipo inválido.');
    if (!ehDataISO(e.data)) recusa('Data inválida, use AAAA-MM-DD.');
    if (e.hora && !/^\d{2}:\d{2}$/.test(e.hora)) recusa('Hora inválida, use HH:MM.');
    const cli = e.cliente ? await umCliente(ctx, e.cliente) : null;
    const resp = await umaPessoa(ctx, e.responsavel);
    const id = novoId();
    await ctx.q(`insert into public.compromissos (id, tipo, cliente_id, data, hora, local, responsavel, obs)
                 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, e.tipo, cli?.id || null, e.data, e.hora || null, e.local || null, resp, e.obs || null]);
    await registrar(ctx, 'Marcou compromisso', e.tipo + (cli ? ' — ' + cli.nome : ''));
    return { feito: true, id, tipo: e.tipo, cliente: cli?.nome || null, quando: fmtData(e.data, hojeSP(ctx.agora)), hora: e.hora || null, responsavel: resp };
  },

  async concluir_compromisso(ctx, e) {
    if (!pode(ctx.perfil, 'concluir') && !pode(ctx.perfil, 'criar_compromisso')) exigir(ctx, 'concluir', 'concluir compromissos');
    const [k] = await ctx.q(`select k.*, c.nome as cliente from public.compromissos k
        left join public.clientes c on c.id = k.cliente_id where k.id = $1`, [e.compromisso_id]);
    if (!k) recusa('Não achei esse compromisso.');
    if (k.feito_em) return { feito: false, motivo: 'Já estava concluído.' };
    await ctx.q(`update public.compromissos set feito_em = now(), feito_por = $2 where id = $1`, [k.id, ctx.perfil.nome]);
    await registrar(ctx, 'Concluiu compromisso', k.tipo + (k.cliente ? ' — ' + k.cliente : ''));
    return { feito: true, tipo: k.tipo, cliente: k.cliente };
  },

  async ver_cliente(ctx, e) {
    const c = await umCliente(ctx, e.cliente);
    const hoje = hojeSP(ctx.agora);
    const abertas = await ctx.q(SQL_TAREFAS + ' where a.cliente_id = $1 and a.feita_em is null order by a.data nulls last', [c.id]);
    const [mes] = await ctx.q(`select count(*)::int n from public.atividades where cliente_id = $1
        and to_char(feita_em at time zone 'America/Sao_Paulo', 'YYYY-MM') = $2`, [c.id, mesDe(hoje)]);
    const fin: Resultado = {};
    if (pode(ctx.perfil, 'ver_financeiro')) {
      const [pg] = await ctx.q(`select 1 from public.pagamentos where cliente_id = $1 and mes = $2`, [c.id, mesDe(hoje)]);
      Object.assign(fin, {
        mensalidade: c.mensalidade ? reais(c.mensalidade) : 'não cadastrada',
        vencimento: c.dia_venc ? 'dia ' + c.dia_venc : 'sem dia',
        pago_este_mes: !!pg,
      });
    }
    return {
      cliente: c.nome, situacao: c.status, whatsapp: c.contato || 'não cadastrado',
      pendencias: abertas.map(a => linhaTarefa(a, hoje)),
      entregues_este_mes: mes?.n ?? 0,
      ...fin,
      meta: c.meta_conta_id ? { conta: c.meta_conta_nome || c.meta_conta_id, pagina: c.meta_pagina_nome } : 'sem conta de anúncio ligada',
    };
  },

  async financeiro(ctx, e) {
    exigir(ctx, 'ver_financeiro', 'ver o financeiro');
    const hoje = hojeSP(ctx.agora);
    const mes = e.mes && /^\d{4}-\d{2}$/.test(e.mes) ? e.mes : mesDe(hoje);
    const r = await ctx.q(`select c.nome, c.mensalidade::float as valor, c.dia_venc, p.pago_em is not null as pago
        from public.clientes c left join public.pagamentos p on p.cliente_id = c.id and p.mes = $1
       where c.status <> 'pausado' and coalesce(c.mensalidade, 0) > 0 order by c.dia_venc nulls last, c.nome`, [mes]);
    const diaHoje = Number(hoje.slice(8, 10));
    const atrasado = (x: any) => !x.pago && (mes < mesDe(hoje) || (mes === mesDe(hoje) && Number(x.dia_venc) < diaHoje));
    const soma = (l: any[]) => l.reduce((s, x) => s + Number(x.valor || 0), 0);
    const pagos = r.filter(x => x.pago), atras = r.filter(atrasado);
    return {
      mes, previsto: reais(soma(r)), recebido: reais(soma(pagos)), falta_entrar: reais(soma(r) - soma(pagos)),
      pagos: `${pagos.length} de ${r.length}`,
      em_atraso: atras.map(x => ({ cliente: x.nome, valor: reais(x.valor), venceu_dia: x.dia_venc })),
      a_vencer: r.filter(x => !x.pago && !atrasado(x)).map(x => ({ cliente: x.nome, valor: reais(x.valor), dia: x.dia_venc })),
    };
  },

  async marcar_pagamento(ctx, e) {
    exigir(ctx, 'editar_financeiro', 'marcar mensalidade como recebida');
    const c = await umCliente(ctx, e.cliente);
    const mes = e.mes && /^\d{4}-\d{2}$/.test(e.mes) ? e.mes : mesDe(hojeSP(ctx.agora));
    if (e.recebido) {
      await ctx.q(`insert into public.pagamentos (cliente_id, mes) values ($1, $2) on conflict do nothing`, [c.id, mes]);
      await registrar(ctx, 'Marcou pagamento recebido', `${c.nome} — ${mes}`);
    } else {
      await ctx.q(`delete from public.pagamentos where cliente_id = $1 and mes = $2`, [c.id, mes]);
      await registrar(ctx, 'Desfez pagamento', `${c.nome} — ${mes}`);
    }
    return { feito: true, cliente: c.nome, mes, recebido: !!e.recebido };
  },

  async anuncios_cliente(ctx, e) {
    exigir(ctx, 'meta_ver', 'ver os anúncios');
    const c = await umCliente(ctx, e.cliente);
    exigirConta(c);
    const r = await meta.resumo(cfgMeta(ctx, await tokenMeta(ctx, c.id)), c.meta_conta_id!, e.periodo || '7d');
    return {
      cliente: c.nome, ...r,
      campanhas: r.campanhas.slice(0, 15).map(x => ({
        id: x.id, nome: x.nome, situacao: x.situacao, gasto: x.gasto, conversas: x.conversas, leads: x.leads,
        custo_conversa: x.custoConversa, custo_lead: x.custoLead,
        orcamento_diario: x.orcamentoDiario, orcamento_total: x.orcamentoTotal,
        ...(x.orcamentoNoConjunto ? { orcamento: 'nos conjuntos' } : {}),
      })),
    };
  },

  async publicacoes_cliente(ctx, e) {
    exigir(ctx, 'meta_ver', 'ver as publicações');
    const c = await umCliente(ctx, e.cliente);
    if (!c.meta_pagina_id) recusa(`${c.nome} não tem página ligada. Ligue na ficha do cliente, na parte "Anúncios".`);
    const r = await meta.publicacoes(cfgMeta(ctx, await tokenMeta(ctx, c.id)), c.meta_pagina_id!, 6);
    return {
      cliente: c.nome, fonte: r.fonte, conta: r.conta,
      publicacoes: r.itens.map(i => ({
        data: i.data ? String(i.data).slice(0, 10) : null, tipo: i.tipo, legenda: i.texto.slice(0, 160),
        curtidas: i.curtidas, comentarios: i.comentarios, link: i.link,
      })),
    };
  },

  async alterar_campanha(ctx, e) {
    exigir(ctx, 'meta_editar', 'alterar campanhas');
    const c = await umCliente(ctx, e.cliente);
    exigirConta(c);
    const mud: meta.Alteracao = {};
    let descricao = '';
    if (e.acao === 'pausar') { mud.status = 'PAUSED'; descricao = 'pausar'; }
    else if (e.acao === 'ativar') { mud.status = 'ACTIVE'; descricao = 'ativar (volta a gastar)'; }
    else if (e.acao === 'orcamento_diario') {
      const v = Number(String(e.valor ?? '').replace(/[^\d,.]/g, '').replace(',', '.'));
      if (!Number.isFinite(v) || v <= 0) recusa('Diga o valor do orçamento diário em reais.');
      mud.orcamentoDiario = v; descricao = `mudar o orçamento diário para ${reais(v)}`;
    } else if (e.acao === 'renomear') {
      if (!String(e.valor || '').trim()) recusa('Diga o nome novo.');
      mud.nome = String(e.valor).trim(); descricao = `renomear para "${mud.nome}"`;
    } else recusa('Ação inválida.');

    const chave = chaveConfirmacao(e);
    if (!e.confirmado || !ctx.confirmaveis?.has(chave)) {
      return {
        precisa_confirmar: true, chave_confirmacao: chave,
        resumo: `Vou ${descricao} na campanha/conjunto ${e.campanha_id} da conta de ${c.nome}. Confirma?`,
        ...(e.confirmado ? { aviso: 'Ainda não houve confirmação da pessoa depois do resumo. Pergunte antes.' } : {}),
      };
    }
    const r = await meta.alterar(cfgMeta(ctx, await tokenMeta(ctx, c.id)), c.meta_conta_id!, e.campanha_id, mud);
    await registrar(ctx, 'Alterou campanha na Meta', `${c.nome} — ${r.nomeAntes}: ${descricao}`);
    return { feito: true, cliente: c.nome, campanha: r.nomeAntes, antes: r.antes, depois: r.depois };
  },

  async listar_postagens(ctx, e) {
    const hoje = hojeSP(ctx.agora);
    const { E, risco } = await etapasDe(ctx);
    const cli = e.cliente ? await umCliente(ctx, e.cliente) : null;
    const resp = await umaPessoa(ctx, e.responsavel);
    let r: any[] = await ctx.q(SQL_POSTS + ` where c.status <> 'pausado'` + (cli ? ' and p.cliente_id = $1' : '') +
      ' order by p.data_publicacao nulls last, p.prioridade', cli ? [cli.id] : []);
    const sit = (p: any) => situacao(p, E, hoje, risco);
    const f = e.filtro;
    if (f === 'publicadas_mes') r = r.filter(p => p.etapa === 'publicado' && String(p.data_publicacao || '').slice(0, 7) === hoje.slice(0, 7));
    else {
      r = r.filter(p => p.etapa !== 'publicado');
      if (f === 'atrasadas') r = r.filter(p => sit(p) === 'atrasada');
      if (f === 'em_risco') r = r.filter(p => sit(p) === 'risco');
      if (f === 'hoje') r = r.filter(p => p.data_publicacao === hoje);
      if (f === 'semana') r = r.filter(p => p.data_publicacao && p.data_publicacao <= somaDias(hoje, 7));
      if (f === 'aguardando_aprovacao') r = r.filter(p => p.etapa === 'aprovacao');
      if (f === 'fila_edicao') r = r.filter(p => EH_VIDEO(p.formato) && ['producao', 'captacao', 'edicao', 'revisao'].includes(p.etapa))
        .sort((a, b) => (a.prioridade === 'alta' ? 0 : 1) - (b.prioridade === 'alta' ? 0 : 1) || String(a.data_publicacao || '9').localeCompare(String(b.data_publicacao || '9')));
    }
    if (resp) r = r.filter(p => donoAtual(p, E) === resp);
    return {
      filtro: f, cliente: cli?.nome || 'todos', ...(resp ? { com: resp } : {}),
      total: r.length, postagens: r.slice(0, 40).map(p => linhaPost(p, E, hoje, risco)),
    };
  },

  async criar_postagem(ctx, e) {
    exigir(ctx, 'postagens_editar', 'criar postagens');
    const cli = await umCliente(ctx, e.cliente);
    const titulo = String(e.titulo || '').trim();
    if (!titulo) recusa('Falta o tema da postagem.');
    if (!FORMATOS[e.formato]) recusa('Formato inválido.');
    if (e.data_publicacao && !ehDataISO(e.data_publicacao)) recusa('Data inválida, use AAAA-MM-DD.');
    if (e.hora && !/^\d{2}:\d{2}$/.test(e.hora)) recusa('Hora inválida, use HH:MM.');
    const [resp, capt, edit] = [await umaPessoa(ctx, e.responsavel), await umaPessoa(ctx, e.captador), await umaPessoa(ctx, e.editor)];
    const [c2] = await ctx.q(`select resp_social from public.clientes where id = $1`, [cli.id]);
    const id = novoId();
    const ev = [{ ts: ctx.agora.toISOString(), quem: ctx.perfil.nome + ' (Cometinha)', txt: 'Criou a postagem' }];
    await ctx.q(`insert into public.postagens (id, cliente_id, titulo, formato, data_publicacao, hora, responsavel, captador, editor,
                   roteiro, legenda, prioridade, eventos) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, cli.id, titulo, e.formato, e.data_publicacao || null, e.hora || null, resp || c2?.resp_social || null, capt, edit,
        e.roteiro || null, e.legenda || null, e.prioridade === 'alta' ? 'alta' : 'normal', JSON.stringify(ev)]);
    await registrar(ctx, 'Criou postagem', `${cli.nome} — ${titulo}`);
    return { feito: true, id, cliente: cli.nome, titulo, formato: FORMATOS[e.formato], publica: fmtData(e.data_publicacao || null, hojeSP(ctx.agora)) };
  },

  async mover_postagem(ctx, e) {
    if (!pode(ctx.perfil, 'postagens_mover')) exigir(ctx, 'postagens_editar', 'mudar a etapa das postagens');
    const { E, risco } = await etapasDe(ctx);
    const [p] = await ctx.q(SQL_POSTS + ' where p.id = $1', [e.postagem_id]);
    if (!p) recusa('Não achei essa postagem. Liste de novo.');
    const i = indiceEtapa(E, p.etapa);
    const destino = e.etapa === 'proxima' ? E[Math.min(i + 1, E.length - 1)]
      : E.find(x => x.k === e.etapa || normalizar(x.nome) === normalizar(e.etapa));
    if (!destino) recusa(`Etapa inválida. Etapas: ${E.map(x => x.k).join(', ')}.`);
    if (destino!.k === p.etapa) return { feito: false, motivo: `Já está em ${destino!.nome}.` };
    const ev = [...(p.eventos || []), { ts: ctx.agora.toISOString(), quem: ctx.perfil.nome + ' (Cometinha)',
      txt: `${E[i]?.nome} → ${destino!.nome}` + (e.comentario ? ': ' + e.comentario : '') }];
    const publicado = destino!.k === 'publicado';
    await ctx.q(`update public.postagens set etapa = $2, eventos = $3, etapa_desde = now(),
        aprovacao = case when $2 = 'aprovacao' then 'pendente' else aprovacao end,
        link_publicado = coalesce($4, link_publicado),
        publicado_em = case when $5::boolean then coalesce(publicado_em, now()) else null end where id = $1`,
      [p.id, destino!.k, JSON.stringify(ev), e.link || null, publicado]);
    await registrar(ctx, 'Moveu postagem', `${p.cliente} — ${p.titulo}: ${destino!.nome}`);
    const [n] = await ctx.q(SQL_POSTS + ' where p.id = $1', [p.id]);
    return { feito: true, postagem: linhaPost(n, E, hojeSP(ctx.agora), risco),
      ...(destino!.k === 'aprovacao' ? { lembrete: 'Mande o link de aprovação para o cliente (botão na ficha do cliente).' } : {}) };
  },

  async alertas_anuncios(ctx, e) {
    exigir(ctx, 'meta_ver', 'ver os alertas de anúncios');
    const cli = e.cliente ? await umCliente(ctx, e.cliente) : null;
    const r = await ctx.q(`select a.id, a.tipo, a.gravidade, a.campanha, a.texto, a.criado_em, c.nome cliente
        from public.alertas_anuncios a left join public.clientes c on c.id = a.cliente_id
       where a.resolvido_em is null ${cli ? 'and a.cliente_id = $1' : ''} order by a.criado_em desc limit 40`, cli ? [cli.id] : []);
    return { total: r.length, alertas: r.map((a: any) => ({ cliente: a.cliente, gravidade: a.gravidade, texto: a.texto,
      desde: new Date(a.criado_em).toISOString().slice(0, 10) })) };
  },

  async materiais(ctx, e) {
    const hoje = hojeSP(ctx.agora);
    if (e.acao === 'listar') {
      const cli = e.cliente ? await umCliente(ctx, e.cliente) : null;
      const r = await ctx.q(`select m.id, m.descricao, m.prazo::text, m.lembretes, c.nome cliente from public.materiais m
          join public.clientes c on c.id = m.cliente_id where m.recebido_em is null ${cli ? 'and m.cliente_id = $1' : ''}
          order by m.prazo nulls last`, cli ? [cli.id] : []);
      return { pendentes: r.map((m: any) => ({ id: m.id, cliente: m.cliente, material: m.descricao,
        prazo: fmtData(m.prazo, hoje), lembretes_enviados: m.lembretes })) };
    }
    if (!pode(ctx.perfil, 'materiais')) exigir(ctx, 'editar_clientes', 'mexer nos materiais');
    if (e.acao === 'pedir') {
      const cli = await umCliente(ctx, e.cliente);
      const d = String(e.descricao || '').trim();
      if (!d) recusa('Diga o que foi pedido.');
      if (e.prazo && !ehDataISO(e.prazo)) recusa('Prazo inválido.');
      const id = novoId();
      await ctx.q(`insert into public.materiais (id, cliente_id, descricao, prazo) values ($1,$2,$3,$4)`, [id, cli.id, d, e.prazo || null]);
      await registrar(ctx, 'Pediu material', `${cli.nome} — ${d}`);
      return { feito: true, id, cliente: cli.nome, material: d, prazo: fmtData(e.prazo || null, hoje) };
    }
    if (e.acao === 'recebido') {
      const [m] = await ctx.q(`select m.id, m.descricao, c.nome cliente from public.materiais m join public.clientes c on c.id = m.cliente_id
          where m.id = $1`, [e.material_id]);
      if (!m) recusa('Não achei esse material.');
      await ctx.q(`update public.materiais set recebido_em = now() where id = $1`, [m.id]);
      await registrar(ctx, 'Recebeu material', `${m.cliente} — ${m.descricao}`);
      return { feito: true, cliente: m.cliente, material: m.descricao };
    }
    recusa('Ação inválida.');
    return {};
  },

  async equipe(ctx) {
    return { equipe: await nomesEquipe(ctx), voce: ctx.perfil.nome };
  },
};

export const chaveConfirmacao = (e: any) =>
  [String(e.campanha_id || '').trim(), e.acao, String(e.valor ?? '').trim()].join('|');

/** roda uma ferramenta; erros viram texto para o Cometinha explicar */
export async function executar(ctx: Ctx, nome: string, entrada: unknown): Promise<{ texto: string; erro: boolean; acao?: string }> {
  const fn = ACOES[nome];
  if (!fn) return { texto: `Ferramenta desconhecida: ${nome}`, erro: true };
  try {
    // o perfil é relido a cada ação: se alguém for bloqueado no meio da conversa, para na hora
    const atual = await carregarPerfil(ctx.q, ctx.perfil.id);
    if (!atual) return { texto: 'Este acesso foi desativado. Nada foi feito.', erro: true };
    ctx.perfil = atual;
    const r = await fn(ctx, entrada && typeof entrada === 'object' ? entrada : {});
    return { texto: JSON.stringify(r), erro: false, acao: r && (r as any).feito ? nome : undefined };
  } catch (err) {
    if (err instanceof Recusa || err instanceof meta.MetaErro) return { texto: err.message, erro: true };
    console.error('ferramenta', nome, err);
    return { texto: 'Deu um erro interno ao executar. Nada garante que foi feito; confira no CRM.', erro: true };
  }
}
