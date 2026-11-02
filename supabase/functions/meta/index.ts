// Aba "Anúncios" da ficha do cliente. A chave da Meta fica só aqui no servidor.
// POST { acao, ... }:
//   contas                                  → contas de anúncio e páginas que a Cometa acessa
//   resumo       { clienteId, periodo }     → gasto, limite, campanhas, alertas
//   conjuntos    { clienteId, campanhaId, periodo }
//   publicacoes  { clienteId }
//   alterar      { clienteId, objetoId, status?, orcamentoDiario?, nome? }
//   chave        { clienteId, token, expiraEm? }   (admin: chave própria do cliente, exceção)
//   apagar_chave { clienteId }                      (admin)
//   info_chave   { clienteId }                      (admin: só diz se existe e quando vence)
//   monitorar                                       → roda o monitor de anúncios agora (botão "verificar agora")
//   rotina       { tarefa }                         (admin: roda bom_dia, materiais ou publicacoes na hora)

import { autenticar, enviarPelaEvolution, ErroHttp, json, metaCfg, q, servir } from '../_shared/servidor.ts';
import { bomDia, cobrarMateriais, conferirPublicacoes, monitor } from '../_shared/rotinas.ts';
import * as meta from '../_shared/meta.ts';
import { pode, type Perfil } from '../_shared/regras.ts';
import { tokenMeta } from '../_shared/ferramentas.ts';

const exigir = (p: Perfil, k: string) => { if (!pode(p, k)) throw new ErroHttp(403, 'Sem permissão para isso.'); };

async function cliente(id: string) {
  const [c] = await q(`select id, nome, meta_conta_id, meta_pagina_id from public.clientes where id = $1`, [id]);
  if (!c) throw new ErroHttp(404, 'Cliente não encontrado.');
  return c;
}

servir(async req => {
  if (req.method !== 'POST') throw new ErroHttp(405, 'Use POST.');
  const perfil = await autenticar(req);
  const b = await req.json().catch(() => ({}));
  const base = metaCfg();
  const ctx = { q, perfil, agora: new Date(), meta: base };
  const cfgDe = async (clienteId: string) => ({ token: await tokenMeta(ctx, clienteId), versao: base.versao });

  try {
    switch (b.acao) {
      case 'contas': {
        exigir(perfil, 'editar_clientes');
        if (!base.tokenPadrao) throw new ErroHttp(400, 'A chave da Cometa ainda não foi colocada no servidor (META_TOKEN).');
        return json(await meta.listarContas({ token: base.tokenPadrao, versao: base.versao }));
      }
      case 'resumo': {
        exigir(perfil, 'meta_ver');
        const c = await cliente(b.clienteId);
        if (!c.meta_conta_id) throw new ErroHttp(400, 'Cliente sem conta de anúncio ligada.');
        return json(await meta.resumo(await cfgDe(c.id), c.meta_conta_id, b.periodo || '7d'));
      }
      case 'conjuntos': {
        exigir(perfil, 'meta_ver');
        const c = await cliente(b.clienteId);
        return json({ conjuntos: await meta.conjuntos(await cfgDe(c.id), String(b.campanhaId), b.periodo || '7d') });
      }
      case 'publicacoes': {
        exigir(perfil, 'meta_ver');
        const c = await cliente(b.clienteId);
        if (!c.meta_pagina_id) throw new ErroHttp(400, 'Cliente sem página ligada.');
        return json(await meta.publicacoes(await cfgDe(c.id), c.meta_pagina_id, 9));
      }
      case 'alterar': {
        exigir(perfil, 'meta_editar');
        const c = await cliente(b.clienteId);
        if (!c.meta_conta_id) throw new ErroHttp(400, 'Cliente sem conta de anúncio ligada.');
        const mud: meta.Alteracao = {};
        if (b.status) mud.status = b.status;
        if (b.orcamentoDiario !== undefined && b.orcamentoDiario !== null) mud.orcamentoDiario = Number(b.orcamentoDiario);
        if (b.nome !== undefined) mud.nome = b.nome;
        const r = await meta.alterar(await cfgDe(c.id), c.meta_conta_id, String(b.objetoId), mud);
        const o = [
          mud.status ? (mud.status === 'PAUSED' ? 'pausou' : 'ativou') : '',
          mud.orcamentoDiario !== undefined ? `orçamento diário ${r.antes.orcamentoDiario ?? '—'} → ${r.depois.orcamentoDiario}` : '',
          mud.nome ? `renomeou para "${mud.nome}"` : '',
        ].filter(Boolean).join(', ');
        await q(`insert into public.historico (quem, acao, detalhe) values ($1, 'Alterou campanha na Meta', $2)`,
          [perfil.nome, `${c.nome} — ${r.nomeAntes}: ${o}`]);
        return json(r);
      }
      case 'chave': {
        if (perfil.papel !== 'admin') throw new ErroHttp(403, 'Só administrador.');
        const c = await cliente(b.clienteId);
        const t = String(b.token || '').trim();
        if (t.length < 50) throw new ErroHttp(400, 'Essa chave parece incompleta.');
        // testa antes de guardar
        await meta.listarContas({ token: t, versao: base.versao });
        await q(`insert into privado.meta_tokens (cliente_id, token, expira_em) values ($1, $2, $3)
                 on conflict (cliente_id) do update set token = excluded.token, expira_em = excluded.expira_em, criado_em = now()`,
          [c.id, t, b.expiraEm || null]);
        await q(`insert into public.historico (quem, acao, detalhe) values ($1, 'Salvou chave própria da Meta', $2)`, [perfil.nome, c.nome]);
        return json({ ok: true });
      }
      case 'apagar_chave': {
        if (perfil.papel !== 'admin') throw new ErroHttp(403, 'Só administrador.');
        await q(`delete from privado.meta_tokens where cliente_id = $1`, [b.clienteId]);
        return json({ ok: true });
      }
      case 'info_chave': {
        if (perfil.papel !== 'admin') throw new ErroHttp(403, 'Só administrador.');
        const [t] = await q(`select expira_em::text, criado_em from privado.meta_tokens where cliente_id = $1`, [b.clienteId]);
        return json({ propria: !!t, expiraEm: t?.expira_em || null, padraoConfigurado: !!base.tokenPadrao });
      }
      case 'monitorar': {
        exigir(perfil, 'meta_ver');
        return json(await monitor({ q, agora: new Date(), meta: base, enviar: enviarPelaEvolution() }));
      }
      case 'rotina': {
        if (perfil.papel !== 'admin') throw new ErroHttp(403, 'Só administrador.');
        const d = { q, agora: new Date(), meta: base, enviar: enviarPelaEvolution() };
        if (b.tarefa === 'bom_dia') return json(await bomDia(d));
        if (b.tarefa === 'materiais') return json(await cobrarMateriais(d, true));
        if (b.tarefa === 'publicacoes') return json(await conferirPublicacoes(d));
        throw new ErroHttp(400, 'Rotina desconhecida.');
      }
      default:
        throw new ErroHttp(400, 'Ação desconhecida.');
    }
  } catch (e) {
    if (e instanceof meta.MetaErro) return json({ erro: e.message }, 400);
    if (e instanceof Error && !(e instanceof ErroHttp) && /integração com a Meta|não tem conta|não tem página/.test(e.message)) {
      return json({ erro: e.message }, 400);
    }
    throw e;
  }
});
