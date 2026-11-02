// Um "Supabase de mentira" para testar a tela no navegador:
// o site acha que fala com o Supabase, mas cada consulta vai para o banco
// local (PGlite), com as mesmas permissões (RLS) do banco de verdade.
import { comoUsuario } from './banco.js';

/** script que substitui o supabase-js dentro da página */
export const SCRIPT_NAVEGADOR = `
(() => {
  const rodar = spec => window.__sb(JSON.stringify(spec)).then(r => JSON.parse(r));
  class Q {
    constructor(t){ this.s = { t, op: 'select', filtros: [], ordem: [], }; }
    select(){ if (this.s.op === 'select') this.s.op = 'select'; return this; }
    insert(rows){ this.s.op = 'insert'; this.s.rows = [].concat(rows); return this; }
    upsert(rows){ this.s.op = 'upsert'; this.s.rows = [].concat(rows); return this; }
    update(v){ this.s.op = 'update'; this.s.valores = v; return this; }
    delete(){ this.s.op = 'delete'; return this; }
    eq(c, v){ this.s.filtros.push(['eq', c, v]); return this; }
    in(c, v){ this.s.filtros.push(['in', c, v]); return this; }
    order(c, o){ this.s.ordem.push([c, !(o && o.ascending === false)]); return this; }
    range(a, b){ this.s.range = [a, b]; return this; }
    limit(n){ this.s.limite = n; return this; }
    maybeSingle(){ this.s.um = true; return this; }
    then(ok, erro){ return rodar(this.s).then(ok, erro); }
  }
  window.__canais = [];
  window.__funcoes = window.__funcoes || {};
  window.supabase = { createClient: () => ({
    from: t => new Q(t),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: window.__uid } } } }),
      getUser: async () => ({ data: { user: { id: window.__uid } } }),
      signOut: async () => ({}), signInWithPassword: async () => ({}),
    },
    channel: nome => { const c = { nome, h: [], on(ev, f, fn){ this.h.push([f.table, fn]); return this; }, subscribe(){ window.__canais.push(this); return this; } }; return c; },
    functions: { invoke: async (nome, { body }) => {
      const f = window.__funcoes[nome];
      if (!f) return { data: null, error: { message: 'função ' + nome + ' não simulada', context: { json: async () => ({}) } } };
      try { return { data: await f(body), error: null }; }
      catch (e) { return { data: null, error: { message: e.message, context: { json: async () => ({ erro: e.message }) } } }; }
    } },
  }) };
})();`;

const id = n => '"' + String(n).replace(/"/g, '""') + '"';
const CHAVES = { pagamentos: ['cliente_id', 'mes'] };

/** executa no PGlite o pedido que a página fez, como o usuário logado */
export function executor(db, getUid) {
  let fila = Promise.resolve();
  return specTexto => {
    const tarefa = fila.then(() => rodar(db, getUid(), JSON.parse(specTexto)));
    fila = tarefa.catch(() => {});
    return tarefa.then(r => JSON.stringify(r));
  };
}

async function rodar(db, uid, s) {
  const p = [];
  const val = v => { p.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v); return '$' + p.length; };
  const onde = () => s.filtros.length ? ' where ' + s.filtros.map(([op, c, v]) =>
    op === 'eq' ? `${id(c)} = ${val(v)}` : `${id(c)} = any(${(p.push(v), '$' + p.length)})`).join(' and ') : '';
  let sql;
  if (s.op === 'select') {
    sql = `select * from public.${id(s.t)}` + onde();
    if (s.ordem.length) sql += ' order by ' + s.ordem.map(([c, asc]) => id(c) + (asc ? '' : ' desc')).join(', ');
    if (s.range) sql += ` limit ${s.range[1] - s.range[0] + 1} offset ${s.range[0]}`;
    if (s.limite) sql += ` limit ${s.limite}`;
  } else if (s.op === 'insert' || s.op === 'upsert') {
    if (!s.rows.length) return { data: [], error: null };
    const cols = Object.keys(s.rows[0]);
    sql = `insert into public.${id(s.t)} (${cols.map(id).join(',')}) values ` +
      s.rows.map(r => '(' + cols.map(c => val(r[c])).join(',') + ')').join(',');
    if (s.op === 'upsert') {
      const pk = CHAVES[s.t] || ['id'];
      const resto = cols.filter(c => !pk.includes(c));
      sql += ` on conflict (${pk.map(id).join(',')}) do ` +
        (resto.length ? 'update set ' + resto.map(c => `${id(c)} = excluded.${id(c)}`).join(', ') : 'nothing');
    }
  } else if (s.op === 'update') {
    sql = `update public.${id(s.t)} set ` + Object.entries(s.valores).map(([c, v]) => `${id(c)} = ${val(v)}`).join(', ') + onde();
  } else if (s.op === 'delete') {
    sql = `delete from public.${id(s.t)}` + onde();
  }
  try {
    const rows = await comoUsuario(db, uid, async () => (await db.query(sql, p)).rows);
    const limpas = JSON.parse(JSON.stringify(rows));
    return { data: s.um ? (limpas[0] ?? null) : limpas, error: null };
  } catch (e) {
    return { data: null, error: { message: e.message, code: e.code } };
  }
}
