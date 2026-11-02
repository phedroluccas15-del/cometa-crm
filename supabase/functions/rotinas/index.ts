// Rotinas automáticas. Quem chama é o agendador do Supabase (pg_cron), com o segredo:
//   POST https://SEU-PROJETO.supabase.co/functions/v1/rotinas?tarefa=monitor
//   cabeçalho  x-segredo: ROTINAS_SEGREDO
// tarefa = monitor | bom_dia | materiais | publicacoes
// (o agendamento pronto para colar está no LEIA-ME.md)
// Precisa de verify_jwt = false (ver supabase/config.toml).

import { enviarPelaEvolution, env, json, metaCfg, q } from '../_shared/servidor.ts';
import { iguais } from '../_shared/whatsapp.ts';
import { bomDia, cobrarMateriais, conferirPublicacoes, monitor, type Deps } from '../_shared/rotinas.ts';

Deno.serve(async req => {
  const segredo = req.headers.get('x-segredo') || new URL(req.url).searchParams.get('segredo') || '';
  if (!iguais(segredo, env('ROTINAS_SEGREDO'))) return new Response('não autorizado', { status: 401 });
  const tarefa = new URL(req.url).searchParams.get('tarefa') || '';
  const d: Deps = { q, agora: new Date(), meta: metaCfg(), enviar: enviarPelaEvolution() };
  try {
    if (tarefa === 'monitor') return json(await monitor(d));
    if (tarefa === 'bom_dia') return json(await bomDia(d));
    if (tarefa === 'materiais') return json(await cobrarMateriais(d));
    if (tarefa === 'publicacoes') return json(await conferirPublicacoes(d));
    return json({ erro: 'tarefa desconhecida' }, 400);
  } catch (e) {
    console.error('rotinas', tarefa, e);
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
