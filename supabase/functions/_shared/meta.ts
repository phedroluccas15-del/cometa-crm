// Conversa com a API de anúncios da Meta (Graph API).
// Baseado no cliente do CRM da InvestCred, com edição de campanha.

export type MetaCfg = {
  token: string;
  versao?: string;               // ex.: "v25.0" (variável META_GRAPH_VERSION)
  fetch?: typeof fetch;          // trocado nos testes
};

export class MetaErro extends Error {
  codigo?: number;
  constructor(msg: string, codigo?: number) { super(msg); this.codigo = codigo; }
}

const VERSAO_PADRAO = 'v25.0';

function traduzir(e: any): string {
  const c = e?.code, sub = e?.error_subcode;
  if (c === 190) return 'A chave da Meta venceu ou foi revogada. Gere uma nova no Gerenciador de Negócios.';
  if (c === 10 || c === 200 || (c >= 200 && c < 300)) return 'A chave da Meta não tem permissão para isso nesta conta.';
  if (c === 4 || c === 17 || c === 32 || c === 613 || c === 80004) return 'A Meta pediu para esperar um pouco (muitas consultas seguidas). Tente de novo em alguns minutos.';
  if (c === 100 && sub === 33) return 'A Meta não encontrou essa conta/campanha, ou a chave não tem acesso a ela.';
  return 'A Meta recusou: ' + (e?.error_user_msg || e?.message || 'erro desconhecido');
}

async function graph(cfg: MetaCfg, caminho: string, params: Record<string, string> = {}, metodo = 'GET'): Promise<any> {
  const f = cfg.fetch ?? fetch;
  const base = `https://graph.facebook.com/${cfg.versao || VERSAO_PADRAO}/${caminho.replace(/^\//, '')}`;
  let resp: Response;
  if (metodo === 'GET') {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    resp = await f(u.toString(), { headers: { Authorization: `Bearer ${cfg.token}` } });
  } else {
    resp = await f(base, {
      method: metodo,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  }
  let corpo: any = null;
  try { corpo = await resp.json(); } catch { /* sem corpo */ }
  if (!resp.ok || corpo?.error) throw new MetaErro(traduzir(corpo?.error), corpo?.error?.code);
  return corpo;
}

/** segue a paginação da Meta, com teto para nunca travar */
async function todas(cfg: MetaCfg, caminho: string, params: Record<string, string>, max = 10): Promise<any[]> {
  const itens: any[] = [];
  let r = await graph(cfg, caminho, params);
  for (let i = 0; i < max; i++) {
    itens.push(...(r.data || []));
    const depois = r.paging?.cursors?.after;
    if (!r.paging?.next || !depois) break;
    r = await graph(cfg, caminho, { ...params, after: depois });
  }
  return itens;
}

export const semAct = (id: string) => String(id || '').replace(/^act_/, '').trim();
const act = (id: string) => 'act_' + semAct(id);

// ---------- períodos ----------
export const PERIODOS: Record<string, string> = {
  hoje: 'today', ontem: 'yesterday', '7d': 'last_7d', '30d': 'last_30d', mes: 'this_month', mes_passado: 'last_month',
};
export const NOME_PERIODO: Record<string, string> = {
  hoje: 'hoje', ontem: 'ontem', '7d': 'últimos 7 dias', '30d': 'últimos 30 dias', mes: 'este mês', mes_passado: 'mês passado',
};
const preset = (p: string) => PERIODOS[p] || PERIODOS['7d'];

// ---------- resultados ----------
// O nome do "resultado" muda conforme o objetivo da campanha. Tentamos em ordem.
const TIPOS_CONVERSA = [
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.total_messaging_connection',
  'onsite_conversion.messaging_first_reply',
];
const TIPOS_LEAD = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'leadgen_grouped'];

function primeiro(lista: any[] | undefined, tipos: string[]): number | null {
  for (const t of tipos) {
    const a = (lista || []).find(x => x?.action_type === t);
    if (a) { const v = Number(a.value); if (Number.isFinite(v)) return v; }
  }
  return null;
}

export function resultados(ins: any) {
  const conversas = primeiro(ins?.actions, TIPOS_CONVERSA) ?? 0;
  const leads = primeiro(ins?.actions, TIPOS_LEAD) ?? 0;
  const gasto = Number(ins?.spend || 0);
  return {
    gasto,
    impressoes: Number(ins?.impressions || 0),
    alcance: Number(ins?.reach || 0),
    cliques: Number(ins?.clicks || 0),
    conversas,
    leads,
    custoConversa: conversas ? +(gasto / conversas).toFixed(2) : null,
    custoLead: leads ? +(gasto / leads).toFixed(2) : null,
  };
}

// a Meta manda valores de conta e orçamento em centavos
const centavos = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v) / 100);

