// Abre o Cometa OS de verdade num navegador automático, ligado ao banco local,
// e usa a tela como uma pessoa usaria.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { novoBanco, ADMIN, SO_CONCLUI } from './banco.js';
import { SCRIPT_NAVEGADOR, executor } from './supabase-falso.js';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const espera = ms => new Promise(r => setTimeout(r, ms));
let servidor, url, navegador;

before(async () => {
  servidor = http.createServer(async (req, res) => {
    const arq = path.join(raiz, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
    try {
      const tipo = arq.endsWith('.html') ? 'text/html' : arq.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      let corpo = await readFile(arq);
      // nos testes, o site "acha" que está ligado a um Supabase (que é o banco local)
      if (arq.endsWith('index.html')) corpo = corpo.toString('utf8')
        .replace("const SUPABASE_URL = '';", "const SUPABASE_URL = 'https://teste.supabase.co';")
        .replace("const SUPABASE_KEY = '';", "const SUPABASE_KEY = 'teste';");
      res.writeHead(200, { 'Content-Type': tipo + '; charset=utf-8' }).end(corpo);
    } catch { res.writeHead(404).end(); }
  }).listen(0);
  url = `http://127.0.0.1:${servidor.address().port}/index.html`;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  navegador = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, env });
});
after(async () => { await navegador?.close(); servidor?.close(); });

const RESUMO = {
  periodo: '7d', nomePeriodo: 'últimos 7 dias',
  conta: { id: '111', nome: 'Kyoto Ads', moeda: 'BRL', status: 'ativa', gastoTotal: 900, limite: 1000, restanteLimite: 100, prePago: false, formaPagamento: 'Visa final 4242', saldoDevedor: 0 },
  total: { gasto: 210.5, impressoes: 30000, alcance: 12000, cliques: 400, conversas: 42, leads: 0, custoConversa: 5.01, custoLead: null },
  campanhas: [{ id: 'cp1', nome: 'Rodízio', status: 'ACTIVE', situacao: 'ativa', ativa: true, orcamentoDiario: 30, orcamentoTotal: null, orcamentoNoConjunto: false, gasto: 200, conversas: 40, leads: 0, custoConversa: 5, custoLead: null }],
  alertas: ['"Delivery" está ativa mas não gastou nada no período (sem entrega).'],
};

async function abrir(uid) {
  const db = await novoBanco();
  const ctx = await navegador.newContext({ serviceWorkers: 'block' });
  const pagina = await ctx.newPage();
  const erros = [];
  pagina.on('pageerror', e => erros.push(e.message));
  pagina.on('dialog', d => d.type() === 'prompt' ? d.accept('45') : d.accept());
  await pagina.route(/supabase-js/, r => r.fulfill({ contentType: 'text/javascript', body: SCRIPT_NAVEGADOR }));
  await pagina.route(/fonts\.(googleapis|gstatic)|cdnjs/, r => r.abort());
  await pagina.exposeFunction('__sb', executor(db, () => uid));
  await pagina.addInitScript(({ uid, resumo }) => {
    window.__uid = uid;
    window.__chamadas = [];
    window.__funcoes = {
      meta: async b => {
        window.__chamadas.push(b);
        if (b.acao === 'resumo') return resumo;
        if (b.acao === 'publicacoes') return { fonte: 'instagram', conta: '@kyoto', itens: [{ id: 'p1', texto: 'Rodízio hoje!', tipo: 'IMAGE', imagem: '', link: 'https://x', data: '2026-11-01T12:00:00Z', curtidas: 120, comentarios: 8 }] };
        if (b.acao === 'alterar') return { id: b.objetoId, nomeAntes: 'Rodízio', antes: {}, depois: {} };
        if (b.acao === 'contas') return { contas: [{ id: '111', nome: 'Kyoto Ads', empresa: 'Kyoto', status: 'ativa' }], paginas: [{ id: 'pg1', nome: 'Kyoto Sushi', instagram: 'kyoto' }] };
        throw new Error('ação não simulada');
      },
      cometinha: async b => {
        window.__chamadas.push({ cometinha: b });
        if (b.acao === 'historico') return { conversaId: 'x', mensagens: [] };
        return { conversaId: 'x', resposta: 'Você tem *1 tarefa* atrasada: Postagem da Kyoto.', acoes: [], transcricao: null };
      },
    };
  }, { uid, resumo: RESUMO });
  await pagina.goto(url);
  await pagina.waitForSelector('.tela.ativa');
  await espera(400);
  return { db, pagina, erros, ctx };
}
const linhas = async (db, sql, p) => (await db.query(sql, p)).rows;
const salvo = async pagina => { await espera(500); await pagina.waitForFunction(() => !document.getElementById('sync').classList.contains('salvando')); await espera(150); };

