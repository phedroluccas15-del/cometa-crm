// Cometinha dentro do CRM.
// POST { texto }                         → resposta
// POST { audio: base64, mime }           → transcreve e responde
// POST { novaConversa: true, ... }       → começa do zero
// POST { acao: "historico" }             → mensagens da conversa de hoje

import { agenteCfg, autenticar, ErroHttp, json, metaCfg, q, servir, sttCfg } from '../_shared/servidor.ts';
import { conversaAtual, conversar, historicoLegivel } from '../_shared/agente.ts';
import { base64ParaBytes, transcrever } from '../_shared/stt.ts';
import { pode } from '../_shared/regras.ts';

servir(async req => {
  if (req.method !== 'POST') throw new ErroHttp(405, 'Use POST.');
  const perfil = await autenticar(req);
  if (!pode(perfil, 'cometinha')) throw new ErroHttp(403, 'Seu acesso não inclui o Cometinha. Peça para um administrador liberar em Equipe.');
  const corpo = await req.json().catch(() => ({}));
  const agora = new Date();

  if (corpo.acao === 'historico') {
    const conv = await conversaAtual(q, perfil.id, 'app', agora);
    return json({ conversaId: conv.id, mensagens: await historicoLegivel(q, conv.id) });
  }

  let texto = String(corpo.texto || '').trim();
  let transcricao: string | null = null;
  if (corpo.audio) {
    transcricao = await transcrever(sttCfg(), base64ParaBytes(corpo.audio), corpo.mime || 'audio/webm')
      .catch(e => { throw new ErroHttp(400, e.message); });
    if (!transcricao) throw new ErroHttp(400, 'Não deu para entender o áudio. Tente falar mais perto do microfone.');
    texto = transcricao;
  }
  if (!texto) throw new ErroHttp(400, 'Mensagem vazia.');
  if (texto.length > 4000) throw new ErroHttp(400, 'Mensagem muito longa.');

  const r = await conversar({
    ctx: { q, perfil, agora, meta: metaCfg() },
    cfg: agenteCfg(),
    texto,
    canal: 'app',
    novaConversa: !!corpo.novaConversa,
    origem: transcricao ? 'mensagem de áudio transcrita' : undefined,
  });
  return json({ ...r, transcricao });
});
