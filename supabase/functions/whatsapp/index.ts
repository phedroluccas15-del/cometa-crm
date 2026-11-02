// Cometinha no WhatsApp, pela Evolution API.
// A Evolution chama esta função a cada mensagem que chega no chip do Cometinha.
// Só responde números cadastrados em Equipe com a permissão do Cometinha.
//
// Configure na Evolution o webhook da instância apontando para:
//   https://SEU-PROJETO.supabase.co/functions/v1/whatsapp?segredo=EVO_SEGREDO
// com o evento MESSAGES_UPSERT ligado.
// Esta função precisa de verify_jwt = false (ver supabase/config.toml).

import { agenteCfg, env, metaCfg, q, sttCfg } from '../_shared/servidor.ts';
import { conversar } from '../_shared/agente.ts';
import { base64ParaBytes, transcrever } from '../_shared/stt.ts';
import { carregarPerfil, chaveTelefone, normalizar, pode, type Perfil } from '../_shared/regras.ts';
import { baixarAudio, digitando, extrairMensagens, iguais, responder, type EvoCfg, type MsgRecebida } from '../_shared/whatsapp.ts';

const evo = (): EvoCfg => ({ url: env('EVO_URL'), chave: env('EVO_KEY'), instancia: env('EVO_INSTANCIA') });

async function quemE(numero: string): Promise<Perfil | null> {
  const chave = chaveTelefone(numero);
  if (!chave) return null;
  const r = await q(`select id, whatsapp from public.perfis where ativo and whatsapp is not null`);
  const achado = r.find((p: any) => chaveTelefone(p.whatsapp) === chave);
  return achado ? await carregarPerfil(q, achado.id) : null;
}

async function atender(m: MsgRecebida) {
  const c = evo();
  const perfil = await quemE(m.numero);
  if (!perfil) { console.log('whatsapp: número fora da equipe ignorado', m.numero.slice(0, 4) + '…'); return; }
  if (!pode(perfil, 'cometinha')) {
    await responder(c, m.jid, 'Oi! Seu acesso ainda não inclui o Cometinha. Peça para um administrador liberar em Equipe.');
    return;
  }
  await digitando(c, m);
  try {
    let texto = (m.texto || '').trim();
    let origem: string | undefined;
    if (m.tipo === 'audio') {
      const a = await baixarAudio(c, m);
      texto = await transcrever(sttCfg(), base64ParaBytes(a.base64), a.mime);
      origem = 'mensagem de áudio transcrita';
      if (!texto) { await responder(c, m.jid, 'Não consegui entender o áudio. Pode mandar de novo?'); return; }
    }
    if (!texto) { await responder(c, m.jid, 'Por enquanto eu entendo texto e áudio. Me manda por um desses?'); return; }
    const nova = ['/nova', 'nova conversa', 'comecar de novo', 'começar de novo'].includes(normalizar(texto));
    if (nova) texto = 'Comecei uma conversa nova com você. Me cumprimente em uma linha.';
    const r = await conversar({
      ctx: { q, perfil, agora: new Date(), meta: metaCfg() },
      cfg: agenteCfg(), texto, canal: 'whatsapp', novaConversa: nova, origem,
    });
    await responder(c, m.jid, r.resposta);
  } catch (e) {
    console.error('whatsapp atender', e);
    await responder(c, m.jid, 'Deu um problema aqui do meu lado. Tenta de novo em um minuto?').catch(() => {});
  }
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('ok');
  const segredo = new URL(req.url).searchParams.get('segredo') || req.headers.get('x-cometa-segredo') || '';
  if (!iguais(segredo, env('EVO_SEGREDO'))) return new Response('não autorizado', { status: 401 });

  let corpo: any = null;
  try { corpo = await req.json(); } catch { return new Response('ok'); }

  const tarefas: Promise<unknown>[] = [];
  for (const m of extrairMensagens(corpo)) {
    // se a Evolution reenviar a mesma mensagem, responde uma vez só
    const novo = await q(`insert into public.whatsapp_processadas (id) values ($1) on conflict do nothing returning id`, [m.id]);
    if (novo.length) tarefas.push(atender(m));
  }
  // responde "ok" na hora e continua trabalhando em segundo plano
  const tudo = Promise.allSettled(tarefas);
  // @ts-ignore EdgeRuntime existe no Supabase
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(tudo); else await tudo;
  return new Response('ok');
});
