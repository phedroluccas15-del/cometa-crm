// Regras da produção de conteúdo (etapas, prazos, semáforo) e do monitor de anúncios.
// Sem dependências: roda no Supabase (Deno) e nos testes (Node).
// A tela (index.html) usa as MESMAS regras; se mudar aqui, mude lá também.

import { diasEntre, somaDias } from './regras.ts';

export type Etapa = { k: string; nome: string; dias: number; quem: string };
export type Postagem = {
  id: string; cliente_id: string; titulo: string; formato: string; etapa: string;
  data_publicacao: string | null; hora?: string | null; prioridade?: string;
  responsavel?: string | null; captador?: string | null; editor?: string | null; revisor?: string | null;
  [k: string]: unknown;
};

export const ETAPAS_PADRAO: Etapa[] = [
  { k: 'pauta', nome: 'Pauta', dias: 10, quem: 'responsavel' },
  { k: 'producao', nome: 'Produção solicitada', dias: 8, quem: 'responsavel' },
  { k: 'captacao', nome: 'Captação', dias: 6, quem: 'captador' },
  { k: 'edicao', nome: 'Edição', dias: 4, quem: 'editor' },
  { k: 'revisao', nome: 'Revisão interna', dias: 3, quem: 'revisor' },
  { k: 'aprovacao', nome: 'Aprovação do cliente', dias: 2, quem: 'cliente' },
  { k: 'agendamento', nome: 'Agendamento', dias: 1, quem: 'responsavel' },
  { k: 'publicado', nome: 'Publicado', dias: 0, quem: 'responsavel' },
];

export const FORMATOS: Record<string, string> = {
  feed: 'Post (feed)', carrossel: 'Carrossel', reels: 'Reels', video: 'Vídeo', stories: 'Stories', arte: 'Arte / anúncio',
};
export const EH_VIDEO = (f: string) => f === 'reels' || f === 'video';

export function etapasValidas(e: unknown): Etapa[] {
  const l = Array.isArray(e) ? e.filter((x: any) => x && typeof x.k === 'string' && x.k) : [];
  if (!l.length) return ETAPAS_PADRAO;
  // "publicado" sempre existe e fica por último
  const sem = l.filter((x: any) => x.k !== 'publicado').map((x: any) => ({
    k: x.k, nome: String(x.nome || x.k), dias: Math.max(0, Number(x.dias) || 0), quem: String(x.quem || 'responsavel'),
  }));
  return [...sem, { k: 'publicado', nome: 'Publicado', dias: 0, quem: 'responsavel' }];
}

export const indiceEtapa = (E: Etapa[], k: string) => {
  const i = E.findIndex(e => e.k === k);
  return i < 0 ? 0 : i;
};

/** quem precisa agir agora (nome da pessoa), "cliente" ou null */
export function donoAtual(p: Postagem, E: Etapa[]): string | null {
  const e = E[indiceEtapa(E, p.etapa)];
  if (!e || e.k === 'publicado') return null;
  if (e.quem === 'cliente') return 'cliente';
  return (p[e.quem] as string) || p.responsavel || null;
}

/**
 * Prazo de cada etapa, contando para trás a partir da data de publicação.
 * Se a etapa atual já passou do prazo, as que faltam são reorganizadas
 * (comprimidas entre hoje e a publicação) para ainda dar tempo.
 */
export function prazosEtapas(p: Postagem, E: Etapa[], hoje: string) {
  const r: Record<string, string> = {};
  if (!p.data_publicacao) return { prazos: r, reorganizado: false };
  const pub = p.data_publicacao;
  const atual = indiceEtapa(E, p.etapa);
  E.forEach(e => { r[e.k] = somaDias(pub, -e.dias); });
  let reorganizado = false;
  const cur = E[atual];
  if (cur && cur.k !== 'publicado' && r[cur.k] < hoje && pub >= hoje) {
    const disponivel = diasEntre(hoje, pub);
    const base = cur.dias || 1;
    for (let i = atual; i < E.length; i++) {
      r[E[i].k] = somaDias(pub, -Math.floor(E[i].dias * disponivel / base));
    }
    reorganizado = true;
  }
  return { prazos: r, reorganizado };
}

export type Situacao = 'publicada' | 'atrasada' | 'risco' | 'ok' | 'sem_data';

/** atrasada = passou da data e não publicou; risco = perto da data e ainda não está pronta, ou etapa atrasada */
export function situacao(p: Postagem, E: Etapa[], hoje: string, riscoDias = 3, horaAgora?: string): Situacao {
  if (p.etapa === 'publicado') return 'publicada';
  if (!p.data_publicacao) return 'sem_data';
  const pub = p.data_publicacao;
  if (pub < hoje) return 'atrasada';
  if (pub === hoje && p.hora && horaAgora && horaAgora > p.hora) return 'atrasada';
  const iAg = E.findIndex(e => e.k === 'agendamento');
  const pronta = iAg >= 0 ? indiceEtapa(E, p.etapa) >= iAg : false;
  if (!pronta && diasEntre(hoje, pub) <= riscoDias) return 'risco';
  const e = E[indiceEtapa(E, p.etapa)];
  if (e && somaDias(pub, -e.dias) < hoje) return 'risco';
  return 'ok';
}

