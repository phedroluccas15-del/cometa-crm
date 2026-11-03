// Link de aprovação do cliente (página aprovar.html). Sem login: vale o código do link.
// POST { token }                                         → o que está esperando aprovação
// POST { token, postagemId, decisao, comentario, nome }  → aprovado | ajustes
// Precisa de verify_jwt = false (ver supabase/config.toml).

import { assinarArquivo as assinar, ErroHttp, json, q, servir } from '../_shared/servidor.ts';
import { decidir, ErroAprovacao, listar } from '../_shared/aprovacao.ts';

servir(async req => {
  if (req.method !== 'POST') throw new ErroHttp(405, 'Use POST.');
  const b = await req.json().catch(() => ({}));
  try {
    if (b.decisao) return json(await decidir(q, b));
    return json(await listar(q, b.token, assinar));
  } catch (e) {
    if (e instanceof ErroAprovacao) throw new ErroHttp(400, e.message);
    throw e;
  }
});
