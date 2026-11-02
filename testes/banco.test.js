import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, comoUsuario, MIGRACAO, ADMIN, OPERADOR, SO_CONCLUI } from './banco.js';

const linhas = async (db, sql, p) => (await db.query(sql, p)).rows;
const falha = async (promessa, padrao) => {
  await assert.rejects(promessa, e => (padrao ? padrao.test(e.message) : true));
};

test('migração copia os dados antigos e ignora o que está quebrado', async () => {
  const db = await novoBanco();
  const cli = await linhas(db, 'select id, nome, mensalidade::float as m, dia_venc, status from clientes order by id');
  assert.deepEqual(cli.map(c => c.id), ['c1', 'c2', 'c3']);
  assert.equal(cli[1].m, 1250);          // "1250" em texto virou número
  assert.equal(cli[1].dia_venc, 10);
  assert.equal(cli[2].m, null);          // vazio virou nulo, sem erro

  const at = await linhas(db, 'select id, data::text, feita_em is not null as feita from atividades order by id');
  assert.deepEqual(at.map(a => a.id), ['a1', 'a2', 'a4']); // a3 era órfã
  assert.equal(at[0].data, '2026-11-01');
  assert.equal(at[1].feita, true);
  assert.equal(at[2].data, null);        // "amanhã" não é data: ficou sem data

  const k = await linhas(db, 'select id, cliente_id from compromissos order by id');
  assert.deepEqual(k, [{ id: 'k1', cliente_id: 'c1' }, { id: 'k2', cliente_id: null }]);

  const pg = await linhas(db, 'select cliente_id, mes from pagamentos order by 1');
  assert.deepEqual(pg, [{ cliente_id: 'c1', mes: '2026-10' }, { cliente_id: 'c2', mes: '2026-10' }]);

  const aj = (await linhas(db, 'select equipe, servicos from ajustes'))[0];
  assert.deepEqual(aj.equipe, ['Giovanna', 'Lucas', 'Pedro']);
  assert.equal((await linhas(db, 'select count(*)::int n from historico'))[0].n, 1);
});

test('rodar a migração de novo não duplica nada', async () => {
  const db = await novoBanco();
  await db.exec(MIGRACAO);
  assert.equal((await linhas(db, 'select count(*)::int n from clientes'))[0].n, 3);
  assert.equal((await linhas(db, 'select count(*)::int n from historico'))[0].n, 1);
  const pub = await linhas(db, `select count(*)::int n from pg_publication_tables where pubname='supabase_realtime'`);
  assert.equal(pub[0].n, 9);
});

test('banco novo, sem tabela antiga, também funciona', async () => {
  const db = await novoBanco({ comEstadoAntigo: false });
  assert.equal((await linhas(db, 'select count(*)::int n from clientes'))[0].n, 0);
});

test('operador sem "editar_clientes" não consegue mexer em cliente', async () => {
  const db = await novoBanco();
  await comoUsuario(db, OPERADOR, async () => {
    assert.equal((await linhas(db, 'select count(*)::int n from clientes'))[0].n, 3); // ver pode
    await falha(db.query(`insert into clientes (id, nome) values ('x', 'X')`), /row-level security/);
    await db.query(`update clientes set nome = 'Hackeado' where id = 'c1'`); // RLS: atualiza 0 linhas
    await db.query(`delete from clientes where id = 'c1'`);
  });
  assert.equal((await linhas(db, `select nome from clientes where id='c1'`))[0].nome, 'Kyoto');
});

test('quem só pode "concluir" dá OK mas não muda a tarefa', async () => {
  const db = await novoBanco();
  await comoUsuario(db, SO_CONCLUI, async () => {
    await db.query(`update atividades set feita_em = now(), feita_por = 'Lucas' where id = 'a1'`);
    await falha(db.query(`update atividades set titulo = 'outra coisa' where id = 'a1'`), /sem permissão/);
    // pode criar a próxima de uma tarefa que se repete…
    await db.query(`insert into atividades (id, cliente_id, titulo, recorrencia, data) values ('a1b','c1','Postagem','7','2026-11-08')`);
    // …mas não uma tarefa avulsa
    await falha(db.query(`insert into atividades (id, cliente_id, titulo) values ('z','c1','avulsa')`), /row-level security/);
    await db.query(`delete from atividades where id = 'a1'`); // sem permissão: apaga 0
  });
  const a1 = (await linhas(db, `select titulo, feita_em is not null as feita from atividades where id='a1'`))[0];
  assert.deepEqual(a1, { titulo: 'Postagem', feita: true });
});

test('financeiro e histórico ficam fechados para quem não tem permissão', async () => {
  const db = await novoBanco();
  await comoUsuario(db, OPERADOR, async () => {
    assert.equal((await linhas(db, 'select count(*)::int n from pagamentos'))[0].n, 0);
    assert.equal((await linhas(db, 'select count(*)::int n from historico'))[0].n, 0);
    await db.query(`insert into historico (quem, acao) values ('Outra Pessoa', 'teste')`);
  });
  const h = await linhas(db, `select quem from historico where acao = 'teste'`);
  assert.equal(h[0].quem, 'Giovanna'); // o nome vem do login, não do que o site mandou
  await comoUsuario(db, ADMIN, async () => {
    assert.equal((await linhas(db, 'select count(*)::int n from pagamentos'))[0].n, 2);
  });
});

test('operador não se promove a admin nem lê o cofre da Meta', async () => {
  const db = await novoBanco();
  await comoUsuario(db, OPERADOR, async () => {
    await db.query(`update perfis set papel = 'admin' where id = '${OPERADOR}'`);
    await falha(db.query('select * from privado.meta_tokens'), /permission denied/);
    const p = await linhas(db, 'select id from perfis');
    assert.equal(p.length, 1); // só enxerga o próprio perfil
  });
  assert.equal((await linhas(db, `select papel from perfis where id='${OPERADOR}'`))[0].papel, 'operador');
});

test('conta desativada não enxerga nada', async () => {
  const db = await novoBanco();
  await db.query(`update perfis set ativo = false where id = '${OPERADOR}'`);
  await comoUsuario(db, OPERADOR, async () => {
    assert.equal((await linhas(db, 'select count(*)::int n from clientes'))[0].n, 0);
    assert.equal((await linhas(db, 'select count(*)::int n from atividades'))[0].n, 0);
  });
});
