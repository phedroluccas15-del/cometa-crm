// Testa a parte de produção: etapas e prazos, semáforo, monitor de anúncios,
// link de aprovação do cliente, rotinas automáticas e as ferramentas novas do Cometinha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, consultor, comoUsuario, ADMIN, OPERADOR, SO_CONCLUI } from './banco.js';
import { carregarPerfil } from '../supabase/functions/_shared/regras.ts';
import { executar } from '../supabase/functions/_shared/ferramentas.ts';
import {
  ETAPAS_PADRAO as E, analisarAnuncios, donoAtual, prazosEtapas, semaforo, situacao,
} from '../supabase/functions/_shared/producao.ts';
import { listar, decidir } from '../supabase/functions/_shared/aprovacao.ts';
import { bomDia, conferirPublicacoes, monitor, textoCobranca } from '../supabase/functions/_shared/rotinas.ts';

const HOJE = '2026-11-02';
const AGORA = new Date('2026-11-02T13:00:00Z'); // 10h em Brasília
const linhas = async (db, sql, p) => (await db.query(sql, p)).rows;
const post = (x = {}) => ({ id: 'p', cliente_id: 'c1', titulo: 'T', formato: 'reels', etapa: 'pauta', data_publicacao: '2026-11-20',
  responsavel: 'Ana', captador: 'Bruno', editor: 'Carla', revisor: 'Dono', ...x });

// ---------------- regras ----------------
test('prazo de cada etapa conta para trás a partir da publicação', () => {
  const { prazos, reorganizado } = prazosEtapas(post(), E, HOJE);
  assert.equal(prazos.pauta, '2026-11-10');
  assert.equal(prazos.edicao, '2026-11-16');
  assert.equal(prazos.aprovacao, '2026-11-18');
  assert.equal(reorganizado, false);
});

test('etapa atrasada: o que falta é reorganizado para ainda dar tempo', () => {
  // publica dia 06, ainda em pauta (prazo seria 27/10): espreme até a publicação
  const { prazos, reorganizado } = prazosEtapas(post({ data_publicacao: '2026-11-06' }), E, HOJE);
  assert.equal(reorganizado, true);
  assert.equal(prazos.pauta, HOJE);
  assert.ok(prazos.edicao > HOJE && prazos.edicao < '2026-11-06');
  assert.ok(prazos.agendamento <= '2026-11-06');
});

test('situação e semáforo: atrasada = vermelho, perto e não pronta = amarelo', () => {
  assert.equal(situacao(post({ data_publicacao: '2026-11-01' }), E, HOJE), 'atrasada');
  assert.equal(situacao(post({ data_publicacao: HOJE, hora: '09:00' }), E, HOJE, 3, '10:00'), 'atrasada');
  assert.equal(situacao(post({ data_publicacao: '2026-11-04', etapa: 'edicao' }), E, HOJE), 'risco');
  assert.equal(situacao(post({ data_publicacao: '2026-11-04', etapa: 'agendamento' }), E, HOJE), 'ok');
  assert.equal(situacao(post({ etapa: 'publicado', data_publicacao: '2026-10-01' }), E, HOJE), 'publicada');
  assert.equal(semaforo([post(), post({ data_publicacao: '2026-11-03', etapa: 'captacao' })], E, HOJE), 'amarelo');
  assert.equal(semaforo([post(), post({ data_publicacao: '2026-10-30' })], E, HOJE), 'vermelho');
  assert.equal(semaforo([post()], E, HOJE), 'verde');
});

test('quem precisa agir é o dono da etapa atual', () => {
  assert.equal(donoAtual(post({ etapa: 'captacao' }), E), 'Bruno');
  assert.equal(donoAtual(post({ etapa: 'edicao' }), E), 'Carla');
  assert.equal(donoAtual(post({ etapa: 'aprovacao' }), E), 'cliente');
  assert.equal(donoAtual(post({ etapa: 'captacao', captador: '' }), E), 'Ana'); // sem captador: cai no responsável
  assert.equal(donoAtual(post({ etapa: 'publicado' }), E), null);
});

