// Roteiro "dia a dia": usa o CRM como a equipe usaria e anota tudo que falhar.
// Rodar: NUVEM=1 npm run dia   (banco simulado com as permissões de verdade)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { novoBanco, ADMIN, OPERADOR, SO_CONCLUI } from './banco.js';
import { SCRIPT_NAVEGADOR, executor } from './supabase-falso.js';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2];
const espera = ms => new Promise(r => setTimeout(r, ms));
const problemas = [], ok = [];
let passo = '';
async function etapa(nome, fn) {
  passo = nome;
  const t0 = Date.now(); try { await fn(); ok.push(nome); console.log('✔', nome, Date.now() - t0 + 'ms'); }
  catch (e) { problemas.push(`${nome}: ${String(e.message).split('\n')[0].slice(0, 300)}`); console.log('✖', nome, '→', String(e.message).split('\n')[0].slice(0, 250)); }
  if (globalThis.__pgAtual) await globalThis.__pgAtual.evaluate(() => { if (document.getElementById('fundo').classList.contains('ver')) fecharModal(); }).catch(() => {});
  if (globalThis.__pgAtual) { const vivo = await Promise.race([globalThis.__pgAtual.evaluate(() => 1).then(() => true).catch(() => false), espera(3000).then(() => false)]); if (!vivo) { console.log('!!! PÁGINA TRAVOU depois de:', nome); process.exit(1); } }
}
const certo = (c, msg) => { if (!c) throw new Error(msg); };

