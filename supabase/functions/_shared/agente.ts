// Ciclo de conversa do Cometinha (OpenAI · API "Responses"): recebe o pedido,
// deixa o modelo usar as ferramentas quantas vezes precisar e devolve a resposta.
//
// Cada item da conversa (pergunta, chamada de ferramenta, resultado, resposta)
// vira uma linha em cometinha_mensagens. Conversa nova por dia.

import { FERRAMENTAS, executar, type Ctx } from './ferramentas.ts';
import { PROMPT_COMETINHA } from './prompt.ts';
import { dataBR, diaDaSemana, hojeSP, horaSP, type Consulta } from './regras.ts';

/** manda um pedido para POST /v1/responses e devolve a resposta (trocado nos testes) */
export type ChamarModelo = (corpo: Record<string, unknown>) => Promise<any>;

export type AgenteCfg = {
  chamar: ChamarModelo;
  modelo?: string;   // OPENAI_MODEL
  esforco?: string;  // OPENAI_EFFORT (low | medium | high); vazio = padrão do modelo
};

export const MODELO_PADRAO = 'gpt-6.1-terra';
const MAX_RODADAS = 10;
const MAX_ITENS_CONVERSA = 120;
const HORAS_PARA_NOVA = 8;

type Item = Record<string, any>;

// ---------- guardar e ler a conversa ----------
const papel = (i: Item) => (i.role === 'user' || i.type === 'function_call_output') ? 'user' : 'assistant';

async function carregar(q: Consulta, conversaId: string): Promise<Item[]> {
  const r = await q(`select content from public.cometinha_mensagens where conversa_id = $1 order by id`, [conversaId]);
  return r.map((m: any) => (typeof m.content === 'string' ? JSON.parse(m.content) : m.content));
}

async function salvar(q: Consulta, conversaId: string, itens: Item[]) {
  for (const i of itens) {
    await q(`insert into public.cometinha_mensagens (conversa_id, role, content) values ($1, $2, $3::jsonb)`,
      [conversaId, papel(i), JSON.stringify(i)]);
  }
  await q(`update public.cometinha_conversas set atualizado_em = now() where id = $1`, [conversaId]);
}

/** só o que vale guardar para as próximas mensagens (o raciocínio interno fica de fora) */
function paraGuardar(i: Item): Item | null {
  if (i.type === 'reasoning') return null;
  if (i.type === 'function_call') return { type: 'function_call', call_id: i.call_id, name: i.name, arguments: i.arguments };
  if (i.type === 'message' && i.role === 'assistant') return { role: 'assistant', content: textoDe(i) };
  return i;
}

function textoDe(i: Item): string {
  if (typeof i.content === 'string') return i.content;
  return (i.content || []).filter((c: any) => c?.type === 'output_text' || c?.type === 'input_text' || c?.type === 'text')
    .map((c: any) => c.text).join('\n');
}

/** a última coisa da conversa foi uma resposta? (senão ela ficou pela metade) */
const terminouBem = (h: Item[]) => !h.length || (h[h.length - 1].role === 'assistant');

export async function conversaAtual(q: Consulta, usuarioId: string, canal: string, agora: Date, forcarNova = false) {
  if (!forcarNova) {
    const [c] = await q(`select c.id, c.atualizado_em,
          (select count(*)::int from public.cometinha_mensagens m where m.conversa_id = c.id) as n
        from public.cometinha_conversas c where c.usuario_id = $1 and c.canal = $2
        order by c.atualizado_em desc limit 1`, [usuarioId, canal]);
    if (c) {
      const ultima = new Date(c.atualizado_em);
      const mesmoDia = hojeSP(ultima) === hojeSP(agora);
      const recente = agora.getTime() - ultima.getTime() < HORAS_PARA_NOVA * 36e5;
      if (mesmoDia && recente && c.n < MAX_ITENS_CONVERSA) {
        const h = await carregar(q, c.id);
        if (terminouBem(h)) return { id: c.id as string, historico: h };
      }
    }
  }
  const [nova] = await q(`insert into public.cometinha_conversas (usuario_id, canal) values ($1, $2) returning id`, [usuarioId, canal]);
  return { id: nova.id as string, historico: [] as Item[] };
}

// ---------- confirmação de alterações na Meta ----------
/**
 * Uma alteração só vale como confirmada se o sistema já mostrou o resumo
 * (precisa_confirmar) E a pessoa mandou uma mensagem depois disso.
 */