test('monitor de anúncios compara com as metas do cliente', () => {
  const camp = (nome, gasto, conv, ativa = true) => ({ id: nome, nome, ativa, situacao: 'ativa', gasto, conversas: conv, leads: 0 });
  const leitura = {
    ontem: { total: { gasto: 80, conversas: 2, leads: 0 }, campanhas: [camp('A', 80, 2), camp('B', 0, 0)] },
    semana: { total: { gasto: 400, conversas: 20, leads: 0 }, campanhas: [camp('A', 340, 20), camp('C', 60, 0)],
      alertas: ['Limite da conta quase no fim: restam R$ 20,00.', '"B" está ativa mas não gastou nada no período (sem entrega).'] },
    semanaAnterior: { gasto: 300, conversas: 40, leads: 0 },
  };
  const a = analisarAnuncios({ meta_cpl_max: 15, meta_orcamento_dia: 50, meta_resultados_dia: 6 }, leitura);
  const tipos = a.map(x => x.tipo).sort();
  assert.deepEqual(tipos, ['cpl_alto', 'cpl_subindo', 'limite', 'orcamento', 'poucos_resultados', 'queda', 'sem_entrega', 'sem_resultado']);
  assert.match(a.find(x => x.tipo === 'cpl_alto').texto, /R\$ 20,00.*R\$ 15,00/);
  // sem metas: não inventa regra de custo nem orçamento
  const semMetas = analisarAnuncios({}, leitura).map(x => x.tipo);
  assert.ok(!semMetas.includes('cpl_alto') && !semMetas.includes('orcamento'));
});

// ---------------- banco: permissões ----------------
test('postagens: quem só move etapa não muda o resto; alertas só se resolvem', async () => {
  const db = await novoBanco();
  await db.exec(`insert into postagens (id, cliente_id, titulo, etapa) values ('p1','c1','Rodízio','edicao');
    insert into alertas_anuncios (cliente_id, tipo, texto, chave) values ('c1','cpl_alto','caro','k1');
    update perfis set permissoes = permissoes || '{"postagens_mover":true}' where id = '${SO_CONCLUI}';`);
  await comoUsuario(db, SO_CONCLUI, async () => {
    await assert.rejects(db.query(`insert into postagens (id, cliente_id, titulo) values ('x','c1','X')`), /row-level security/);
    await db.query(`update postagens set etapa = 'revisao' where id = 'p1'`);
    await assert.rejects(db.query(`update postagens set titulo = 'Outro' where id = 'p1'`), /sem permissão/);
    assert.equal((await linhas(db, 'select count(*)::int n from alertas_anuncios'))[0].n, 0); // sem meta_ver: não vê
  });
  assert.deepEqual((await linhas(db, `select etapa, titulo from postagens where id='p1'`))[0], { etapa: 'revisao', titulo: 'Rodízio' });
  await comoUsuario(db, OPERADOR, async () => { // tem meta_ver
    assert.equal((await linhas(db, 'select count(*)::int n from alertas_anuncios'))[0].n, 1);
    await assert.rejects(db.query(`update alertas_anuncios set texto = 'mudado'`), /só dá para marcar/);
    await db.query(`update alertas_anuncios set resolvido_em = now()`);
  });
  assert.equal((await linhas(db, `select resolvido_por from alertas_anuncios`))[0].resolvido_por, 'Giovanna');
});

