// Publicação automática: pega os posts em "Agendamento" com "publicar sozinho" ligado
// e publica no Instagram e/ou Facebook do cliente quando chega o dia e a hora.
// Roda pela rotina "publicar" (a cada 5 min) ou pelo botão "Publicar agora".

import { hojeSP, type Consulta } from './regras.ts';
import * as meta from './meta.ts';

export type DepsPub = {
  q: Consulta;
  agora: Date;
  meta?: { tokenPadrao?: string; versao?: string; fetch?: typeof fetch };
  /** link público temporário para um arquivo do Storage ("storage:caminho") */
  assinar?: (caminho: string) => Promise<string | null>;
  enviar?: ((numero: string, texto: string) => Promise<void>) | null;
};

const COLS = `p.id, p.titulo, p.formato, p.legenda, p.arquivo, p.midias, p.destinos, p.pub_container, p.pub_status,
  p.pub_tentativas, p.eventos, p.responsavel, p.etapa, p.publicar_auto, p.data_publicacao::text as data_publicacao, p.hora,
  c.id as cliente_id, c.nome as cliente, c.meta_pagina_id, c.resp_social`;

/** dia + hora de Brasília → instante (o Brasil não tem mais horário de verão) */
export const momento = (data: string, hora?: string | null) => new Date(`${data}T${/^\d{2}:\d{2}$/.test(hora || '') ? hora : '09:00'}:00-03:00`);

export function tipoPub(formato: string, n: number, primeiroVideo: boolean): meta.TipoPub {
  if (formato === 'stories') return 'stories';
  if (formato === 'reels' || formato === 'video') return 'reels';
  if (formato === 'carrossel' || n > 1) return 'carrossel';
  return primeiroVideo ? 'reels' : 'imagem';
}

async function tokenDe(d: DepsPub, clienteId: string) {
  let r: any[] = [];
  try { r = await d.q(`select token from privado.meta_tokens where cliente_id = $1`, [clienteId]); } catch { /* sem cofre */ }
  return r[0]?.token || d.meta?.tokenPadrao || '';
}

async function urlsDe(d: DepsPub, p: any): Promise<string[]> {
  const lista: string[] = (Array.isArray(p.midias) && p.midias.length ? p.midias : [p.arquivo]).filter(Boolean);
  const urls: string[] = [];
  for (const a of lista) {
    if (String(a).startsWith('storage:')) {
      const u = d.assinar ? await d.assinar(String(a).slice(8)) : null;
      if (!u) throw new Error('Não consegui gerar o link do arquivo enviado. Tente de novo.');
      urls.push(u);
    } else if (/^https?:\/\//i.test(a)) {
      if (/drive\.google|dropbox\.com|wetransfer|onedrive|1drv\.ms/i.test(a))
        throw new Error('Link do Drive/WeTransfer não serve para publicar: envie o arquivo pelo botão "enviar" do CRM.');
      urls.push(a);
    }
  }
  if (!urls.length) throw new Error('Falta o arquivo (imagem ou vídeo) para publicar. Envie pelo CRM.');
  return urls;
}

async function avisarErro(d: DepsPub, p: any, msg: string) {
  if (!d.enviar) return;
  const quem = p.responsavel || p.resp_social;
  const equipe = await d.q(`select nome, papel, whatsapp from public.perfis where ativo and whatsapp is not null`);
  const alvo = equipe.filter((x: any) => x.nome === quem);
  for (const x of (alvo.length ? alvo : equipe.filter((x: any) => x.papel === 'admin')))
    await d.enviar(x.whatsapp, `⚠️ *Não consegui publicar* o post "${p.titulo}" de *${p.cliente}*.\n\n${msg}\n\nAbra o post no CRM para corrigir e tentar de novo.`).catch(() => {});
}

