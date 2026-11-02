// Regras comuns do Cometa usadas no servidor (Cometinha, Meta, WhatsApp).
// Sem dependências: roda igual no Supabase (Deno) e nos testes (Node).

/** executa SQL com parâmetros $1, $2… e devolve as linhas */
export type Consulta = (texto: string, params?: unknown[]) => Promise<any[]>;

export type Perfil = {
  id: string;
  nome: string;
  papel: string;
  permissoes: Record<string, boolean>;
  ativo: boolean;
  whatsapp?: string | null;
};

/** mesma lista da tela (index.html › PERMISSOES) */
export const PERMISSOES = [
  'ver_geral', 'ver_clientes', 'ver_agenda', 'ver_compromissos', 'criar_compromisso',
  'lancar', 'concluir', 'excluir_atividade', 'editar_clientes', 'ver_financeiro',
  'editar_financeiro', 'ajustes', 'meta_ver', 'meta_editar', 'cometinha',
] as const;

export const pode = (p: Perfil, k: string) =>
  !!p && p.ativo && (p.papel === 'admin' || p.permissoes?.[k] === true);

export async function carregarPerfil(q: Consulta, id: string): Promise<Perfil | null> {
  const r = await q('select id, nome, papel, permissoes, ativo, whatsapp from public.perfis where id = $1', [id]);
  if (!r[0] || !r[0].ativo) return null;
  return { ...r[0], permissoes: r[0].permissoes || {} };
}

// ---------- texto ----------
export const normalizar = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

type ComNome = { id: string; nome: string };

/**
 * Acha pelo nome falado/escrito ("kioto", "sim pneu", "a do poke").
 * Devolve 1 item quando tem certeza, vários quando está em dúvida, ou nenhum.
 */
export function acharPorNome<T extends ComNome>(lista: T[], busca: string): T[] {
  const b = normalizar(busca);
  if (!b) return [];
  const exatos = lista.filter(x => normalizar(x.nome) === b);
  if (exatos.length) return exatos;
  // "kyoto sushi" prefere "Kyoto Sushi Centro" a "Kyoto"
  const nomeContemBusca = lista.filter(x => normalizar(x.nome).includes(b));
  if (nomeContemBusca.length) return nomeContemBusca;
  const buscaContemNome = lista.filter(x => b.includes(normalizar(x.nome)));
  if (buscaContemNome.length) return buscaContemNome;
  // palavras em comum (ignora palavras curtas tipo "da", "do")
  const palavras = b.split(' ').filter(w => w.length > 2);
  const porPalavra = lista.filter(x => {
    const n = normalizar(x.nome).split(' ');
    return palavras.some(w => n.some(p => p.startsWith(w) || w.startsWith(p) || distancia(p, w) <= 1));
  });
  if (porPalavra.length) return porPalavra;
  // erro de digitação/transcrição ("kioto" → "kyoto")
  return lista.filter(x => distancia(normalizar(x.nome), b) <= Math.max(1, Math.floor(b.length / 4)));
}

function distancia(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let ant = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    ant = cur;
  }
  return ant[n];
}

// ---------- datas (sempre no horário de Brasília) ----------
const FUSO = 'America/Sao_Paulo';

export function hojeSP(agora: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(agora);
  const v = (t: string) => p.find(x => x.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}

export function horaSP(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' }).format(agora);
}

export function somaDias(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const diasEntre = (de: string, ate: string) =>
  Math.round((Date.parse(ate + 'T12:00:00Z') - Date.parse(de + 'T12:00:00Z')) / 864e5);

const SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const diaDaSemana = (iso: string) => SEMANA[new Date(iso + 'T12:00:00Z').getUTCDay()];

export function dataBR(iso: string | null | undefined): string {
  if (!iso) return 'sem data';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

export const ehDataISO = (s: unknown) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z'));

/** "Todo dia" etc. — mesmos valores que a tela grava em atividades.recorrencia */
export const RECORRENCIA: Record<string, string | null> = {
  nao: null, diario: '1', semanal: '7', quinzenal: '14', mensal: '30',
};
export const NOME_RECORRENCIA: Record<string, string> = {
  '1': 'todo dia', '7': 'toda semana', '14': 'a cada 15 dias', '30': 'todo mês',
};

// ---------- telefone ----------
/**
 * Chave para comparar números do Brasil com ou sem 55 e com ou sem o 9 extra
 * (o WhatsApp às vezes manda 553599710xxxx, sem o 9).
 * Resultado: DDD + 8 últimos dígitos. Ex.: "(35) 99710-4614" → "3597104614".
 */
export function chaveTelefone(t: unknown): string {
  let d = String(t ?? '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3);
  return d.length === 10 ? d : '';
}
