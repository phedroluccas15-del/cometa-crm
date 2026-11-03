// Publicação automática no Instagram/Facebook, com a Meta simulada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, consultor, comoUsuario, SO_CONCLUI } from './banco.js';
import { momento, publicarAgora, publicarPendentes, tipoPub } from '../supabase/functions/_shared/publicar.ts';

const linhas = async (db, sql, p) => (await db.query(sql, p)).rows;

/** Meta de mentira: guarda cada chamada; vídeos ficam "processando" até liberar */
function metaFalsa({ processando = new Set(), recusa = new Set() } = {}) {
  const reg = []; let n = 0;
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const c = u.pathname.replace(/^\/v[\d.]+\//, '');
    const metodo = init.method || 'GET';
    const corpo = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    reg.push({ metodo, c, corpo });
    const ok = d => new Response(JSON.stringify(d), { status: 200 });
    if (c === 'pg1' && metodo === 'GET') return ok({ name: 'Kyoto', access_token: 'tok-pagina', instagram_business_account: { id: 'ig1', username: 'kyoto' } });
    if (c === 'ig1/media' && metodo === 'POST') {
      const id = 'cont' + (++n);
      if (corpo.video_url && processando.size) processando.add(id);
      return ok({ id });
    }
    if (c.startsWith('cont') && metodo === 'GET') return ok({ status_code: recusa.has(c) ? 'ERROR' : processando.has(c) ? 'IN_PROGRESS' : 'FINISHED' });
    if (c === 'ig1/media_publish') return ok({ id: 'midia' + (++n) });
    if (c.startsWith('midia')) return ok({ permalink: 'https://instagram.com/p/' + c });
    if (c === 'pg1/photos') return ok({ id: 'foto' + (++n), post_id: 'pg1_' + n });
    if (c === 'pg1/feed') return ok({ id: 'pg1_feed' });
    if (c === 'pg1/videos') return ok({ id: 'video1' });
    if (c.startsWith('pg1_')) return ok({ permalink_url: 'https://facebook.com/' + c });
    return new Response(JSON.stringify({ error: { code: 100, message: 'não simulado ' + c } }), { status: 400 });
  };
  return { f, reg, processando };
}

async function cenario(posts, metaOpts) {
  const db = await novoBanco();
  await db.exec(`update clientes set meta_pagina_id = 'pg1' where id = 'c1'`);
  for (const p of posts) {
    await db.query(`insert into postagens (id, cliente_id, titulo, formato, etapa, data_publicacao, hora, legenda, midias, destinos, publicar_auto, responsavel)
      values ($1,'c1',$2,$3,$4,$5,$6,$7,$8,$9,$10,'Dono')`,
      [p.id, p.titulo || p.id, p.formato || 'feed', p.etapa || 'agendamento', p.data || '2026-11-03', p.hora || '18:00', p.legenda || 'Legenda ' + p.id,
        JSON.stringify(p.midias || ['storage:c1/' + p.id + '/foto.jpg']), JSON.stringify(p.destinos || ['instagram']), p.auto ?? true]);
  }
  const meta = metaFalsa(metaOpts);
  const avisos = [];
  const d = agora => ({ q: consultor(db), agora, meta: { tokenPadrao: 'tok', fetch: meta.f },
    assinar: async c => 'https://arquivos.supabase.co/assinado/' + c, enviar: async (num, t) => avisos.push([num, t]) });
  return { db, meta, avisos, d };
}

test('horário de Brasília e tipo de publicação', () => {
  assert.equal(momento('2026-11-03', '18:00').toISOString(), '2026-11-03T21:00:00.000Z');
  assert.equal(tipoPub('feed', 1, false), 'imagem');
  assert.equal(tipoPub('feed', 3, false), 'carrossel');
  assert.equal(tipoPub('reels', 1, true), 'reels');
  assert.equal(tipoPub('stories', 1, false), 'stories');
});

test('só publica quando chega a hora, uma vez só, e marca como publicado com o link', async () => {
  const { db, meta, d } = await cenario([{ id: 'p1', hora: '18:00' }, { id: 'p2', auto: false }, { id: 'p3', etapa: 'edicao' }]);
  const antes = await publicarPendentes(d(new Date('2026-11-03T20:55:00Z'))); // 17h55 em Brasília
  assert.equal(antes.publicadas, 0);
  assert.equal(meta.reg.filter(r => r.metodo === 'POST').length, 0);

  const r = await publicarPendentes(d(new Date('2026-11-03T21:01:00Z'))); // 18h01
  assert.equal(r.publicadas, 1);
  const cria = meta.reg.find(x => x.c === 'ig1/media');
  assert.equal(cria.corpo.image_url, 'https://arquivos.supabase.co/assinado/c1/p1/foto.jpg');
  assert.equal(cria.corpo.caption, 'Legenda p1');
  const [p1] = await linhas(db, `select etapa, pub_status, link_publicado, eventos from postagens where id='p1'`);
  assert.deepEqual([p1.etapa, p1.pub_status, p1.link_publicado], ['publicado', 'publicado', 'https://instagram.com/p/midia2']);
  assert.match(p1.eventos.at(-1).txt, /Publicado no Instagram/);
  // p2 (sem publicar sozinho) e p3 (ainda em edição) não saem
  assert.deepEqual((await linhas(db, `select id, etapa from postagens where id in ('p2','p3') order by id`)).map(x => x.etapa), ['agendamento', 'edicao']);

  // rodada seguinte: nada é publicado de novo
  await publicarPendentes(d(new Date('2026-11-03T21:06:00Z')));
  assert.equal(meta.reg.filter(x => x.c === 'ig1/media_publish').length, 1);
});