test('tela: dados migrados aparecem e o que se faz na tela vai para as tabelas', async () => {
  const { db, pagina, erros, ctx } = await abrir(ADMIN);
  try {
    // clientes migrados do formato antigo
    await pagina.click('#nav [data-t="clientes"]');
    const cards = await pagina.textContent('#cards');
    for (const n of ['Kyoto', 'Sim Pneus', 'Hípica']) assert.ok(cards.includes(n), n);

    // novo cliente
    await pagina.click('#b-novo-cli');
    await pagina.fill('#c-nome', 'Padaria Pão Quente');
    await pagina.fill('#c-mens', '900');
    await pagina.fill('#c-venc', '5');
    await pagina.click('#c-salvar');
    await salvo(pagina);
    const [nova] = await linhas(db, `select id, mensalidade::float m, dia_venc from clientes where nome = 'Padaria Pão Quente'`);
    assert.deepEqual([nova.m, nova.dia_venc], [900, 5]);

    // lançar atividade para ela
    await pagina.click('#nav [data-t="lancar"]');
    await pagina.selectOption('#sel-cli', nova.id);
    await pagina.fill('#in-tit', 'Captação de fotos');
    await pagina.fill('#in-data', '2026-11-20');
    await pagina.click('#b-salvar');
    await salvo(pagina);
    const at = await linhas(db, `select titulo, data::text from atividades where cliente_id = $1`, [nova.id]);
    assert.deepEqual(at, [{ titulo: 'Captação de fotos', data: '2026-11-20' }]);

    // dar OK na tarefa que se repete (cria a próxima)
    await pagina.click('#nav [data-t="geral"]');
    await pagina.click('[data-ok="a1"]');
    await salvo(pagina);
    const a1 = await linhas(db, `select feita_em is not null as feita, feita_por from atividades where id='a1'`);
    assert.deepEqual(a1, [{ feita: true, feita_por: 'Dono' }]);
    const prox = await linhas(db, `select data::text from atividades where titulo='Postagem' and feita_em is null`);
    assert.equal(prox.length, 1);

    // financeiro: marcar recebido
    await pagina.click('#nav [data-t="financeiro"]');
    await pagina.click(`[data-pg="c1"]`);
    await salvo(pagina);
    const mes = await pagina.evaluate(() => mesFin);
    assert.equal((await linhas(db, `select count(*)::int n from pagamentos where cliente_id='c1' and mes=$1`, [mes]))[0].n, 1);

    // ajustes
    await pagina.click('#nav [data-t="ajustes"]');
    await pagina.fill('#in-equipe', 'Giovanna, Lucas, Pedro, Ana');
    await pagina.click('#b-salvar-aj');
    await salvo(pagina);
    assert.deepEqual((await linhas(db, `select equipe from ajustes`))[0].equipe, ['Giovanna', 'Lucas', 'Pedro', 'Ana']);

    // histórico gravado com o nome de quem fez
    const h = await linhas(db, `select acao, quem from historico where quem = 'Dono' order by ts`);
    assert.ok(h.some(x => x.acao === 'Cadastrou cliente'));
    assert.ok(h.some(x => x.acao === 'Concluiu atividade'));

    // excluir cliente leva as atividades junto
    await pagina.click('#nav [data-t="clientes"]');
    await pagina.click(`.cli[data-c="${nova.id}"]`);
    await pagina.click('#b-edit-cli');
    await pagina.click('#c-excluir');
    await salvo(pagina);
    assert.equal((await linhas(db, `select count(*)::int n from atividades where cliente_id = $1`, [nova.id]))[0].n, 0);
    assert.equal((await linhas(db, `select count(*)::int n from clientes where id = $1`, [nova.id]))[0].n, 0);

    assert.deepEqual(erros, []);
  } finally { await ctx.close(); }
});

test('tela: duas pessoas mexendo ao mesmo tempo não apagam o trabalho uma da outra', async () => {
  const { db, pagina, erros, ctx } = await abrir(ADMIN);
  try {
    // "outro aparelho" renomeia a Sim Pneus direto no banco…
    await db.query(`update clientes set nome = 'Sim Pneus Matriz' where id = 'c2'`);
    // …enquanto esta tela, que ainda tem o nome antigo, edita a Kyoto
    await pagina.click('#nav [data-t="clientes"]');
    await pagina.click('.cli[data-c="c1"]');
    await pagina.click('#b-edit-cli');
    await pagina.fill('#c-contato', '35 98888-1111');
    await pagina.click('#c-salvar');
    await salvo(pagina);
    const r = await linhas(db, `select id, nome, contato from clientes where id in ('c1','c2') order by id`);
    assert.equal(r[0].contato, '35 98888-1111');
    assert.equal(r[1].nome, 'Sim Pneus Matriz'); // no sistema antigo isso voltaria para "Sim Pneus"

    // e quando chega o aviso ao vivo, a tela se atualiza sozinha
    const novo = (await linhas(db, `select * from clientes where id='c2'`))[0];
    await pagina.evaluate(row => {
      const c = window.__canais[0];
      c.h.filter(([t]) => t === 'clientes').forEach(([, fn]) => fn({ eventType: 'UPDATE', new: row }));
    }, JSON.parse(JSON.stringify(novo)));
    await espera(300);
    await pagina.click('#b-voltar');
    assert.ok((await pagina.textContent('#cards')).includes('Sim Pneus Matriz'));
    assert.deepEqual(erros, []);
  } finally { await ctx.close(); }
});

