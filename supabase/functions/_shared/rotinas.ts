// Rotinas automáticas (rodam sozinhas pelo agendador do Supabase, ou pelo botão "verificar agora"):
//   monitor      confere as contas de anúncio e grava alertas fora do padrão
//   bom_dia      manda no WhatsApp de cada pessoa o que ela tem para hoje
//   materiais    lembra o cliente do material pendente (só se ligado em Ajustes)
//   publicacoes  confere no Instagram se o que estava agendado saiu e marca como publicado
//
// Tudo recebe as dependências por parâmetro, para dar para testar sem internet.

import { chaveTelefone, dataBR, hojeSP, horaSP, somaDias, type Consulta } from './regras.ts';
import * as meta from './meta.ts';
import {
  analisarAnuncios, chaveAlerta, donoAtual, etapasValidas, prazosEtapas, situacao, type Alerta, type Postagem,
} from './producao.ts';

/** colunas da postagem com as datas em texto (o driver do servidor devolveria Date) */
export const COLS_POST = `p.id, p.cliente_id, p.titulo, p.formato, p.etapa, p.data_publicacao::text as data_publicacao, p.hora,
  p.prioridade, p.responsavel, p.captador, p.editor, p.revisor, p.data_gravacao::text as data_gravacao, p.aprovacao`;

export type Deps = {
  q: Consulta;
  agora: Date;
  meta?: { tokenPadrao?: string; versao?: string; fetch?: typeof fetch };
  /** manda WhatsApp pelo chip do Cometinha; null = Evolution não configurada */
  enviar?: ((numero: string, texto: string) => Promise<void>) | null;
};

async function ajustes(q: Consulta) {
  const [a] = await q(`select etapas, config from public.ajustes where id = 'principal'`);
  return { etapas: etapasValidas(a?.etapas), config: (a?.config || {}) as Record<string, any> };
}

async function tokenDe(d: Deps, clienteId: string) {
  let r: any[] = [];
  try { r = await d.q(`select token from privado.meta_tokens where cliente_id = $1`, [clienteId]); } catch { /* sem cofre */ }
  return r[0]?.token || d.meta?.tokenPadrao || '';
}

// ---------------- monitor de anúncios ----------------
export async function monitor(d: Deps) {
  const hoje = hojeSP(d.agora);
  const { config } = await ajustes(d.q);
  const clientes = await d.q(`select id, nome, meta_conta_id, resp_trafego, servicos,
      meta_orcamento_dia::float, meta_cpl_max::float, meta_resultados_dia::float
      from public.clientes where status <> 'pausado' order by nome`);
  const novos: (Alerta & { cliente: string; cliente_id: string; resp: string | null })[] = [];
  const erros: string[] = [];
  let verificados = 0;

  const gravar = async (c: any, a: Alerta) => {
    const r = await d.q(`insert into public.alertas_anuncios (cliente_id, tipo, gravidade, campanha, texto, chave)
        values ($1,$2,$3,$4,$5,$6) on conflict (chave) do nothing returning id`,
      [c.id, a.tipo, a.gravidade, a.campanha || null, a.texto, chaveAlerta(c.id, a, hoje)]);
    if (r.length) novos.push({ ...a, cliente: c.nome, cliente_id: c.id, resp: c.resp_trafego || null });
  };

  for (const c of clientes) {
    const temTrafego = (c.servicos || []).some((s: string) => /tr[aá]fego/i.test(s));
    // cliente com tráfego contratado mas sem conta ligada = sem acompanhamento
    if (!c.meta_conta_id) {
      if (temTrafego) await gravar(c, { tipo: 'sem_conta', gravidade: 'media', texto: 'Tem tráfego pago contratado, mas nenhuma conta de anúncio ligada no CRM.' });
      continue;
    }
    const token = await tokenDe(d, c.id);
    if (!token) { erros.push(`${c.nome}: sem chave da Meta`); continue; }
    const cfg = { token, versao: d.meta?.versao, fetch: d.meta?.fetch };
    try {
      const [ontem, semana, anterior] = await Promise.all([
        meta.resumo(cfg, c.meta_conta_id, 'ontem'),
        meta.resumo(cfg, c.meta_conta_id, '7d'),
        meta.totaisIntervalo(cfg, c.meta_conta_id, somaDias(hoje, -14), somaDias(hoje, -8)).catch(() => null),
      ]);
      verificados++;
      for (const a of analisarAnuncios(c, { ontem, semana, semanaAnterior: anterior })) await gravar(c, a);
    } catch (e) {
      erros.push(`${c.nome}: ${(e as Error).message}`);
    }
  }

  // conta ligada, mas ninguém concluiu nada de tráfego há 15 dias
  const parados = await d.q(`select c.id, c.nome, c.resp_trafego from public.clientes c
     where c.status <> 'pausado' and c.meta_conta_id is not null
       and not exists (select 1 from public.atividades a where a.cliente_id = c.id
                        and a.feita_em > now() - interval '15 days' and a.titulo ilike '%tr_fego%')`);
  for (const c of parados) await gravar(c, { tipo: 'sem_acompanhamento', gravidade: 'baixa',
    texto: 'Nenhuma atividade de tráfego concluída nos últimos 15 dias.' });

  // avisa no WhatsApp (responsável pelo tráfego do cliente, ou os administradores)
  let avisados = 0;
  if (d.enviar && config.alerta_whatsapp !== false && novos.some(n => n.gravidade !== 'baixa')) {
    const equipe = await d.q(`select nome, papel, whatsapp from public.perfis where ativo and whatsapp is not null`);
    const grupos = new Map<string, string[]>();
    for (const n of novos.filter(n => n.gravidade !== 'baixa')) {
      const alvo = equipe.filter((p: any) => n.resp ? p.nome === n.resp : p.papel === 'admin');
      for (const p of (alvo.length ? alvo : equipe.filter((p: any) => p.papel === 'admin'))) {
        const l = grupos.get(p.whatsapp) || [];
        l.push(`• *${n.cliente}*: ${n.texto}`);
        grupos.set(p.whatsapp, l);
      }
    }
    for (const [numero, linhas] of grupos) {
      await d.enviar(numero, `🚨 *Anúncios fora do padrão*\n\n${linhas.join('\n')}\n\nDetalhes no CRM, aba Tráfego.`).catch(e => erros.push(String(e)));
      avisados++;
    }
  }
  return { verificados, novos: novos.length, alertas: novos.map(n => `${n.cliente}: ${n.texto}`), avisados, erros };
}

