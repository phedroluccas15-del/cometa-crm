// Peças que só existem no servidor do Supabase (Deno): banco, login, OpenAI.

import postgres from 'npm:postgres@3.4.5';
import { carregarPerfil, type Consulta, type Perfil } from './regras.ts';
import type { ChamarModelo } from './agente.ts';
import { responder } from './whatsapp.ts';

export const env = (k: string, padrao = '') => Deno.env.get(k) ?? padrao;

// ---------- banco ----------
let sqlGlobal: ReturnType<typeof postgres> | null = null;
export const q: Consulta = async (texto, params = []) => {
  sqlGlobal ??= postgres(env('SUPABASE_DB_URL'), { prepare: false, max: 3, idle_timeout: 20 });
  return await sqlGlobal.unsafe(texto, params as any[]) as any[];
};

// ---------- HTTP ----------
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
export const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export class ErroHttp extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

/** quem está chamando (pelo login do site) */
export async function autenticar(req: Request): Promise<Perfil> {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tok) throw new ErroHttp(401, 'Faça login de novo.');
  const r = await fetch(env('SUPABASE_URL') + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + tok, apikey: env('SUPABASE_ANON_KEY') },
  });
  if (!r.ok) throw new ErroHttp(401, 'Sessão expirada. Faça login de novo.');
  const u = await r.json();
  const p = await carregarPerfil(q, u.id);
  if (!p) throw new ErroHttp(403, 'Acesso desativado.');
  return p;
}

// ---------- OpenAI ----------
export const chamarOpenAI: ChamarModelo = async corpo => {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY'), 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('openai', r.status, JSON.stringify(j).slice(0, 500));
    throw new ErroHttp(502, r.status === 429 ? 'A OpenAI pediu para esperar um pouco. Tente de novo em instantes.'
      : r.status === 401 ? 'Chave da OpenAI inválida (OPENAI_API_KEY).' : 'A OpenAI não respondeu direito. Tente de novo.');
  }
  return j;
};

export const metaCfg = () => ({ tokenPadrao: env('META_TOKEN'), versao: env('META_GRAPH_VERSION', 'v25.0') });
export const sttCfg = () => ({ chave: env('STT_KEY') || env('OPENAI_API_KEY'), url: env('STT_URL') || undefined, modelo: env('STT_MODEL') || undefined });
export const agenteCfg = () => ({
  chamar: chamarOpenAI,
  modelo: env('OPENAI_MODEL') || undefined,
  esforco: env('OPENAI_EFFORT') || undefined,
});

/** manda WhatsApp pelo chip do Cometinha (Evolution); null se ainda não foi configurada */
export function enviarPelaEvolution() {
  const url = env('EVO_URL'), chave = env('EVO_KEY'), instancia = env('EVO_INSTANCIA');
  if (!url || !chave || !instancia) return null;
  return (numero: string, texto: string) => responder({ url, chave, instancia }, numero.replace(/\D/g, ''), texto);
}

/** envolve a função com CORS e transforma erros em resposta legível */
export function servir(fn: (req: Request) => Promise<Response>) {
  Deno.serve(async req => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try { return await fn(req); }
    catch (e) {
      if (e instanceof ErroHttp) return json({ erro: e.message }, e.status);
      console.error(e);
      return json({ erro: 'Erro no servidor. Tente de novo.' }, 500);
    }
  });
}