test('Reels: espera o Instagram processar o vídeo e publica na rodada seguinte', async () => {
  const { db, meta, d } = await cenario([{ id: 'v1', formato: 'reels', midias: ['storage:c1/v1/video.mp4'] }], { processando: new Set(['x']) });
  const agora = new Date('2026-11-03T22:00:00Z');
  const r1 = await publicarPendentes(d(agora));
  assert.equal(r1.processando, 1);
  assert.equal(meta.reg.find(x => x.c === 'ig1/media').corpo.media_type, 'REELS');
  assert.equal((await linhas(db, `select pub_status from postagens`))[0].pub_status, 'processando');
  meta.processando.clear(); // terminou de processar
  const r2 = await publicarPendentes(d(new Date(agora.getTime() + 5 * 60e3)));
  assert.equal(r2.publicadas, 1);
  assert.equal(meta.reg.filter(x => x.c === 'ig1/media').length, 1, 'não cria o vídeo de novo');
});

test('carrossel no Instagram e no Facebook ao mesmo tempo', async () => {
  const { db, meta, d } = await cenario([{ id: 'c', formato: 'carrossel', destinos: ['instagram', 'facebook'],
    midias: ['storage:c1/c/1.jpg', 'storage:c1/c/2.jpg', 'https://site.com/3.jpg'] }]);
  await publicarPendentes(d(new Date('2026-11-04T12:00:00Z')));
  const ig = meta.reg.filter(x => x.c === 'ig1/media');
  assert.equal(ig.length, 4); // 3 itens + o carrossel
  assert.equal(ig.at(-1).corpo.media_type, 'CAROUSEL');
  assert.equal(ig.at(-1).corpo.children.split(',').length, 3);
  assert.equal(meta.reg.filter(x => x.c === 'pg1/photos').length, 3);
  assert.ok(meta.reg.some(x => x.c === 'pg1/feed' && x.corpo['attached_media[2]']));
  const [p] = await linhas(db, `select etapa, eventos from postagens`);
  assert.equal(p.etapa, 'publicado');
  assert.match(p.eventos.at(-1).txt, /Instagram e Facebook/);
});

test('erro: avisa o responsável no WhatsApp e não fica tentando sozinho', async () => {
  const { db, meta, avisos, d } = await cenario([{ id: 'e1', midias: ['https://drive.google.com/file/d/abc'] }]);
  const r = await publicarPendentes(d(new Date('2026-11-04T12:00:00Z')));
  assert.equal(r.erros, 1);
  const [p] = await linhas(db, `select etapa, pub_status, pub_erro from postagens`);
  assert.equal(p.pub_status, 'erro');
  assert.match(p.pub_erro, /Drive/);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0][1], /Não consegui publicar/);
  await publicarPendentes(d(new Date('2026-11-04T12:05:00Z')));
  assert.equal(avisos.length, 1, 'não insiste nem manda aviso de novo');
  assert.equal(meta.reg.filter(x => x.metodo === 'POST').length, 0);
});

test('Instagram saiu e Facebook falhou: ao tentar de novo, não repete o Instagram', async () => {
  const { db, meta, d } = await cenario([{ id: 'x', destinos: ['instagram', 'facebook'] }]);
  const f0 = meta.f; let falhaFb = true;
  const dep = agora => ({ ...d(agora), meta: { tokenPadrao: 'tok', fetch: async (u, i) => (falhaFb && /pg1\/photos/.test(u) ? new Response('{"error":{"code":1,"message":"fora do ar"}}', { status: 500 }) : f0(u, i)) } });
  await publicarPendentes(dep(new Date('2026-11-04T12:00:00Z')));
  assert.equal((await linhas(db, `select pub_status from postagens`))[0].pub_status, 'erro');
  falhaFb = false;
  const r = await publicarAgora(dep(new Date('2026-11-04T12:10:00Z')), 'x');
  assert.equal(r.resultado, 'publicado');
  assert.equal(meta.reg.filter(x => x.c === 'ig1/media_publish').length, 1, 'Instagram publicado uma vez só');
});

test('publicação travada no meio vira erro (não arrisca publicar duas vezes)', async () => {
  const { db, d } = await cenario([{ id: 't' }]);
  await db.exec(`update postagens set pub_status = 'publicando', pub_desde = '2026-11-04T11:00:00Z'`);
  await publicarPendentes(d(new Date('2026-11-04T12:00:00Z')));
  const [p] = await linhas(db, `select pub_status, pub_erro, etapa from postagens`);
  assert.equal(p.pub_status, 'erro');
  assert.match(p.pub_erro, /interrompida/);
});

test('quem só move etapa não liga a publicação automática', async () => {
  const { db } = await cenario([{ id: 'k', auto: false }]);
  await db.exec(`update perfis set permissoes = '{"postagens_mover":true}' where id = '${SO_CONCLUI}'`);
  await comoUsuario(db, SO_CONCLUI, async () => {
    await assert.rejects(db.query(`update postagens set publicar_auto = true where id = 'k'`), /sem permissão/);
    await db.query(`update postagens set pub_status = null, pub_erro = null where id = 'k'`); // "tentar de novo" pode
  });
});