// ---------------- link de aprovação ----------------
test('cliente aprova ou pede ajuste pelo link, e só vê o que é dele', async () => {
  const db = await novoBanco(); const q = consultor(db);
  await db.exec(`insert into postagens (id, cliente_id, titulo, etapa, legenda, arquivo) values
      ('p1','c1','Rodízio','aprovacao','Hoje tem!','https://drive.google.com/x'),
      ('p2','c1','Bastidores','aprovacao',null,'storage:c1/p2/v.mp4'),
      ('p3','c2','Pneu','aprovacao',null,null);`);
  const [{ token_aprovacao: tk }] = await linhas(db, `select token_aprovacao from clientes where id='c1'`);
  assert.match(tk, /^[0-9a-f]{32}$/);
  await assert.rejects(listar(q, 'errado'), /inválido/);
  const r = await listar(q, tk, async c => 'https://assinado/' + c);
  assert.equal(r.cliente, 'Kyoto');
  assert.deepEqual(r.pendentes.map(p => p.id).sort(), ['p1', 'p2']); // p3 é de outro cliente
  assert.equal(r.pendentes.find(p => p.id === 'p2').arquivo, 'https://assinado/c1/p2/v.mp4');

  await assert.rejects(decidir(q, { token: tk, postagemId: 'p3', decisao: 'aprovado' }), /não encontrado/);
  await assert.rejects(decidir(q, { token: tk, postagemId: 'p2', decisao: 'ajustes' }), /o que precisa mudar/);
  await decidir(q, { token: tk, postagemId: 'p1', decisao: 'aprovado', nome: 'Seu Jorge' }, AGORA);
  await decidir(q, { token: tk, postagemId: 'p2', decisao: 'ajustes', comentario: 'Trocar a música' }, AGORA);
  const ps = await linhas(db, `select id, etapa, aprovacao, aprovacao_comentario c, eventos from postagens where id in ('p1','p2') order by id`);
  assert.deepEqual(ps.map(p => [p.id, p.etapa, p.aprovacao]), [['p1', 'agendamento', 'aprovado'], ['p2', 'edicao', 'ajustes']]);
  assert.equal(ps[1].c, 'Trocar a música');
  assert.match(ps[0].eventos.at(-1).quem, /Seu Jorge \(cliente\)/);
  await assert.rejects(decidir(q, { token: tk, postagemId: 'p1', decisao: 'aprovado' }), /já foi respondido/);
  // cliente pausado: link para de funcionar
  await db.exec(`update clientes set status='pausado' where id='c1'`);
  await assert.rejects(listar(q, tk), /desativado/);
});

// ---------------- rotinas ----------------
function metaFalsa() {
  return async url => {
    const u = new URL(url);
    const c = u.pathname.replace(/^\/v[\d.]+\//, '');
    const ok = d => new Response(JSON.stringify(d), { status: 200 });
    if (c === 'act_111') return ok({ name: 'Kyoto Ads', account_status: 1, amount_spent: '90000', spend_cap: '100000' });
    if (c === 'act_111/insights') return ok({ data: [{ spend: '210.50', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '42' }] }] });
    if (c === 'act_111/campaigns') return ok({ data: [
      { id: 'cp1', name: 'Rodízio', status: 'ACTIVE', effective_status: 'ACTIVE', insights: { data: [{ spend: '200', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '40' }] }] } },
      { id: 'cp2', name: 'Delivery', status: 'ACTIVE', effective_status: 'ACTIVE' }] });
    if (c === 'pg1') return ok({ name: 'Kyoto', access_token: 'tp', instagram_business_account: { id: 'ig1', username: 'kyoto' } });
    if (c === 'ig1/media') return ok({ data: [{ id: 'm1', caption: 'Rodízio!', media_type: 'IMAGE', permalink: 'https://instagram.com/p/m1', timestamp: '2026-11-02T12:00:00+0000' }] });
    return new Response(JSON.stringify({ error: { code: 100, message: 'x' } }), { status: 400 });
  };
}

test('monitor grava alertas uma vez por dia e avisa o responsável no WhatsApp', async () => {
  const db = await novoBanco(); const q = consultor(db);
  await db.exec(`update clientes set meta_conta_id='111', meta_cpl_max=4, resp_trafego='Dono' where id='c1';
    update clientes set servicos='["Tráfego pago"]' where id='c2';`);
  const enviados = [];
  const d = { q, agora: AGORA, meta: { tokenPadrao: 't', fetch: metaFalsa() }, enviar: async (n, t) => { enviados.push([n, t]); } };
  const r = await monitor(d);
  assert.equal(r.verificados, 1);
  const tipos = (await linhas(db, `select cliente_id, tipo from alertas_anuncios order by 1, 2`)).map(x => x.cliente_id + ':' + x.tipo);
  assert.deepEqual(tipos, ['c1:cpl_alto', 'c1:sem_acompanhamento', 'c1:sem_entrega', 'c2:sem_conta']);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0][0], '(35) 99710-4614');
  assert.match(enviados[0][1], /Delivery/);
  // de novo no mesmo dia: nada repetido, ninguém avisado de novo
  const r2 = await monitor({ ...d, enviar: async (n, t) => enviados.push([n, t]) });
  assert.equal(r2.novos, 0);
  assert.equal(enviados.length, 1);
});