// ---------------- bom dia (resumo do dia de cada pessoa) ----------------
export async function bomDia(d: Deps) {
  if (!d.enviar) return { enviados: 0, motivo: 'WhatsApp (Evolution) não configurado' };
  const hoje = hojeSP(d.agora);
  const { etapas, config } = await ajustes(d.q);
  if (config.bom_dia_whatsapp === false) return { enviados: 0, motivo: 'desligado em Ajustes' };
  const pessoas = await d.q(`select nome, papel, whatsapp from public.perfis where ativo and whatsapp is not null`);
  const tarefas = await d.q(`select a.titulo, a.data::text, a.responsavel, c.nome cliente from public.atividades a
      join public.clientes c on c.id = a.cliente_id where a.feita_em is null and a.data <= $1`, [hoje]);
  const comps = await d.q(`select k.tipo, k.hora, k.local, k.responsavel, c.nome cliente from public.compromissos k
      left join public.clientes c on c.id = k.cliente_id where k.feito_em is null and k.data = $1 order by k.hora nulls last`, [hoje]);
  const posts: Postagem[] = await d.q(`select ${COLS_POST}, c.nome cliente from public.postagens p
      join public.clientes c on c.id = p.cliente_id where p.etapa <> 'publicado' and c.status <> 'pausado'`);
  const risco = Number(config.risco_dias) || 3;
  let enviados = 0;
  for (const p of pessoas) {
    const l: string[] = [];
    const minhasT = tarefas.filter((t: any) => t.responsavel === p.nome);
    const minhasP = posts.filter(x => donoAtual(x, etapas) === p.nome).filter(x => {
      const pr = prazosEtapas(x, etapas, hoje).prazos[x.etapa];
      return pr && pr <= hoje;
    });
    const meusC = comps.filter((k: any) => k.responsavel === p.nome);
    for (const k of meusC) l.push(`📍 ${k.hora || ''} ${k.tipo}${k.cliente ? ' · ' + k.cliente : ''}${k.local ? ' · ' + k.local : ''}`.trim());
    for (const x of minhasP) {
      const e = etapas.find(e => e.k === x.etapa);
      l.push(`🎬 ${(x as any).cliente} · ${x.titulo} → *${e?.nome}* (publica ${dataBR(x.data_publicacao).slice(0, 5)})`);
    }
    for (const t of minhasT) l.push(`${t.data < hoje ? '🔴' : '✅'} ${t.cliente} · ${t.titulo}${t.data < hoje ? ' (atrasada)' : ''}`);
    if (p.papel === 'admin') {
      const atras = posts.filter(x => situacao(x, etapas, hoje, risco) === 'atrasada').length;
      const emRisco = posts.filter(x => situacao(x, etapas, hoje, risco) === 'risco').length;
      const aprov = posts.filter(x => x.etapa === 'aprovacao').length;
      if (atras || emRisco || aprov) l.push(`\n📊 Agência: ${atras} postagem(ns) atrasada(s), ${emRisco} em risco, ${aprov} esperando aprovação do cliente.`);
    }
    if (!l.length) continue;
    await d.enviar(p.whatsapp, `☀️ Bom dia, ${String(p.nome).split(' ')[0]}! Seu dia:\n\n${l.join('\n')}`);
    enviados++;
  }
  return { enviados };
}

