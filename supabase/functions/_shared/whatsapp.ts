// WhatsApp pela Evolution API (v2): receber, baixar áudio e responder.

export type EvoCfg = {
  url: string;          // ex.: https://evolution.seudominio.com.br (sem / no fim)
  chave: string;        // apikey da Evolution
  instancia: string;    // nome da instância do chip do Cometinha
  fetch?: typeof fetch;
};

export type MsgRecebida = {
  id: string;
  jid: string;          // para onde responder (como a Evolution manda)
  numero: string;       // só dígitos, para achar a pessoa na Equipe
  tipo: 'texto' | 'audio' | 'outro';
  texto?: string;
  audioBase64?: string; // quando a Evolution já manda o áudio junto (webhook_base64)
  mime?: string;
  bruto: any;           // a mensagem original (para baixar o áudio depois)
};

const digitos = (s: unknown) => String(s ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');

/**
 * Lê o aviso que a Evolution manda no evento "messages.upsert".
 * Ignora: mensagens enviadas pelo próprio chip, grupos, status e eventos de outro tipo.
 */
export function extrairMensagens(corpo: any): MsgRecebida[] {
  const evento = String(corpo?.event || '').toLowerCase().replace(/_/g, '.');
  if (evento && evento !== 'messages.upsert') return [];
  const lista = Array.isArray(corpo?.data) ? corpo.data : corpo?.data ? [corpo.data] : [];
  const out: MsgRecebida[] = [];
  for (const d of lista) {
    const k = d?.key || {};
    const jid: string = k.remoteJid || '';
    if (!k.id || k.fromMe || !jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
    // contas com "LID" (identificador sem número): o número real vem em outro campo
    const comNumero = jid.endsWith('@lid') ? (k.senderPn || k.remoteJidAlt || k.participantPn || '') : jid;
    const m = d.message || {};
    const r: MsgRecebida = { id: k.id, jid, numero: digitos(comNumero), tipo: 'outro', bruto: d };
    const texto = m.conversation || m.extendedTextMessage?.text || m.buttonsResponseMessage?.selectedDisplayText
      || m.listResponseMessage?.title || m.templateButtonReplyMessage?.selectedDisplayText;
    if (texto) { r.tipo = 'texto'; r.texto = String(texto); }
    else if (m.audioMessage) {
      r.tipo = 'audio';
      r.mime = m.audioMessage.mimetype || 'audio/ogg';
      if (m.base64 || d.base64) r.audioBase64 = m.base64 || d.base64;
    }
    out.push(r);
  }
  return out;
}

/** WhatsApp fica ruim de ler acima de ~3.500 caracteres; quebra em parágrafos */
export function dividir(texto: string, max = 3500): string[] {
  const partes: string[] = [];
  let atual = '';
  for (const par of String(texto).split(/\n{2,}/)) {
    const bloco = atual ? atual + '\n\n' + par : par;
    if (bloco.length <= max) { atual = bloco; continue; }
    if (atual) partes.push(atual);
    let resto = par;
    while (resto.length > max) { partes.push(resto.slice(0, max)); resto = resto.slice(max); }
    atual = resto;
  }
  if (atual) partes.push(atual);
  return partes.length ? partes : [''];
}

async function evo(c: EvoCfg, caminho: string, corpo: unknown) {
  const r = await (c.fetch ?? fetch)(`${c.url.replace(/\/+$/, '')}/${caminho}/${encodeURIComponent(c.instancia)}`, {
    method: 'POST',
    headers: { apikey: c.chave, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error(`Evolution recusou ${caminho}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json().catch(() => ({}));
}

export async function responder(c: EvoCfg, para: string, texto: string) {
  for (const parte of dividir(texto)) await evo(c, 'message/sendText', { number: para, text: parte });
}

/** marca como lida e mostra "digitando…" enquanto o Cometinha pensa */
export async function digitando(c: EvoCfg, m: MsgRecebida) {
  await evo(c, 'chat/markMessageAsRead', { readMessages: [{ remoteJid: m.jid, fromMe: false, id: m.id }] }).catch(() => {});
  await evo(c, 'chat/sendPresence', { number: m.jid, presence: 'composing', delay: 15000 }).catch(() => {});
}

export async function baixarAudio(c: EvoCfg, m: MsgRecebida): Promise<{ base64: string; mime: string }> {
  if (m.audioBase64) return { base64: m.audioBase64, mime: m.mime || 'audio/ogg' };
  const r = await evo(c, 'chat/getBase64FromMediaMessage', { message: { key: { id: m.id } }, convertToMp4: false });
  if (!r?.base64) throw new Error('A Evolution não devolveu o áudio.');
  return { base64: r.base64, mime: r.mimetype || m.mime || 'audio/ogg' };
}

/** compara textos sem vazar o tempo de comparação (para o segredo do webhook) */
export function iguais(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