test('bom dia: cada pessoa recebe o que é dela; publicação agendada é confirmada sozinha', async () => {
  const db = await novoBanco(); const q = consultor(db);
  await db.exec(`insert into postagens (id, cliente_id, titulo, formato, etapa, data_publicacao, responsavel, revisor) values
      ('p1','c1','Rodízio','feed','revisao','2026-11-04','Dono','Dono'),
      ('p2','c1','Combo','feed','agendamento','2026-11-02','Dono',null);
    update clientes set meta_pagina_id = 'pg1' where id = 'c1';`);
  const enviados = [];
  const d = { q, agora: AGORA, meta: { tokenPadrao: 't', fetch: metaFalsa() }, enviar: async (n, t) => { enviados.push([n, t]); } };
  await bomDia(d);
  const paraDono = enviados.find(([n]) => n === '(35) 99710-4614');
  assert.ok(paraDono, 'o dono tem WhatsApp e coisa para hoje');
  assert.match(paraDono[1], /Rodízio → \*Revisão interna\*/);
  assert.ok(!enviados.some(([n]) => n === '35 98888-7777'), 'Lucas não tem nada hoje: não recebe mensagem vazia');

  const r = await conferirPublicacoes(d);
  assert.equal(r.marcados, 1);
  const [p2] = await linhas(db, `select etapa, link_publicado from postagens where id='p2'`);
  assert.deepEqual(p2, { etapa: 'publicado', link_publicado: 'https://instagram.com/p/m1' });
  assert.match(textoCobranca('Kyoto', [{ descricao: 'Fotos', prazo: '2026-11-05' }]), /Fotos \(até 05\/11\)/);
});

// ---------------- Cometinha ----------------
test('Cometinha cria, lista e move postagens, respeitando permissão', async () => {
  const db = await novoBanco(); const q = consultor(db);
  const ctx = { q, perfil: await carregarPerfil(q, ADMIN), agora: AGORA };
  const rodar = async (c, n, e) => { const r = await executar(c, n, e); return { ...r, dados: r.erro ? null : JSON.parse(r.texto) }; };
  const cr = await rodar(ctx, 'criar_postagem', { cliente: 'kioto', titulo: 'Vídeo do sushi', formato: 'reels', data_publicacao: '2026-11-04', editor: 'eu' });
  assert.equal(cr.dados.feito, true);
  const fila = await rodar(ctx, 'listar_postagens', { filtro: 'em_risco' });
  assert.equal(fila.dados.total, 1);
  assert.equal(fila.dados.postagens[0].situacao, 'risco');
  const mv = await rodar(ctx, 'mover_postagem', { postagem_id: cr.dados.id, etapa: 'edicao' });
  assert.equal(mv.dados.postagem.com, 'Dono');
  const minha = await rodar(ctx, 'listar_postagens', { filtro: 'fila_edicao', responsavel: 'eu' });
  assert.equal(minha.dados.total, 1);
  const pub = await rodar(ctx, 'mover_postagem', { postagem_id: cr.dados.id, etapa: 'publicado', link: 'https://ig/x' });
  assert.equal(pub.dados.feito, true);
  assert.equal((await linhas(db, `select publicado_em is not null p from postagens`))[0].p, true);

  const ctxOp = { q, perfil: await carregarPerfil(q, OPERADOR), agora: AGORA };
  const neg = await rodar(ctxOp, 'criar_postagem', { cliente: 'Kyoto', titulo: 'X', formato: 'feed' });
  assert.equal(neg.erro, true);
  assert.match(neg.texto, /permissão/);
  const mat = await rodar(ctx, 'materiais', { acao: 'pedir', cliente: 'Sim Pneus', descricao: 'Fotos da loja', prazo: '2026-11-05' });
  assert.equal(mat.dados.feito, true);
  const lista = await rodar(ctxOp, 'materiais', { acao: 'listar' });
  assert.equal(lista.dados.pendentes[0].material, 'Fotos da loja');
  const pan = await rodar(ctx, 'panorama', {});
  assert.ok('postagens' in pan.dados && 'semaforo_clientes' in pan.dados);
});