/** publica (ou avança) uma postagem. Devolve o que aconteceu. */
export async function processar(d: DepsPub, p: any, manual = false): Promise<'publicado' | 'processando' | 'erro' | 'ocupado'> {
  // trava: duas rodadas ao mesmo tempo nunca publicam o mesmo post duas vezes
  const pode = manual ? `coalesce(pub_status,'') in ('','processando','erro')` : `coalesce(pub_status,'') in ('','processando')`;
  const trava = await d.q(`update public.postagens set pub_status = 'publicando', pub_desde = $2
      where id = $1 and etapa <> 'publicado' and ${pode} returning id`, [p.id, d.agora.toISOString()]);
  if (!trava.length) return 'ocupado';

  const cont: any = { ...(p.pub_container || {}) };
  const destinos: string[] = Array.isArray(p.destinos) && p.destinos.length ? p.destinos : ['instagram'];
  const salvar = (campos: string, vals: unknown[]) =>
    d.q(`update public.postagens set ${campos}, pub_container = $2 where id = $1`, [p.id, JSON.stringify(cont), ...vals]);
  try {
    if (!p.meta_pagina_id) throw new Error('Cliente sem página do Facebook/Instagram ligada. Ligue na ficha, em "Anúncios".');
    const token = await tokenDe(d, p.cliente_id);
    if (!token) throw new Error('A integração com a Meta ainda não foi ligada (falta a chave no servidor).');
    const base = { token, versao: d.meta?.versao, fetch: d.meta?.fetch };
    const acc = await meta.acessoPagina(base, p.meta_pagina_id);
    const cfg = { ...base, token: acc.pageToken };
    const urls = await urlsDe(d, p);
    const tipo = tipoPub(p.formato, urls.length, meta.ehVideoUrl(urls[0]));
    const legenda = String(p.legenda || '').slice(0, 2200);

    if (destinos.includes('instagram') && !cont.igPublicado) {
      if (!acc.igId) throw new Error('A página deste cliente não tem Instagram profissional ligado.');
      if (!cont.ig) cont.ig = await meta.criarContainerIG(cfg, acc.igId, tipo, urls, legenda);
      const st = await meta.statusContainer(cfg, cont.ig);
      if (st.codigo === 'IN_PROGRESS') {
        await salvar(`pub_status = 'processando', pub_erro = null`, []);
        return 'processando';
      }
      if (st.codigo !== 'FINISHED' && st.codigo !== 'PUBLISHED') {
        delete cont.ig; // na próxima tentativa cria de novo
        throw new Error('O Instagram recusou o arquivo (' + (st.detalhe || st.codigo) + '). Confira formato e tamanho.');
      }
      cont.igPublicado = await meta.publicarContainerIG(cfg, acc.igId, cont.ig);
      await salvar(`pub_status = 'publicando'`, []); // guarda já: se o Facebook falhar, não repete o Instagram
    }
    if (destinos.includes('facebook') && !cont.fb) {
      cont.fb = await meta.publicarFB(cfg, p.meta_pagina_id, tipo, urls, legenda);
    }
    const link = cont.igPublicado?.link || cont.fb?.link || null;
    const onde = [cont.igPublicado ? 'Instagram' : '', cont.fb ? 'Facebook' : ''].filter(Boolean).join(' e ');
    const ev = [...(p.eventos || []), { ts: d.agora.toISOString(), quem: 'Sistema', txt: `Publicado no ${onde}` + (manual ? ' (publicar agora)' : '') }];
    await salvar(`etapa = 'publicado', pub_status = 'publicado', pub_erro = null, link_publicado = coalesce($3, link_publicado),
                  publicado_em = $4, etapa_desde = $4, eventos = $5`, [link, d.agora.toISOString(), JSON.stringify(ev)]);
    await d.q(`insert into public.historico (quem, acao, detalhe) values ('Sistema', 'Publicou post', $1)`, [`${p.cliente} — ${p.titulo} (${onde})`]);
    return 'publicado';
  } catch (e) {
    const msg = e instanceof meta.MetaErro || e instanceof Error ? e.message : String(e);
    const ev = [...(p.eventos || []), { ts: d.agora.toISOString(), quem: 'Sistema', txt: 'Erro ao publicar: ' + msg }];
    await salvar(`pub_status = 'erro', pub_erro = $3, pub_tentativas = pub_tentativas + 1, eventos = $4`, [msg, JSON.stringify(ev)]);
    await avisarErro(d, p, msg);
    return 'erro';
  }
}

/** rodada automática: publica tudo que já chegou na hora */
export async function publicarPendentes(d: DepsPub) {
  // segurança: se uma rodada travou no meio ("publicando" há mais de 15 min), não arrisca publicar duas vezes
  await d.q(`update public.postagens set pub_status = 'erro',
      pub_erro = 'A publicação foi interrompida no meio. Confira no Instagram/Facebook se saiu antes de tentar de novo.'
      where pub_status = 'publicando' and pub_desde < $1`, [new Date(d.agora.getTime() - 15 * 60e3).toISOString()]);
  const lista = await d.q(`select ${COLS} from public.postagens p join public.clientes c on c.id = p.cliente_id
      where p.etapa = 'agendamento' and p.publicar_auto and c.status <> 'pausado'
        and coalesce(p.pub_status,'') in ('','processando') and p.data_publicacao <= $1
      order by p.data_publicacao, p.hora nulls first`, [hojeSP(d.agora)]);
  const r = { na_fila: lista.length, publicadas: 0, processando: 0, erros: 0 };
  for (const p of lista) {
    if (momento(p.data_publicacao, p.hora) > d.agora) continue;
    const s = await processar(d, p);
    if (s === 'publicado') r.publicadas++;
    if (s === 'processando') r.processando++;
    if (s === 'erro') r.erros++;
  }
  return r;
}

/** botão "Publicar agora" */
export async function publicarAgora(d: DepsPub, postagemId: string) {
  const [p] = await d.q(`select ${COLS} from public.postagens p join public.clientes c on c.id = p.cliente_id where p.id = $1`, [postagemId]);
  if (!p) throw new Error('Postagem não encontrada.');
  if (p.etapa === 'publicado') throw new Error('Esta postagem já está publicada.');
  const s = await processar(d, p, true);
  const [n] = await d.q(`select pub_status, pub_erro, link_publicado from public.postagens where id = $1`, [postagemId]);
  return { resultado: s, status: n.pub_status, erro: n.pub_erro, link: n.link_publicado };
}