// ---------------- lembrete de materiais para o cliente ----------------
export function textoCobranca(cliente: string, itens: { descricao: string; prazo: string | null }[]) {
  return `Oi! Tudo bem? Aqui é da Cometa 🚀\n\nPara seguirmos com o conteúdo de *${cliente}*, ainda precisamos de:\n\n` +
    itens.map(i => `• ${i.descricao}${i.prazo ? ' (até ' + dataBR(i.prazo).slice(0, 5) + ')' : ''}`).join('\n') +
    `\n\nPode mandar por aqui mesmo. Obrigado!`;
}

export async function cobrarMateriais(d: Deps, forcar = false) {
  if (!d.enviar) return { enviados: 0, motivo: 'WhatsApp (Evolution) não configurado' };
  const { config } = await ajustes(d.q);
  if (!forcar && !config.lembrete_materiais_auto) return { enviados: 0, motivo: 'lembrete automático desligado em Ajustes' };
  const hoje = hojeSP(d.agora);
  const pend = await d.q(`select m.id, m.descricao, m.prazo::text, c.id cliente_id, c.nome, c.contato
      from public.materiais m join public.clientes c on c.id = m.cliente_id
     where m.recebido_em is null and c.status <> 'pausado' and coalesce(c.contato, '') <> ''
       and (m.prazo is null or m.prazo <= $1)
       and (m.ultimo_lembrete is null or m.ultimo_lembrete < now() - interval '2 days')`, [somaDias(hoje, 1)]);
  const porCliente = new Map<string, any[]>();
  for (const m of pend) porCliente.set(m.cliente_id, [...(porCliente.get(m.cliente_id) || []), m]);
  let enviados = 0;
  for (const itens of porCliente.values()) {
    const c = itens[0];
    if (!chaveTelefone(c.contato)) continue;
    let num = String(c.contato).replace(/\D/g, '');
    if (num.length <= 11) num = '55' + num;
    await d.enviar(num, textoCobranca(c.nome, itens));
    await d.q(`update public.materiais set ultimo_lembrete = now(), lembretes = lembretes + 1 where id = any($1)`, [itens.map(i => i.id)]);
    enviados++;
  }
  return { enviados };
}

// ---------------- confere publicações agendadas ----------------
export async function conferirPublicacoes(d: Deps) {
  const hoje = hojeSP(d.agora);
  const posts = await d.q(`select p.id, p.titulo, p.data_publicacao::text, p.eventos, c.id cliente_id, c.nome, c.meta_pagina_id
      from public.postagens p join public.clientes c on c.id = p.cliente_id
     where p.etapa = 'agendamento' and p.data_publicacao <= $1 and p.data_publicacao >= $2 and c.meta_pagina_id is not null`,
    [hoje, somaDias(hoje, -3)]);
  let marcados = 0;
  const porPagina = new Map<string, any[]>();
  for (const p of posts) porPagina.set(p.cliente_id, [...(porPagina.get(p.cliente_id) || []), p]);
  for (const lista of porPagina.values()) {
    const c = lista[0];
    const token = await tokenDe(d, c.cliente_id);
    if (!token) continue;
    let itens: any[] = [];
    try { itens = (await meta.publicacoes({ token, versao: d.meta?.versao, fetch: d.meta?.fetch }, c.meta_pagina_id, 12)).itens; }
    catch { continue; }
    const usados = new Set((await d.q(`select link_publicado from public.postagens where cliente_id = $1 and link_publicado is not null`,
      [c.cliente_id])).map((r: any) => r.link_publicado));
    for (const p of lista) {
      const achado = itens.find(i => i.data && hojeSP(new Date(i.data)) === p.data_publicacao && i.link && !usados.has(i.link));
      if (!achado) continue;
      usados.add(achado.link);
      const ev = [...(p.eventos || []), { ts: d.agora.toISOString(), quem: 'Sistema', txt: 'Publicação confirmada no Instagram/Facebook' }];
      await d.q(`update public.postagens set etapa = 'publicado', link_publicado = $2, publicado_em = $3, etapa_desde = now(), eventos = $4
                 where id = $1`, [p.id, achado.link, achado.data, JSON.stringify(ev)]);
      marcados++;
    }
  }
  return { conferidas: posts.length, marcados, hora: horaSP(d.agora) };
}
