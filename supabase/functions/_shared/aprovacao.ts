// Central de aprovações: o cliente abre um link exclusivo (aprovar.html?c=CODIGO),
// vê o que está esperando aprovação e aprova ou pede ajuste. Sem login: o código do link é a chave.

import { hojeSP, type Consulta } from './regras.ts';
import { etapasValidas, FORMATOS } from './producao.ts';

export class ErroAprovacao extends Error {}

async function clientePorToken(q: Consulta, token: unknown) {
  const t = String(token || '').trim();
  if (!/^[a-zA-Z0-9]{16,64}$/.test(t)) throw new ErroAprovacao('Link inválido.');
  const [c] = await q(`select id, nome from public.clientes where token_aprovacao = $1 and status <> 'pausado'`, [t]);
  if (!c) throw new ErroAprovacao('Link inválido ou desativado. Peça um link novo para a agência.');
  return c;
}

type Assinar = (caminho: string) => Promise<string | null>;
async function linkArquivo(a: string | null, assinar?: Assinar) {
  if (!a) return null;
  if (/^https?:\/\//i.test(a)) return a;
  if (a.startsWith('storage:') && assinar) return assinar(a.slice(8));
  return null;
}

export async function listar(q: Consulta, token: unknown, assinar?: Assinar) {
  const c = await clientePorToken(q, token);
  const pend = await q(`select id, titulo, formato, data_publicacao::text, hora, legenda, arquivo, aprovacao_comentario
      from public.postagens where cliente_id = $1 and etapa = 'aprovacao' order by data_publicacao nulls last`, [c.id]);
  const recentes = await q(`select id, titulo, formato, data_publicacao::text, aprovacao, aprovacao_comentario
      from public.postagens where cliente_id = $1 and aprovacao in ('aprovado','ajustes') and etapa <> 'aprovacao'
      order by etapa_desde desc limit 10`, [c.id]);
  return {
    cliente: c.nome,
    pendentes: await Promise.all(pend.map(async (p: any) => ({
      id: p.id, titulo: p.titulo, formato: FORMATOS[p.formato] || p.formato, data: p.data_publicacao, hora: p.hora,
      legenda: p.legenda || '', arquivo: await linkArquivo(p.arquivo, assinar),
      ...(p.aprovacao_comentario ? { ajustePedidoAntes: p.aprovacao_comentario } : {}),
    }))),
    recentes: recentes.map((p: any) => ({ id: p.id, titulo: p.titulo, formato: FORMATOS[p.formato] || p.formato, data: p.data_publicacao, decisao: p.aprovacao })),
  };
}

export async function decidir(q: Consulta, b: any, agora = new Date()) {
  const c = await clientePorToken(q, b.token);
  const decisao = b.decisao === 'aprovado' ? 'aprovado' : b.decisao === 'ajustes' ? 'ajustes' : null;
  if (!decisao) throw new ErroAprovacao('Escolha aprovar ou pedir ajuste.');
  const comentario = String(b.comentario || '').trim().slice(0, 2000);
  if (decisao === 'ajustes' && !comentario) throw new ErroAprovacao('Conte o que precisa mudar.');
  const nome = String(b.nome || '').trim().slice(0, 80) || c.nome;
  const [p] = await q(`select id, titulo, etapa, eventos from public.postagens where id = $1 and cliente_id = $2`, [b.postagemId, c.id]);
  if (!p) throw new ErroAprovacao('Conteúdo não encontrado.');
  if (p.etapa !== 'aprovacao') throw new ErroAprovacao('Este conteúdo já foi respondido. Atualize a página.');

  const [aj] = await q(`select etapas from public.ajustes where id = 'principal'`);
  const E = etapasValidas(aj?.etapas);
  const i = E.findIndex(e => e.k === 'aprovacao');
  const tem = (k: string) => E.some(e => e.k === k);
  const destino = decisao === 'aprovado'
    ? (tem('agendamento') ? 'agendamento' : E[i + 1]?.k || 'publicado')
    : (tem('edicao') ? 'edicao' : E[Math.max(0, i - 1)].k);
  const ev = [...(p.eventos || []), {
    ts: agora.toISOString(), quem: nome + ' (cliente)',
    txt: decisao === 'aprovado' ? 'Aprovou' + (comentario ? ': ' + comentario : '') : 'Pediu ajuste: ' + comentario,
  }];
  await q(`update public.postagens set etapa = $2, aprovacao = $3, aprovacao_comentario = $4, eventos = $5, etapa_desde = $6
           where id = $1`, [p.id, destino, decisao, comentario || null, JSON.stringify(ev), agora.toISOString()]);
  await q(`insert into public.historico (quem, acao, detalhe) values ($1, $2, $3)`,
    [nome + ' (cliente)', decisao === 'aprovado' ? 'Cliente aprovou' : 'Cliente pediu ajuste', `${c.nome} — ${p.titulo}`]);
  return { ok: true, decisao, etapa: destino, dia: hojeSP(agora) };
}