const srv = http.createServer(async (req, res) => {
  const arq = path.join(raiz, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    let corpo = await readFile(arq);
    if (arq.endsWith('config.js') && process.env.NUVEM) corpo = corpo.toString('utf8')
      .replace("const SUPABASE_URL = '';", "const SUPABASE_URL = 'https://teste.supabase.co';")
      .replace("const SUPABASE_KEY = '';", "const SUPABASE_KEY = 'teste';");
    const t = arq.endsWith('.html') ? 'text/html' : arq.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': t + '; charset=utf-8' }).end(corpo);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}/`;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const nav = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, env });

async function abrir(uid, db, larg = 1366) {
  const ctx = await nav.newContext({ serviceWorkers: 'block', viewport: { width: larg, height: 860 }, acceptDownloads: true });
  const pg = await ctx.newPage();
  const erros = [];
  pg.on('pageerror', e => erros.push(passo + ' → ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/fonts|cdnjs|Failed to load resource/.test(m.text())) erros.push(passo + ' → console: ' + m.text()); });
  pg.on('dialog', d => d.type() === 'prompt' ? d.accept(d.defaultValue() || 'https://instagram.com/p/teste') : d.accept());
  await pg.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  if (!db) await ctx.route(/config\.js/, r => r.fulfill({ contentType: 'text/javascript', body: "const SUPABASE_URL = ''; const SUPABASE_KEY = '';" }));
  if (db) {
    await pg.route(/supabase-js/, r => r.fulfill({ contentType: 'text/javascript', body: SCRIPT_NAVEGADOR }));
    await pg.exposeFunction('__sb', executor(db, () => uid));
    await pg.addInitScript(u => { window.__uid = u; window.__funcoes = {
      meta: async b => { if (b.acao === 'monitorar') return { verificados: 1, novos: 0, erros: [] }; if (b.acao === 'rotina') return { enviados: 2 };
        if (b.acao === 'resumo') return { periodo: b.periodo, nomePeriodo: 'este mês', conta: { nome: 'X', status: 'ativa', gastoTotal: 0 }, total: { gasto: 300, alcance: 9000, impressoes: 20000, cliques: 300, conversas: 30, leads: 0, custoConversa: 10 }, campanhas: [], alertas: [] };
        throw new Error('sem simulação: ' + b.acao); } }; }, uid);
  }
  await pg.goto(base + 'index.html');
  await pg.waitForSelector('.tela.ativa');
  await espera(500);
  return { ctx, pg, erros };
}
const salvo = async pg => { await espera(450); await pg.waitForFunction(() => !document.getElementById('sync').classList.contains('salvando'), null, { timeout: 8000 }); await espera(150); };
const q = async (db, sql, p) => (await db.query(sql, p)).rows;
const texto = (pg, sel) => pg.textContent(sel);
const ir = (pg, t) => pg.click(`#nav [data-t="${t}"]`);

// ======================= ADMIN, banco simulado =======================
const db = await novoBanco();
await db.exec(`update ajustes set equipe = '["Dono","Giovanna","Lucas"]'`);
const { ctx, pg, erros } = await abrir(ADMIN, db);
globalThis.__pgAtual = pg;

await etapa('central abre com os blocos', async () => {
  for (const id of ['kpis', 'kpis2', 'semaforo', 'bl-carga', 'bl-atraso']) certo(await pg.isVisible('#' + id), 'faltou ' + id);
});
await etapa('cliente novo com cadastro completo e checklist', async () => {
  await ir(pg, 'clientes'); await pg.click('#b-novo-cli');
  await pg.fill('#c-nome', 'Doceria Mel'); await pg.fill('#c-contato', '35 99876-5432');
  await pg.fill('#c-mens', '1200'); await pg.fill('#c-venc', '10'); await pg.fill('#c-posts', '12');
  await pg.check('[data-sv="Social media"]'); await pg.check('[data-sv="Tráfego pago"]');
  await pg.selectOption('#c-rsoc', 'Giovanna'); await pg.selectOption('#c-rtra', 'Lucas');
  await pg.fill('#c-brief', 'Tom alegre'); await pg.fill('#c-ini', '2026-11-01');
  await pg.click('#c-salvar'); await salvo(pg);
  const [c] = await q(db, `select * from clientes where nome='Doceria Mel'`);
  certo(c && c.posts_mes === 12 && c.resp_social === 'Giovanna' && c.servicos.length === 2 && c.token_aprovacao, 'cadastro incompleto: ' + JSON.stringify(c));
  const n = (await q(db, `select count(*)::int n from atividades where cliente_id=$1`, [c.id]))[0].n;
  certo(n === 6, 'checklist criou ' + n);
});
const cid = (await q(db, `select id from clientes where nome='Doceria Mel'`))[0]?.id;

await etapa('busca e filtros de clientes', async () => {
  await pg.fill('#busca', 'doce'); await espera(200);
  certo((await pg.$$('.cli')).length === 1, 'busca não filtrou'); await pg.fill('#busca', '');
  for (const f of ['atraso', 'atencao', 'pend', 'livre', 'pausado', 'todos']) { await pg.click(`[data-f="${f}"]`); await espera(100); }
});
await etapa('ficha: postagem nova pela ficha', async () => {
  await pg.click(`.cli[data-c="${cid}"]`); await espera(300);
  await pg.click('#b-add-post');
  certo(await pg.inputValue('#po-cli') === cid, 'cliente não veio preenchido');
  certo(await pg.inputValue('#po-resp') === 'Giovanna', 'responsável social não veio');
  await pg.fill('#po-tit', 'Bolo de pote'); await pg.selectOption('#po-fmt', 'reels');
  await pg.fill('#po-data', await pg.evaluate(() => somaDias(hojeISO(), 2))); await pg.fill('#po-hora', '19:00');
  await pg.selectOption('#po-capt', 'Lucas'); await pg.fill('#po-rot', 'Mostrar o bolo sendo montado');
  await pg.click('#po-salvar'); await salvo(pg);
  certo((await q(db, `select count(*)::int n from postagens where cliente_id=$1`, [cid]))[0].n === 1, 'não gravou');
  certo((await texto(pg, '#f-posts')).includes('Bolo de pote'), 'não apareceu na ficha');
});
await etapa('ficha: editar postagem, anexar link e mudar etapa pelo formulário', async () => {
  await pg.click('#f-posts [data-abre-post]');
  await pg.fill('#po-leg', 'Legenda nova'); await pg.fill('#po-link-novo', 'https://drive.google.com/abc'); await pg.click('#po-add-link');
  await pg.selectOption('#po-etapa', 'edicao'); await pg.click('#po-salvar'); await salvo(pg);
  const [p] = await q(db, `select etapa, legenda, arquivo, eventos from postagens where cliente_id=$1`, [cid]);
  certo(p.etapa === 'edicao' && p.legenda === 'Legenda nova' && p.arquivo, 'não salvou edição+etapa: ' + JSON.stringify(p));
  certo(p.eventos.some(e => /Edição/.test(e.txt)), 'histórico da etapa não registrado');
});
await etapa('ficha: duplicar postagem', async () => {
  await pg.click('#f-posts [data-abre-post]'); await pg.click('#po-dup'); await salvo(pg);
  await pg.evaluate(() => fecharModal());
  certo((await q(db, `select count(*)::int n from postagens where cliente_id=$1`, [cid]))[0].n === 2, 'não duplicou');
});
await etapa('ficha: materiais pedir, cobrar, receber', async () => {
  await pg.click('#b-pedir-mat'); await pg.fill('#ma-desc', 'Fotos da vitrine'); await pg.click('#ma-salvar'); await salvo(pg);
  const pops = []; ctx.on('page', p => pops.push(p));
  await pg.click('#b-cobrar-mat'); await salvo(pg); await espera(300);
  certo(pops.some(p => /5535998765432/.test(p.url()) && !/%EF%BF%BD/.test(p.url())), 'cobrança não abriu WhatsApp certo: ' + pops.map(p => p.url()).join());
  pops.forEach(p => p.close());
  const [m] = await q(db, `select lembretes from materiais where cliente_id=$1`, [cid]);
  certo(m.lembretes === 1, 'lembrete não contou');
  await pg.click('#f-materiais [data-receb]'); await salvo(pg);
  certo((await q(db, `select recebido_em is not null r from materiais where cliente_id=$1`, [cid]))[0].r, 'não marcou recebido');
});
await etapa('ficha: link de aprovação, status no WhatsApp, relatório', async () => {
  await pg.click('#b-aprov'); certo((await texto(pg, '#modal')).includes('aprovar.html?c='), 'sem link'); await pg.evaluate(() => fecharModal());
  await pg.click('#b-zap'); certo((await pg.inputValue('#tx-zap')).includes('Próximas postagens'), 'status sem postagens'); await pg.evaluate(() => fecharModal());
  await pg.click('#b-relat'); await espera(400); certo((await texto(pg, '#modal')).includes('Postagens'), 'relatório vazio'); await pg.evaluate(() => fecharModal());
});
await etapa('ficha: atividade pela ficha (+ Atividade) e OK', async () => {
  await pg.click('#b-add-cli');
  certo(await pg.inputValue('#sel-cli') === cid, 'Lançar não veio com o cliente');
  await pg.fill('#in-tit', 'Stories da semana'); await pg.click('[data-dia="0"]');
  await pg.selectOption('#in-resp', 'Dono'); await pg.click('#b-salvar'); await salvo(pg);
  const [a] = await q(db, `select id from atividades where titulo='Stories da semana'`);
  certo(a, 'atividade não gravou');
  await ir(pg, 'minhas'); await pg.click(`#minhas-ativ [data-ok="${a.id}"]`); await salvo(pg);
  certo((await q(db, `select feita_em is not null f from atividades where id=$1`, [a.id]))[0].f, 'OK não gravou');
});
await etapa('lançar várias de uma vez (fila)', async () => {
  await ir(pg, 'lancar'); await pg.selectOption('#sel-cli', cid);
  for (const t of ['Arte promo', 'Legenda']) { await pg.fill('#in-tit', t); await pg.click('#b-fila'); }
  await pg.click('#b-salvar'); await salvo(pg);
  certo((await q(db, `select count(*)::int n from atividades where titulo in ('Arte promo','Legenda') and cliente_id=$1`, [cid]))[0].n === 2, 'fila não salvou');
});
await etapa('calendário: navegar, filtrar, + no dia, abrir post', async () => {
  await ir(pg, 'calendario');
  await pg.selectOption('#cal-cli', cid); await espera(200);
  certo((await texto(pg, '#cal')).includes('Bolo de pote'), 'filtro de cliente');
  await pg.click('#cal-prox'); await pg.click('#cal-ant'); await pg.click('#cal-hoje');
  await pg.click('#cal [data-nova-dia]'); certo(await pg.inputValue('#po-cli') === cid, '+ no dia não trouxe cliente'); await pg.evaluate(() => fecharModal());
  await pg.click('#cal .cal-p'); certo(await pg.isVisible('#po-tit'), 'não abriu post'); await pg.evaluate(() => fecharModal());
  await pg.selectOption('#cal-cli', '');
});
await etapa('produção: filtros, distribuir e avançar', async () => {
  await ir(pg, 'producao');
  await pg.click('[data-pf="tudo"]'); await pg.click('[data-pf="meus"]'); await pg.click('[data-pf="meus"]'); await pg.click('[data-pf="video"]');
  await pg.click('#b-distribuir'); await espera(200);
  if (await pg.isVisible('#di-ok')) { await pg.click('#di-ok'); await salvo(pg); }
  else await pg.evaluate(() => fecharModal());
  const id = await pg.getAttribute('.kcard [data-avanca]', 'data-avanca');
  const antes = (await q(db, `select etapa from postagens where id=$1`, [id]))[0].etapa;
  await pg.click(`.kcard [data-avanca="${id}"]`); await salvo(pg);
  const depois = (await q(db, `select etapa from postagens where id=$1`, [id]))[0].etapa;
  certo(antes !== depois, 'não avançou');
});
// ---------- foco: agendamento de posts ----------
await etapa('agendar: post no dia certo do calendário, com hora', async () => {
  await ir(pg, 'calendario'); await pg.click('#b-nova-post');
  await pg.selectOption('#po-cli', cid);
  const dia = await pg.evaluate(() => somaDias(hojeISO(), 3));
  await pg.fill('#po-tit', 'Promo de sexta'); await pg.fill('#po-data', dia); await pg.fill('#po-hora', '18:30');
  await pg.click('#po-salvar'); await salvo(pg);
  const [p] = await q(db, `select id, data_publicacao::text d, hora from postagens where titulo='Promo de sexta'`);
  certo(p.d === dia && p.hora === '18:30', 'data/hora: ' + JSON.stringify(p));
  const celula = await pg.evaluate(id => document.querySelector(`.cal-p[data-post="${id}"]`)?.closest('.cal-dia')?.querySelector('.cal-n span')?.textContent, p.id);
  certo(celula && celula.trim().endsWith(String(Number(dia.slice(8)))), 'apareceu no dia errado: ' + celula);
  certo((await texto(pg, `.cal-p[data-post="${p.id}"]`)).includes('18:30'), 'hora não aparece no calendário');
});
await etapa('agendar: remarcar a data move o post no calendário', async () => {
  const [p] = await q(db, `select id from postagens where titulo='Promo de sexta'`);
  await pg.click(`.cal-p[data-post="${p.id}"]`);
  const nova = await pg.evaluate(() => somaDias(hojeISO(), 6));
  await pg.fill('#po-data', nova); await pg.click('#po-salvar'); await salvo(pg);
  certo((await q(db, `select data_publicacao::text d from postagens where id=$1`, [p.id]))[0].d === nova, 'não remarcou');
});
await etapa('agendar: passa por todas as etapas até agendamento e publicado com link', async () => {
  const [p] = await q(db, `select id from postagens where titulo='Promo de sexta'`);
  await ir(pg, 'producao'); await pg.click('[data-pf="tudo"]');
  for (let i = 0; i < 6; i++) { await pg.click(`.kcard [data-avanca="${p.id}"]`); await salvo(pg); }
  certo((await q(db, `select etapa from postagens where id=$1`, [p.id]))[0].etapa === 'agendamento', 'não chegou em agendamento');
  certo((await texto(pg, '#kanban')).includes('Promo de sexta'), 'sumiu da coluna Agendamento');
  await pg.click(`.kcard [data-avanca="${p.id}"]`); await salvo(pg); // prompt devolve um link
  const [d] = await q(db, `select etapa, link_publicado, publicado_em is not null pub from postagens where id=$1`, [p.id]);
  certo(d.etapa === 'publicado' && d.link_publicado && d.pub, 'publicar: ' + JSON.stringify(d));
  await pg.click('[data-pf="video"]');
});
await etapa('agendar: post de hoje com horário vencido vira atrasado; com horário futuro fica em "Publicar hoje"', async () => {
  await db.exec(`insert into postagens (id, cliente_id, titulo, etapa, data_publicacao, hora) values
    ('hj1','${cid}','Já passou','agendamento', current_date, '00:01'), ('hj2','${cid}','Mais tarde','agendamento', current_date, '23:59')`);
  await pg.evaluate(() => recarregarDaNuvem()); await espera(600);
  await ir(pg, 'geral');
  certo((await texto(pg, '#bl-post-atraso')).includes('Já passou'), 'horário vencido não ficou atrasado');
  certo((await texto(pg, '#bl-post-hoje')).includes('Mais tarde'), 'post de hoje não aparece em Publicar hoje');
  certo(!(await texto(pg, '#bl-post-hoje')).includes('Já passou'), 'atrasado duplicado em Publicar hoje');
});
await etapa('agendar: post agendado não conta como "em risco"; em edição perto da data conta', async () => {
  await db.exec(`insert into postagens (id, cliente_id, titulo, etapa, data_publicacao) values
    ('r1','${cid}','Pronto','agendamento', current_date + 1), ('r2','${cid}','Atrasado na edição','edicao', current_date + 1)`);
  await pg.evaluate(() => recarregarDaNuvem()); await espera(600);
  const s = await pg.evaluate(() => [sitPost(dados.postagens.find(p => p.id === 'r1')), sitPost(dados.postagens.find(p => p.id === 'r2'))]);
  certo(s[0] === 'ok' && s[1] === 'risco', 'situações: ' + s);
  await pg.click('#b-emergencia');
  const t = await texto(pg, '#em-lista');
  certo(t.includes('Atrasado na edição') && !t.includes('Pronto'), 'emergência errada');
  await pg.evaluate(() => fecharModal());
});
await etapa('agendar: aprovado pelo cliente cai direto em agendamento', async () => {
  await db.exec(`insert into postagens (id, cliente_id, titulo, etapa, data_publicacao) values ('ap1','${cid}','Para aprovar','aprovacao', current_date + 4)`);
  const { decidir } = await import('../supabase/functions/_shared/aprovacao.ts');
  const { consultor } = await import('./banco.js');
  const [{ token_aprovacao: tk }] = await q(db, `select token_aprovacao from clientes where id=$1`, [cid]);
  await decidir(consultor(db), { token: tk, postagemId: 'ap1', decisao: 'aprovado' });
  await pg.evaluate(() => recarregarDaNuvem()); await espera(600);
  certo(await pg.evaluate(() => dados.postagens.find(p => p.id === 'ap1').etapa) === 'agendamento', 'não foi para agendamento');
});

// ---------- foco: publicar sozinho ----------
await etapa('publicar sozinho: não deixa salvar sem hora/arquivo', async () => {
  await db.exec(`update clientes set meta_pagina_id='pg1' where id='${cid}'`);
  await pg.evaluate(() => recarregarDaNuvem()); await espera(500);
  await ir(pg, 'calendario'); await pg.click('#b-nova-post'); await pg.selectOption('#po-cli', cid);
  await pg.fill('#po-tit', 'Post automático'); await pg.fill('#po-data', await pg.evaluate(() => somaDias(hojeISO(), 1)));
  await pg.check('#po-auto'); await pg.click('#po-salvar'); await espera(300);
  certo((await texto(pg, '#aviso-txt')).includes('horário'), 'deixou sem horário: ' + await texto(pg, '#aviso-txt'));
  await pg.fill('#po-hora', '10:00'); await pg.click('#po-salvar'); await espera(300);
  certo((await texto(pg, '#aviso-txt')).includes('arquivo'), 'deixou sem arquivo');
  await pg.fill('#po-link-novo', 'https://drive.google.com/x'); await pg.click('#po-add-link');
  await pg.click('#po-salvar'); await espera(300);
  certo((await texto(pg, '#aviso-txt')).includes('Drive'), 'aceitou só link do Drive');
  await pg.click('[data-m-tira="0"]');
  await pg.fill('#po-link-novo', 'https://site.com/arte.jpg'); await pg.click('#po-add-link');
  await pg.check('[data-dest="facebook"]');
  await pg.selectOption('#po-etapa', 'agendamento');
  await pg.click('#po-salvar'); await salvo(pg);
  const [p] = await q(db, `select publicar_auto, destinos, midias, arquivo, etapa, hora from postagens where titulo='Post automático'`);
  certo(p && p.publicar_auto && p.destinos.length === 2 && p.midias[0] === 'https://site.com/arte.jpg' && p.arquivo === p.midias[0] && p.etapa === 'agendamento' && p.hora === '10:00',
    'não gravou a publicação: ' + JSON.stringify(p));
});
await etapa('publicar sozinho: etiqueta no calendário/central e situação no formulário', async () => {
  const [p] = await q(db, `select id from postagens where titulo='Post automático'`);
  await ir(pg, 'producao'); await pg.click('[data-pf="tudo"]');
  certo((await texto(pg, '#kanban')).length > 0, 'kanban');
  await ir(pg, 'calendario');
  await pg.click(`.cal-p[data-post="${p.id}"]`);
  certo((await texto(pg, '#po-pub-status')).includes('Vai publicar sozinho'), 'situação: ' + await texto(pg, '#po-pub-status'));
  await pg.evaluate(() => fecharModal());
  await ir(pg, 'clientes'); await pg.click(`.cli[data-c="${cid}"]`);
  certo((await texto(pg, '#f-posts')).includes('publica sozinho'), 'sem etiqueta 🤖 na ficha');
});
await etapa('publicar sozinho: erro aparece na central, "tentar de novo" limpa', async () => {
  const [p] = await q(db, `select id from postagens where titulo='Post automático'`);
  await db.query(`update postagens set pub_status='erro', pub_erro='A Meta recusou: imagem muito pequena' where id=$1`, [p.id]);
  await pg.evaluate(() => recarregarDaNuvem()); await espera(600);
  await ir(pg, 'geral');
  certo(await pg.isVisible('#caixa-pub-erro') && (await texto(pg, '#bl-pub-erro')).includes('Post automático'), 'erro não aparece na central');
  await pg.click(`#bl-pub-erro [data-abre-post="${p.id}"]`);
  certo((await texto(pg, '#po-pub-status')).includes('imagem muito pequena'), 'erro não aparece no post');
  await pg.click('#pub-tentar'); await salvo(pg);
  const [d] = await q(db, `select pub_status, pub_erro from postagens where id=$1`, [p.id]);
  certo(d.pub_status === null && d.pub_erro === null, 'tentar de novo não limpou: ' + JSON.stringify(d));
});
await etapa('publicar agora chama o servidor', async () => {
  const [p] = await q(db, `select id from postagens where titulo='Post automático'`);
  await pg.evaluate(() => { const v = window.__funcoes.meta; window.__funcoes.meta = async b => b.acao === 'publicar' ? (window.__pub = b, { resultado: 'publicado' }) : v(b); });
  await ir(pg, 'calendario'); await pg.click(`.cal-p[data-post="${p.id}"]`);
  await pg.click('#pub-agora'); await espera(600);
  certo(await pg.evaluate(() => window.__pub?.acao === 'publicar'), 'não chamou publicar');
});
await etapa('ao vivo: quando o servidor publica, a tela atualiza sozinha', async () => {
  const [p] = await q(db, `select id from postagens where titulo='Post automático'`);
  await db.query(`update postagens set etapa='publicado', pub_status='publicado', link_publicado='https://instagram.com/p/z' where id=$1`, [p.id]);
  const row = (await q(db, `select * from postagens where id=$1`, [p.id]))[0];
  await pg.evaluate(r => window.__canais[0].h.filter(([t]) => t === 'postagens').forEach(([, fn]) => fn({ eventType: 'UPDATE', new: r })), JSON.parse(JSON.stringify(row)));
  await espera(400);
  certo(await pg.evaluate(id => dados.postagens.find(x => x.id === id).etapa, p.id) === 'publicado', 'não atualizou');
});

await etapa('central: emergência e semáforo levam à ficha', async () => {
  await ir(pg, 'geral'); await pg.click('#b-emergencia'); certo(await pg.isVisible('#em-lista'), 'sem lista'); await pg.evaluate(() => fecharModal());
  await pg.click(`#semaforo [data-c="${cid}"]`); certo(await pg.isVisible('#t-ficha'), 'não abriu ficha');
});
await etapa('tráfego: metas e verificar agora', async () => {
  await db.exec(`insert into alertas_anuncios (cliente_id,tipo,texto,chave) values ('${cid}','cpl_alto','Custo alto','x1')`);
  await pg.evaluate(() => recarregarDaNuvem()); await espera(600);
  await ir(pg, 'trafego');
  certo((await texto(pg, '#tr-alertas')).includes('Custo alto'), 'alerta não apareceu');
  await pg.click('#tr-alertas [data-resolver]'); await espera(500);
  certo((await q(db, `select resolvido_em is not null r from alertas_anuncios`))[0].r, 'resolver não gravou');
  await pg.click(`[data-metas="${cid}"]`); await pg.fill('#mt-cpl', '8'); await pg.fill('#mt-orc', '30'); await pg.click('#mt-salvar'); await salvo(pg);
  certo(Number((await q(db, `select meta_cpl_max from clientes where id=$1`, [cid]))[0].meta_cpl_max) === 8, 'meta não salvou');
  await pg.click('#b-monitorar'); await espera(600);
});
await etapa('agenda externa: marcar, editar, concluir', async () => {
  await ir(pg, 'externa'); await pg.click('#b-novo-comp');
  await pg.selectOption('#k-cli', cid); await pg.fill('#k-local', 'Rua A, 10'); await pg.selectOption('#k-resp', 'Lucas');
  await pg.click('#k-salvar'); await salvo(pg);
  const [k] = await q(db, `select id from compromissos where cliente_id=$1`, [cid]);
  certo(k, 'não marcou');
  await pg.click(`[data-edit-comp="${k.id}"]`); await pg.fill('#k-hora', '14:30'); await pg.click('#k-salvar'); await salvo(pg);
  await pg.click(`[data-ok-comp="${k.id}"]`); await salvo(pg);
  const [k2] = await q(db, `select hora, feito_em is not null f from compromissos where id=$1`, [k.id]);
  certo(k2.hora === '14:30' && k2.f, 'edição/conclusão: ' + JSON.stringify(k2));
});
await etapa('agenda (14 dias) e editar/excluir atividade com desfazer', async () => {
  await ir(pg, 'agenda');
  const id = await pg.getAttribute('#agenda [data-edit-ativ], #sem-data [data-edit-ativ]', 'data-edit-ativ');
  await pg.click(`#t-agenda [data-edit-ativ="${id}"]`); await pg.selectOption('#e-prio', 'alta'); await pg.click('#e-salvar'); await salvo(pg);
  certo((await q(db, `select prioridade from atividades where id=$1`, [id]))[0].prioridade === 'alta', 'editar');
  await pg.click(`#t-agenda [data-del="${id}"]`); await salvo(pg);
  await pg.click('#aviso-btn'); await salvo(pg);
  certo((await q(db, `select count(*)::int n from atividades where id=$1`, [id]))[0].n === 1, 'desfazer exclusão não voltou');
});
await etapa('financeiro: recebi, desfazer, cobrar, meses', async () => {
  await ir(pg, 'financeiro');
  await pg.click(`[data-pg="${cid}"]`); await salvo(pg);
  certo((await q(db, `select count(*)::int n from pagamentos where cliente_id=$1`, [cid]))[0].n === 1, 'recebi');
  await pg.click(`[data-pg="${cid}"]`); await salvo(pg);
  certo((await q(db, `select count(*)::int n from pagamentos where cliente_id=$1`, [cid]))[0].n === 0, 'desfazer');
  await pg.click('#b-mes-ant'); await pg.click('#b-mes-prox');
});
await etapa('relatórios: lista, mês, abrir e PDF', async () => {
  await ir(pg, 'relatorios'); await pg.click('#rel-ant'); await pg.click('#rel-prox');
  await pg.click(`#rel-lista [data-rel="${cid}"]`); await espera(400);
  await pg.route(/cdnjs/, r => r.continue());
  const dl = pg.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await pg.click('#rel-pdf'); const d = await dl;
  certo(d, 'PDF não baixou (sem internet para o jsPDF?)'); await pg.evaluate(() => fecharModal());
});
await etapa('ajustes: etapas (nova, subir, renomear), checklist, regras', async () => {
  await ir(pg, 'ajustes');
  await pg.click('#aj-nova-etapa');
  const n = (await pg.$$('.linha-et')).length;
  await pg.fill(`[data-et-nome="${n - 2}"]`, 'Briefing interno'); await pg.fill(`[data-et-dias="${n - 2}"]`, '12');
  await pg.click(`[data-et-sobe="${n - 2}"]`);
  await pg.fill('#aj-checklist', 'Coletar acessos | 0\nReunião | 2');
  await pg.fill('#aj-risco', '4'); await pg.uncheck('#aj-bomdia');
  await pg.click('#aj-salvar-prod'); await salvo(pg);
  const [a] = await q(db, `select etapas, checklist, config from ajustes`);
  certo(a.etapas.some(e => e.nome === 'Briefing interno') && a.checklist.length === 2 && a.config.risco_dias === 4 && a.config.bom_dia_whatsapp === false, 'ajustes: ' + JSON.stringify(a).slice(0, 300));
  await pg.click('[data-rotina="bom_dia"]'); await espera(300);
});
await etapa('backup baixar', async () => {
  const dl = pg.waitForEvent('download'); await pg.click('#b-exportar'); certo(await dl, 'sem download');
});
await etapa('histórico mostra as ações', async () => {
  await ir(pg, 'historico'); const t = await texto(pg, '#lista-log');
  for (const x of ['Cadastrou cliente', 'Criou postagem', 'Moveu postagem', 'Pediu material']) certo(t.includes(x), 'faltou ' + x);
});
await etapa('equipe abre', async () => { await ir(pg, 'equipe'); await espera(400); certo((await texto(pg, '#lista-equipe')).includes('Giovanna'), 'lista'); });
await etapa('excluir cliente leva postagens e materiais', async () => {
  await ir(pg, 'clientes'); await pg.click(`.cli[data-c="${cid}"]`); await pg.click('#b-edit-cli'); await pg.click('#c-excluir'); await salvo(pg);
  const n = (await q(db, `select (select count(*) from postagens where cliente_id=$1)+(select count(*) from materiais where cliente_id=$1)+(select count(*) from clientes where id=$1) n`, [cid]))[0].n;
  certo(Number(n) === 0, 'sobrou ' + n);
});
// (foto da página inteira derruba o navegador: página muito longa)
const errosAdmin = [...erros];
globalThis.__pgAtual = null;
await ctx.close();

// ======================= OPERADORA (Giovanna) =======================
await db.exec(`update perfis set permissoes = '{"ver_geral":true,"ver_clientes":true,"lancar":true,"concluir":true,"postagens_mover":true}' where id='${OPERADOR}';
  insert into postagens (id, cliente_id, titulo, formato, etapa, data_publicacao, responsavel) values ('pg1','c1','Rodízio','feed','pauta', current_date + 5, 'Giovanna');`);
const op = await abrir(OPERADOR, db);
await etapa('operadora: vê só o permitido', async () => {
  const menu = await texto(op.pg, '#nav');
  for (const x of ['Financeiro', 'Equipe', 'Ajustes', 'Tráfego']) certo(!menu.includes(x), 'vê ' + x);
  certo(await op.pg.isHidden('#b-novo-cli'), 'vê novo cliente');
});
await etapa('operadora: avança etapa mas não edita a postagem', async () => {
  await ir(op.pg, 'minhas');
  certo((await texto(op.pg, '#minhas-posts')).includes('Rodízio'), 'postagem dela não aparece em Minhas');
  await op.pg.click('#minhas-posts [data-avanca="pg1"]'); await salvo(op.pg);
  certo((await q(db, `select etapa from postagens where id='pg1'`))[0].etapa === 'producao', 'não avançou');
  await op.pg.click('#minhas-posts [data-abre-post="pg1"], [data-abre-post="pg1"]').catch(async () => { await ir(op.pg, 'calendario'); await op.pg.click('.cal-p[data-post="pg1"]'); });
  certo(await op.pg.isDisabled('#po-tit'), 'tema editável sem permissão');
  certo(await op.pg.isHidden('#po-excluir'), 'pode excluir');
  await op.pg.evaluate(() => fecharModal());
  certo(await op.pg.isHidden('#b-nova-post'), 'vê + Postagem');
});
const errosOp = [...op.erros];
await op.ctx.close();

// ======================= SÓ CONCLUI (Lucas), celular =======================
const lu = await abrir(SO_CONCLUI, db, 390);
await etapa('celular: telas abrem sem erro', async () => {
  for (const t of ['minhas', 'calendario', 'producao']) await lu.pg.evaluate(t => ir(t), t);
  certo(await lu.pg.isHidden('.post-item [data-avanca]') || !(await lu.pg.$('.post-item [data-avanca]')), 'Lucas pode avançar sem permissão');
});
const errosLu = [...lu.erros];
await lu.ctx.close();

// ======================= DEMONSTRAÇÃO (sem banco) =======================
const dm = await abrir(null, null);
await etapa('demonstração: todas as telas', async () => {
  for (const t of ['geral', 'minhas', 'calendario', 'producao', 'clientes', 'trafego', 'externa', 'agenda', 'lancar', 'financeiro', 'relatorios', 'historico', 'ajustes'])
    await dm.pg.evaluate(t => ir(t), t);
  await dm.pg.evaluate(() => ir('trafego')); await dm.pg.click('#b-monitorar'); await espera(800);
  await dm.pg.evaluate(() => abrirFicha('demo0')); await espera(800);
  certo((await texto(dm.pg, '#f-meta')).includes('Campanhas'), 'meta demo');
});
await etapa('demonstração: aprovação pelo link e volta pro CRM', async () => {
  const tk = await dm.pg.evaluate(() => dados.clientes.find(c => c.id === 'demo0').token);
  const id = await dm.pg.evaluate(() => dados.postagens.find(p => p.clienteId === 'demo0' && p.etapa === 'aprovacao').id);
  const ap = await dm.ctx.newPage();
  await ap.goto(base + 'aprovar.html?c=' + tk); await ap.waitForSelector('[data-sim]'); await ap.click('[data-sim]'); await ap.waitForSelector('.feito');
  await dm.pg.reload(); await dm.pg.waitForSelector('.tela.ativa');
  certo(await dm.pg.evaluate(id => dados.postagens.find(p => p.id === id).etapa, id) === 'agendamento', 'aprovação não voltou pro CRM');
});
await etapa('demonstração: post automático sai sozinho na hora', async () => {
  const id = await dm.pg.evaluate(() => { const p = dados.postagens.find(x => x.publicarAuto && x.etapa === 'agendamento'); p.data = hojeISO(); p.hora = '00:00'; return p.id; });
  await dm.pg.evaluate(() => rodadaDemo());
  certo(await dm.pg.evaluate(id => dados.postagens.find(x => x.id === id).etapa, id) === 'publicado', 'não publicou na demonstração');
});
const errosDm = [...dm.erros];
await dm.ctx.close();

console.log('\nOK (' + ok.length + '):\n  ' + ok.join('\n  '));
console.log('\nPROBLEMAS (' + problemas.length + '):\n  ' + problemas.join('\n  '));
console.log('\nERROS NA PÁGINA:\n  ' + [...errosAdmin, ...errosOp, ...errosLu, ...errosDm].join('\n  '));
await nav.close(); srv.close();
