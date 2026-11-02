// Monta um Postgres local que imita o Supabase (login, papéis, permissões)
// para testar a migração e as regras sem tocar no banco de verdade.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const aqui = path.dirname(fileURLToPath(import.meta.url));
export const MIGRACAO = readFileSync(
  path.join(aqui, '..', 'supabase', 'migrations', '20261102000000_cometa_v2.sql'), 'utf8');

const IMITA_SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  grant usage on schema public to authenticated, anon;
  alter default privileges in schema public grant all on tables to authenticated, anon;
  alter default privileges in schema public grant all on sequences to authenticated, anon;
  create publication supabase_realtime;
`;

export const ADMIN = '00000000-0000-0000-0000-00000000000a';
export const OPERADOR = '00000000-0000-0000-0000-00000000000b';
export const SO_CONCLUI = '00000000-0000-0000-0000-00000000000c';

/** dados no formato antigo, como estão hoje na tabela "estado" */
export const ESTADO_ANTIGO = {
  clientes: [
    { id: 'c1', nome: 'Kyoto', contato: '35 99999-0001', mensalidade: 1400, diaVenc: 15, status: 'ativo', criadoEm: 1756000000000 },
    { id: 'c2', nome: 'Sim Pneus', contato: '', mensalidade: '1250', diaVenc: '10', status: 'ativo', criadoEm: 1756000000000 },
    { id: 'c3', nome: 'Hípica', mensalidade: '', diaVenc: '', status: 'pausado' },
  ],
  atividades: [
    { id: 'a1', clienteId: 'c1', titulo: 'Postagem', data: '2026-11-01', prioridade: 'alta', responsavel: 'Giovanna', recorrencia: '7', criadoEm: 1756000000000, feitaEm: null },
    { id: 'a2', clienteId: 'c2', titulo: 'Captação', data: null, responsavel: 'Lucas', criadoEm: 1756000000000, feitaEm: 1756100000000, feitaPor: 'Lucas' },
    { id: 'a3', clienteId: 'apagado', titulo: 'órfã — cliente não existe mais' },
    { id: 'a4', clienteId: 'c1', titulo: 'Data quebrada', data: 'amanhã' },
  ],
  compromissos: [
    { id: 'k1', tipo: 'Captação', clienteId: 'c1', data: '2026-11-03', hora: '09:00', local: 'Rua X', responsavel: 'Lucas', feitoEm: null },
    { id: 'k2', tipo: 'Reunião', clienteId: 'sumiu', data: '2026-11-04' },
  ],
  pagamentos: { 'c1:2026-10': 1759000000000, 'c2:2026-10': 1759000000000, 'sumiu:2026-10': 1, 'c1:lixo': 2 },
  log: [{ ts: 1759000000000, quem: 'Pedro', acao: 'Lançou atividades', detalhe: '2 atividades' }],
  equipe: ['Giovanna', 'Lucas', 'Pedro'],
  servicos: ['Postagem', 'Captação'],
};

export async function novoBanco({ comEstadoAntigo = true } = {}) {
  // datas voltam como texto, igual ao Supabase de verdade ("2026-11-01")
  const texto = v => v;
  const db = new PGlite({ parsers: { 1082: texto, 1114: texto, 1184: texto } });
  await db.exec(IMITA_SUPABASE);
  if (comEstadoAntigo) {
    await db.exec(`create table public.estado (id text primary key, dados jsonb not null default '{}'::jsonb,
                   atualizado_em timestamptz default now(), atualizado_por text);`);
    await db.query(`insert into public.estado (id, dados) values ('principal', $1)`, [JSON.stringify(ESTADO_ANTIGO)]);
  }
  await db.exec(MIGRACAO);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'dono@cometa.com'), ('${OPERADOR}', 'op@cometa.com'), ('${SO_CONCLUI}', 'edit@cometa.com');
    insert into public.perfis (id, nome, email, papel, permissoes, ativo, whatsapp) values
      ('${ADMIN}', 'Dono', 'dono@cometa.com', 'admin', '{}', true, '(35) 99710-4614'),
      ('${OPERADOR}', 'Giovanna', 'op@cometa.com', 'operador',
        '{"ver_geral":true,"ver_clientes":true,"lancar":true,"concluir":true,"meta_ver":true}', true, null),
      ('${SO_CONCLUI}', 'Lucas', 'edit@cometa.com', 'operador', '{"concluir":true}', true, '35 98888-7777');
  `);
  return db;
}

/** roda consultas como se fosse a pessoa logada no site */
export async function comoUsuario(db, uid, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}

/** adaptador: mesma assinatura usada pelas funções do servidor */
export const consultor = db => async (texto, params = []) => (await db.query(texto, params)).rows;