const STATUS_CONTA: Record<number, string> = {
  1: 'ativa', 2: 'desativada', 3: 'pagamento pendente', 7: 'em análise pela Meta', 8: 'acerto de pagamento pendente',
  9: 'em período de carência', 100: 'encerramento pendente', 101: 'encerrada',
};
const STATUS_CAMPANHA: Record<string, string> = {
  ACTIVE: 'ativa', PAUSED: 'pausada', CAMPAIGN_PAUSED: 'pausada', ADSET_PAUSED: 'conjunto pausado',
  IN_PROCESS: 'processando', WITH_ISSUES: 'com problema', PENDING_REVIEW: 'em análise',
  DISAPPROVED: 'reprovada', PENDING_BILLING_INFO: 'falta pagamento', ARCHIVED: 'arquivada', DELETED: 'apagada',
};
const STATUS_VISIVEIS = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES',
  'PENDING_REVIEW', 'DISAPPROVED', 'PENDING_BILLING_INFO'];

// ---------- leitura ----------
/** contas de anúncio e páginas que a chave enxerga (para ligar ao cliente) */
export async function listarContas(cfg: MetaCfg) {
  const [contas, paginas] = await Promise.all([
    todas(cfg, 'me/adaccounts', { fields: 'account_id,name,account_status,currency,business{name}', limit: '200' }),
    todas(cfg, 'me/accounts', { fields: 'id,name,instagram_business_account{id,username}', limit: '200' }),
  ]);
  return {
    contas: contas.map(c => ({
      id: semAct(c.account_id || c.id), nome: c.name, empresa: c.business?.name || null,
      status: STATUS_CONTA[c.account_status] || String(c.account_status), moeda: c.currency,
    })).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR')),
    paginas: paginas.map(p => ({
      id: p.id, nome: p.name, instagram: p.instagram_business_account?.username || null,
    })).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR')),
  };
}

const CAMPOS_INSIGHTS = 'spend,impressions,reach,clicks,actions';

export async function resumo(cfg: MetaCfg, contaId: string, periodo = '7d') {
  const dp = preset(periodo);
  const [conta, ins, camps] = await Promise.all([
    graph(cfg, act(contaId), {
      fields: 'name,account_status,currency,amount_spent,spend_cap,balance,is_prepay_account,funding_source_details,disable_reason',
    }),
    graph(cfg, `${act(contaId)}/insights`, { fields: CAMPOS_INSIGHTS, date_preset: dp }),
    todas(cfg, `${act(contaId)}/campaigns`, {
      fields: `id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,insights.date_preset(${dp}){${CAMPOS_INSIGHTS}}`,
      effective_status: JSON.stringify(STATUS_VISIVEIS),
      limit: '50',
    }, 3),
  ]);

  const gastoTotal = centavos(conta.amount_spent) ?? 0;
  const limite = centavos(conta.spend_cap);
  const restante = limite && limite > 0 ? +(limite - gastoTotal).toFixed(2) : null;

  const campanhas = camps.map(c => {
    const r = resultados(c.insights?.data?.[0]);
    return {
      id: c.id, nome: c.name, status: c.status,
      situacao: STATUS_CAMPANHA[c.effective_status] || String(c.effective_status || '').toLowerCase(),
      ativa: c.effective_status === 'ACTIVE',
      objetivo: c.objective,
      orcamentoDiario: centavos(c.daily_budget),
      orcamentoTotal: centavos(c.lifetime_budget),
      orcamentoNoConjunto: !c.daily_budget && !c.lifetime_budget,
      ...r,
    };
  }).sort((a, b) => Number(b.ativa) - Number(a.ativa) || b.gasto - a.gasto);

  const alertas: string[] = [];
  if (conta.account_status !== 1) alertas.push('Conta ' + (STATUS_CONTA[conta.account_status] || 'com problema') + '.');
  if (restante !== null && limite && restante < limite * 0.1) alertas.push(`Limite da conta quase no fim: restam R$ ${restante.toFixed(2)}.`);
  if (periodo !== 'hoje') {
    for (const c of campanhas) {
      if (c.ativa && c.gasto === 0) alertas.push(`"${c.nome}" está ativa mas não gastou nada no período (sem entrega).`);
      if (c.ativa && c.gasto >= 30 && c.conversas === 0 && c.leads === 0) alertas.push(`"${c.nome}" gastou R$ ${c.gasto.toFixed(2)} sem nenhuma conversa ou lead.`);
    }
  }
  for (const c of campanhas) if (c.situacao === 'reprovada' || c.situacao === 'com problema') alertas.push(`"${c.nome}" está ${c.situacao}.`);

  return {
    periodo, nomePeriodo: NOME_PERIODO[periodo] || periodo,
    conta: {
      id: semAct(contaId), nome: conta.name, moeda: conta.currency,
      status: STATUS_CONTA[conta.account_status] || String(conta.account_status),
      gastoTotal, limite, restanteLimite: restante,
      prePago: !!conta.is_prepay_account,
      // para conta pré-paga a Meta costuma mostrar o saldo neste texto
      formaPagamento: conta.funding_source_details?.display_string || null,
      saldoDevedor: centavos(conta.balance),
    },
    total: resultados(ins.data?.[0]),
    campanhas,
    alertas,
  };
}

