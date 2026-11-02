// Transforma áudio em texto (o modelo do Cometinha recebe texto; a transcrição vem antes).
// Usa qualquer serviço no padrão "/audio/transcriptions" (OpenAI, Groq…),
// escolhido pelas variáveis STT_URL, STT_KEY e STT_MODEL.

export type SttCfg = { url?: string; chave: string; modelo?: string; fetch?: typeof fetch };

const URL_PADRAO = 'https://api.openai.com/v1/audio/transcriptions';
const MODELO_PADRAO = 'gpt-transcribe';
const LIMITE_BYTES = 20 * 1024 * 1024; // ~20 MB (vários minutos de áudio)

const EXTENSAO: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};

export async function transcrever(cfg: SttCfg, audio: Uint8Array, mime: string): Promise<string> {
  if (!cfg.chave) throw new Error('Transcrição de áudio não configurada (falta STT_KEY).');
  if (!audio?.length) throw new Error('Áudio vazio.');
  if (audio.length > LIMITE_BYTES) throw new Error('Áudio muito longo. Mande um de até uns 10 minutos.');
  const tipo = String(mime || 'audio/ogg').split(';')[0].trim().toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([audio], { type: tipo }), 'audio.' + (EXTENSAO[tipo] || 'ogg'));
  form.append('model', cfg.modelo || MODELO_PADRAO);
  form.append('language', 'pt');
  form.append('response_format', 'json');
  const resp = await (cfg.fetch ?? fetch)(cfg.url || URL_PADRAO, {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.chave}` }, body: form,
  });
  const corpo: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Não consegui entender o áudio (' + (corpo?.error?.message || resp.status) + ').');
  return String(corpo.text || '').trim();
}

export function base64ParaBytes(b64: string): Uint8Array {
  const limpo = String(b64 || '').replace(/^data:[^,]*,/, '');
  const bin = atob(limpo);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
