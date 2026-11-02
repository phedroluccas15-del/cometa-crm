// Link de aprovação do cliente (página aprovar.html). Sem login: vale o código do link.
// POST { token }                                         → o que está esperando aprovação
// POST { token, postagemId, decisao, comentario, nome }  → aprovado | ajustes
// Precisa de verify_jwt = false (ver supabase/config.toml).

import { env, ErroHttp, json, q, servir } from '../_shared/servidor.ts';
import { decidir, ErroAprovacao, listar } from '../_shared/aprovacao.ts';

/** link temporário (2 dias) para o cliente ver o arquivo guardado no Storage */
async function assinar(caminho: string): Promise<string | null> {
  const base = env('SUPABASE_URL');
  const r = await fetch(`${base}/storage/v1/object/sign/arquivos/${caminho.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env('SUPABASE_SERVICE_ROLE_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 60 * 60 * 48 }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.signedURL ? base + '/storage/v1' + j.signedURL : null;
}

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