export async function conjuntos(cfg: MetaCfg, campanhaId: string, periodo = '7d') {
  const dp = preset(periodo);
  const lista = await todas(cfg, `${campanhaId}/adsets`, {
    fields: `id,name,status,effective_status,daily_budget,lifetime_budget,insights.date_preset(${dp}){${CAMPOS_INSIGHTS}}`,
    effective_status: JSON.stringify(STATUS_VISIVEIS),
    limit: '50',
  }, 3);
  return lista.map(s => ({
    id: s.id, nome: s.name, status: s.status,
    situacao: STATUS_CAMPANHA[s.effective_status] || String(s.effective_status || '').toLowerCase(),
    ativa: s.effective_status === 'ACTIVE',
    orcamentoDiario: centavos(s.daily_budget),
    orcamentoTotal: centavos(s.lifetime_budget),
    ...resultados(s.insights?.data?.[0]),
  }));
}

export async function publicacoes(cfg: MetaCfg, paginaId: string, limite = 6) {
  const pag = await graph(cfg, paginaId, { fields: 'name,access_token,instagram_business_account{id,username}' });
  const ig = pag.instagram_business_account;
  if (ig?.id) {
    const r = await graph({ ...cfg, token: pag.access_token || cfg.token }, `${ig.id}/media`, {
      fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit: String(limite),
    });
    return {
      fonte: 'instagram', conta: '@' + ig.username,
      itens: (r.data || []).map((m: any) => ({
        id: m.id, texto: m.caption || '', tipo: m.media_type,
        imagem: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url,
        link: m.permalink, data: m.timestamp, curtidas: m.like_count ?? null, comentarios: m.comments_count ?? null,
      })),
    };
  }
  if (!pag.access_token) throw new MetaErro('A chave não tem acesso às publicações desta página.');
  const r = await graph({ ...cfg, token: pag.access_token }, `${paginaId}/posts`, {
    fields: 'id,message,created_time,permalink_url,full_picture', limit: String(limite),
  });
  return {
    fonte: 'facebook', conta: pag.name,
    itens: (r.data || []).map((p: any) => ({
      id: p.id, texto: p.message || '', tipo: 'POST', imagem: p.full_picture || null,
      link: p.permalink_url, data: p.created_time, curtidas: null, comentarios: null,
    })),
  };
}

// ---------- edição ----------
export type Alteracao = { status?: 'ACTIVE' | 'PAUSED'; orcamentoDiario?: number; nome?: string };

/**
 * Pausa/ativa, muda orçamento diário ou nome de uma campanha OU conjunto.
 * Antes confere se o objeto é mesmo da conta do cliente: assim um engano de
 * número nunca mexe na campanha de outro cliente.
 */
export async function alterar(cfg: MetaCfg, contaId: string, objetoId: string, mud: Alteracao) {
  const obj = await graph(cfg, objetoId, { fields: 'account_id,name,status,daily_budget,lifetime_budget' });
  if (semAct(obj.account_id) !== semAct(contaId)) {
    throw new MetaErro('Essa campanha não é da conta de anúncio deste cliente. Nada foi alterado.');
  }
  const params: Record<string, string> = {};
  if (mud.status) {
    if (!['ACTIVE', 'PAUSED'].includes(mud.status)) throw new MetaErro('Status inválido.');
    params.status = mud.status;
  }
  if (mud.orcamentoDiario !== undefined) {
    const v = Number(mud.orcamentoDiario);
    if (!Number.isFinite(v) || v < 1) throw new MetaErro('Orçamento diário precisa ser de pelo menos R$ 1.');
    if (v > 5000) throw new MetaErro('Orçamento acima de R$ 5.000/dia: por segurança, faça direto no Gerenciador.');
    if (!obj.daily_budget) throw new MetaErro(obj.lifetime_budget
      ? 'Essa usa orçamento total, não diário. Mude no Gerenciador de Anúncios.'
      : 'O orçamento fica nos conjuntos de anúncios. Altere o conjunto em vez da campanha.');
    params.daily_budget = String(Math.round(v * 100));
  }
  if (mud.nome !== undefined) {
    const n = String(mud.nome).trim();
    if (!n) throw new MetaErro('Nome vazio.');
    params.name = n.slice(0, 250);
  }
  if (!Object.keys(params).length) throw new MetaErro('Nada para alterar.');
  await graph(cfg, objetoId, params, 'POST');
  return {
    id: objetoId, nomeAntes: obj.name,
    antes: { status: obj.status, orcamentoDiario: centavos(obj.daily_budget) },
    depois: {
      status: params.status ?? obj.status,
      orcamentoDiario: params.daily_budget ? Number(params.daily_budget) / 100 : centavos(obj.daily_budget),
      nome: params.name ?? obj.name,
    },
  };
}