test('tela: anúncios da Meta na ficha e alteração com confirmação', async () => {
  const { db, pagina, erros, ctx } = await abrir(ADMIN);
  try {
    await pagina.click('#nav [data-t="clientes"]');
    await pagina.click('.cli[data-c="c1"]');
    await pagina.waitForSelector('#b-ligar-meta');
    await pagina.click('#b-ligar-meta');
    await pagina.waitForSelector('[name="lm-conta"][value="111"]');
    await pagina.check('[name="lm-conta"][value="111"]');
    await pagina.check('[name="lm-pag"][value="pg1"]');
    await pagina.click('#lm-salvar');
    await salvo(pagina);
    const [c1] = await linhas(db, `select meta_conta_id, meta_pagina_id from clientes where id='c1'`);
    assert.deepEqual(c1, { meta_conta_id: '111', meta_pagina_id: 'pg1' });

    await pagina.waitForSelector('#meta-camps');
    const txt = await pagina.textContent('#f-meta');
    assert.match(txt, /R\$ 210,50/);
    assert.match(txt, /42/);
    assert.match(txt, /Rodízio/);
    assert.match(txt, /sem entrega/);
    assert.match(txt, /Rodízio hoje!/);
    if (process.env.FOTOS) {
      await pagina.screenshot({ path: process.env.FOTOS + '/meta-pc.png', fullPage: true });
      await pagina.setViewportSize({ width: 390, height: 844 });
      await espera(300);
      await pagina.screenshot({ path: process.env.FOTOS + '/meta-celular.png', fullPage: true });
      await pagina.setViewportSize({ width: 1280, height: 720 });
    }

    await pagina.click('[data-st="cp1"]');           // pausar (confirm aceito)
    await pagina.click('[data-orc="cp1"]');          // orçamento: prompt responde 45
    await espera(300);
    const ch = await pagina.evaluate(() => window.__chamadas.filter(c => c.acao === 'alterar'));
    assert.deepEqual(ch.map(c => [c.objetoId, c.status || null, c.orcamentoDiario || null]), [['cp1', 'PAUSED', null], ['cp1', null, 45]]);
    assert.deepEqual(erros, []);
  } finally { await ctx.close(); }
});

test('tela: Cometinha abre, conversa e mostra a resposta formatada', async () => {
  const { pagina, erros, ctx } = await abrir(ADMIN);
  try {
    await pagina.click('#ct-bt');
    await pagina.waitForSelector('.ct-m.ele');
    assert.match(await pagina.textContent('#ct-msgs'), /Sou o Cometinha/);
    await pagina.fill('#ct-texto', 'quais são minhas tarefas?');
    await pagina.press('#ct-texto', 'Enter');
    await pagina.waitForFunction(() => document.querySelectorAll('.ct-m.ele').length >= 2);
    const html = await pagina.innerHTML('#ct-msgs');
    assert.match(html, /<b>1 tarefa<\/b>/);
    assert.match(html, /quais são minhas tarefas\?/);
    if (process.env.FOTOS) {
      await pagina.screenshot({ path: process.env.FOTOS + '/cometinha-pc.png' });
      await pagina.setViewportSize({ width: 390, height: 844 });
      await espera(300);
      await pagina.screenshot({ path: process.env.FOTOS + '/cometinha-celular.png' });
    }
    assert.deepEqual(erros, []);
  } finally { await ctx.close(); }
});

test('tela: se a pessoa não tem permissão, o banco recusa e a tela volta ao certo', async () => {
  const { db, pagina, erros, ctx } = await abrir(SO_CONCLUI);
  try {
    // Lucas só pode concluir. Força uma edição de cliente por baixo da tela:
    await pagina.evaluate(async () => { dados.clientes.find(c => c.id === 'c1').nome = 'Mudado'; await gravar(dados); });
    await espera(1500);
    assert.equal((await linhas(db, `select nome from clientes where id='c1'`))[0].nome, 'Kyoto');
    assert.equal(await pagina.evaluate(() => dados.clientes.find(c => c.id === 'c1').nome), 'Kyoto');
    // sem a permissão "cometinha", o botão não aparece
    assert.equal(await pagina.isVisible('#ct-bt'), false);
    assert.deepEqual(erros, []);
  } finally { await ctx.close(); }
});