export type Cor = 'vermelho' | 'amarelo' | 'verde';
/** semáforo do cliente: vermelho = tem postagem que passou e não saiu; amarelo = alguma em risco */
export function semaforo(posts: Postagem[], E: Etapa[], hoje: string, riscoDias = 3, horaAgora?: string): Cor {
  let cor: Cor = 'verde';
  for (const p of posts) {
    const s = situacao(p, E, hoje, riscoDias, horaAgora);
    if (s === 'atrasada') return 'vermelho';
    if (s === 'risco') cor = 'amarelo';
  }
  return cor;
}

// ============================================================
// Monitor de anúncios
// ============================================================
export type MetasCliente = { meta_orcamento_dia?: number | null; meta_cpl_max?: number | null; meta_resultados_dia?: number | null };
export type Totais = { gasto: number; conversas: number; leads: number };
export type Campanha = Totais & { id: string; nome: string; ativa: boolean; situacao: string };
export type Leitura = {
  ontem: { total: Totais; campanhas: Campanha[] };
  semana: { total: Totais; campanhas: Campanha[]; alertas: string[] };
  semanaAnterior?: Totais | null;
};
export type Alerta = { tipo: string; gravidade: 'alta' | 'media' | 'baixa'; campanha?: string; texto: string };

const res = (t: Totais) => (t.conversas || 0) + (t.leads || 0);
const custo = (t: Totais) => (res(t) ? t.gasto / res(t) : null);
const brl = (v: number) => 'R$ ' + v.toFixed(2).replace('.', ',');

/** compara os números da conta com as metas do cliente e devolve só o que está fora do normal */
export function analisarAnuncios(m: MetasCliente, l: Leitura): Alerta[] {
  const a: Alerta[] = [];
  const cplMax = Number(m.meta_cpl_max) || null;
  const orcDia = Number(m.meta_orcamento_dia) || null;
  const resDia = Number(m.meta_resultados_dia) || null;

  // problemas da conta (limite, conta bloqueada, reprovada) que o resumo já detecta
  for (const t of l.semana.alertas || []) {
    if (/sem entrega|sem nenhuma conversa/.test(t)) continue; // tratados abaixo, com as metas
    a.push({ tipo: /limite/i.test(t) ? 'limite' : /reprovad|problema/i.test(t) ? 'reprovada' : 'conta', gravidade: 'alta', texto: t });
  }
  for (const c of l.ontem.campanhas) {
    if (c.ativa && c.gasto === 0) a.push({ tipo: 'sem_entrega', gravidade: 'alta', campanha: c.nome,
      texto: `"${c.nome}" está ativa mas não gastou nada ontem (sem entrega/impressões).` });
  }
  const limiteSemResultado = Math.max(30, (cplMax || 0) * 2);
  for (const c of l.semana.campanhas) {
    if (c.ativa && c.gasto >= limiteSemResultado && res(c) === 0) a.push({ tipo: 'sem_resultado', gravidade: 'alta', campanha: c.nome,
      texto: `"${c.nome}" gastou ${brl(c.gasto)} em 7 dias sem nenhuma conversa ou lead.` });
  }
  const cpl = custo(l.semana.total);
  if (cplMax && cpl !== null && cpl > cplMax) a.push({ tipo: 'cpl_alto', gravidade: 'media',
    texto: `Custo por resultado em 7 dias está ${brl(cpl)} (meta: até ${brl(cplMax)}).` });
  const ant = l.semanaAnterior;
  if (ant && cpl !== null) {
    const cplAnt = custo(ant);
    if (cplAnt && cpl > cplAnt * 1.3) a.push({ tipo: 'cpl_subindo', gravidade: 'media',
      texto: `Custo por resultado subiu ${Math.round((cpl / cplAnt - 1) * 100)}%: ${brl(cplAnt)} → ${brl(cpl)} (7 dias contra os 7 anteriores).` });
  }
  if (ant && res(ant) >= 10 && res(l.semana.total) < res(ant) * 0.6) a.push({ tipo: 'queda', gravidade: 'alta',
    texto: `Queda de resultados: ${res(l.semana.total)} nos últimos 7 dias contra ${res(ant)} nos 7 anteriores.` });
  if (orcDia && l.ontem.total.gasto > orcDia * 1.15) a.push({ tipo: 'orcamento', gravidade: 'media',
    texto: `Gastou ${brl(l.ontem.total.gasto)} ontem (planejado: ${brl(orcDia)} por dia).` });
  if (resDia && l.ontem.total.gasto > 0 && res(l.ontem.total) < resDia * 0.5) a.push({ tipo: 'poucos_resultados', gravidade: 'baixa',
    texto: `Só ${res(l.ontem.total)} resultado(s) ontem (meta: ${resDia} por dia).` });
  return a;
}

/** chave que impede repetir o mesmo alerta no mesmo dia */
export const chaveAlerta = (clienteId: string, a: Alerta, hoje: string) =>
  [clienteId, a.tipo, a.campanha || '', hoje].join('|');