export function confirmaveis(h: Item[]): Set<string> {
  const pendentes = new Set<string>(), ok = new Set<string>();
  for (const i of h) {
    if (i.role === 'user') { for (const k of pendentes) ok.add(k); continue; }
    if (i.type !== 'function_call_output' || typeof i.output !== 'string') continue;
    try {
      const r = JSON.parse(i.output);
      if (r?.precisa_confirmar && r.chave_confirmacao) pendentes.add(r.chave_confirmacao);
      if (r?.feito && r?.antes && r?.depois) pendentes.clear(); // já executou: precisa confirmar de novo
    } catch { /* não é JSON */ }
  }
  return ok;
}

// ---------- a conversa em si ----------
export type Pedido = {
  ctx: Ctx;
  cfg: AgenteCfg;
  texto: string;
  canal: 'app' | 'whatsapp';
  novaConversa?: boolean;
  origem?: string;
};

export async function conversar(p: Pedido) {
  const { ctx, cfg } = p;
  const conv = await conversaAtual(ctx.q, ctx.perfil.id, p.canal, ctx.agora, p.novaConversa);

  const hoje = hojeSP(ctx.agora);
  const cabecalho = `[${diaDaSemana(hoje)}, ${dataBR(hoje)}, ${horaSP(ctx.agora)} · quem fala: ${ctx.perfil.nome}` +
    ` (${ctx.perfil.papel === 'admin' ? 'administrador' : 'operador'}) · canal: ${p.canal === 'whatsapp' ? 'WhatsApp' : 'CRM'}` +
    `${p.origem ? ' · ' + p.origem : ''}]`;
  const pergunta: Item = { role: 'user', content: `${cabecalho}\n${p.texto}` };
  await salvar(ctx.q, conv.id, [pergunta]);

  const entrada: Item[] = [...conv.historico, pergunta];
  ctx.confirmaveis = confirmaveis(entrada);

  const acoes: string[] = [];
  let resposta = '';

  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    const ultimaRodada = rodada === MAX_RODADAS - 1;
    const resp = await cfg.chamar({
      model: cfg.modelo || MODELO_PADRAO,
      instructions: PROMPT_COMETINHA,
      input: entrada,
      tools: FERRAMENTAS,
      tool_choice: ultimaRodada ? 'none' : 'auto',
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(cfg.esforco ? { reasoning: { effort: cfg.esforco } } : {}),
    });
    if (resp?.usage) console.log('cometinha uso', JSON.stringify(resp.usage));

    const saida: Item[] = resp.output || [];
    entrada.push(...saida);
    const guardar = saida.map(paraGuardar).filter(Boolean) as Item[];

    const chamadas = saida.filter(i => i.type === 'function_call');
    if (!chamadas.length) {
      resposta = saida.filter(i => i.type === 'message').map(textoDe).join('\n\n').trim();
      if (!resposta) guardar.push({ role: 'assistant', content: 'Pronto.' });
      await salvar(ctx.q, conv.id, guardar);
      break;
    }

    const resultados = await Promise.all(chamadas.map(async c => {
      let args: unknown = {};
      try { args = JSON.parse(c.arguments || '{}'); } catch { args = null; }
      const r = args === null
        ? { texto: 'Os parâmetros vieram quebrados. Tente de novo.', erro: true }
        : await executar(ctx, c.name, args);
      if ((r as any).acao) acoes.push((r as any).acao);
      return { type: 'function_call_output', call_id: c.call_id, output: r.texto };
    }));
    entrada.push(...resultados);
    await salvar(ctx.q, conv.id, [...guardar, ...resultados]);
  }

  return { conversaId: conv.id, resposta: resposta || 'Pronto.', acoes };
}

/** mensagens de uma conversa em texto simples, para mostrar na tela */
export async function historicoLegivel(q: Consulta, conversaId: string) {
  const h = await carregar(q, conversaId);
  const saida: { de: 'eu' | 'cometinha'; texto: string }[] = [];
  for (const i of h) {
    if (i.role !== 'user' && i.role !== 'assistant') continue;
    let t = textoDe(i);
    if (!t) continue;
    if (i.role === 'user') t = t.replace(/^\[[^\]]*\]\n/, '');
    saida.push({ de: i.role === 'user' ? 'eu' : 'cometinha', texto: t });
  }
  return saida;
}
