// Testa a lógica do servidor (Cometinha, Meta, WhatsApp) sem internet:
// banco local, Meta simulada e uma "OpenAI de mentira" que segue um roteiro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, consultor, ADMIN, OPERADOR, SO_CONCLUI } from './banco.js';
import { acharPorNome, chaveTelefone, carregarPerfil, hojeSP, somaDias } from '../supabase/functions/_shared/regras.ts';
import { executar, FERRAMENTAS } from '../supabase/functions/_shared/ferramentas.ts';
import { conversar, confirmaveis, historicoLegivel } from '../supabase/functions/_shared/agente.ts';
import * as meta from '../supabase/functions/_shared/meta.ts';
import { extrairMensagens, dividir, iguais } from '../supabase/functions/_shared/whatsapp.ts';

const AGORA = new Date('2026-11-02T13:00:00Z'); // segunda, 10h em Brasília
const HOJE = '2026-11-02';

async function contexto(uid = ADMIN, extra = {}) {
  const db = await novoBanco();
  const q = consultor(db);
  const perfil = await carregarPerfil(q, uid);
  return { db, q, ctx: { q, perfil, agora: AGORA, ...extra } };
}
const rodar = async (ctx, nome, e) => {
  const r = await executar(ctx, nome, e);
  return { ...r, dados: r.erro ? null : JSON.parse(r.texto) };
};

// ---------------- regras ----------------
test('acha cliente mesmo com nome errado da transcrição', () => {
  const l = [{ id: '1', nome: 'Kyoto' }, { id: '2', nome: 'Sim Pneus' }, { id: '3', nome: 'Eu Amo Poke' }, { id: '4', nome: 'GS Car' }];
  assert.deepEqual(acharPorNome(l, 'kioto').map(x => x.id), ['1']);
  assert.deepEqual(acharPorNome(l, 'sim pneu').map(x => x.id), ['2']);
  assert.deepEqual(acharPorNome(l, 'o do poke').map(x => x.id), ['3']);
  assert.deepEqual(acharPorNome(l, 'gs car').map(x => x.id), ['4']);
  assert.deepEqual(acharPorNome(l, 'padaria').map(x => x.id), []);
});

test('número de WhatsApp bate com e sem 55 e com e sem o 9', () => {
  const k = chaveTelefone('(35) 99710-4614');
  assert.equal(k, '3597104614');
  assert.equal(chaveTelefone('5535997104614'), k);
  assert.equal(chaveTelefone('553597104614'), k);  // como a Meta costuma mandar
  assert.equal(chaveTelefone('35 9710-4614'), k);
  assert.equal(chaveTelefone('123'), '');
});

test('data de hoje é a de Brasília, não a do servidor', () => {
  assert.equal(hojeSP(new Date('2026-11-03T02:30:00Z')), '2026-11-02'); // 23h30 em Brasília
  assert.equal(somaDias('2026-11-30', 1), '2026-12-01');
});

// ---------------- ferramentas ----------------
test('panorama mostra atrasadas e semáforo', async () => {
  const { ctx } = await contexto();
  const r = await rodar(ctx, 'panorama', {});
  assert.equal(r.erro, false);
  assert.equal(r.dados.atrasadas.total, 1);                // a1 venceu em 01/11
  assert.equal(r.dados.atrasadas.itens[0].cliente, 'Kyoto');
  assert.match(r.dados.atrasadas.itens[0].quando, /ontem/);
  assert.ok(r.dados.semaforo_clientes.vermelho.includes('Kyoto'));
  assert.ok(r.dados.semaforo_clientes.verde.includes('Sim Pneus'));
});

test('criar tarefa por voz: cliente aproximado, "eu" vira quem fala', async () => {
  const { ctx, q } = await contexto(OPERADOR);
  const r = await rodar(ctx, 'criar_tarefa', { cliente: 'sim pneu', titulo: 'Stories da promoção', data: '2026-11-04', responsavel: 'eu', repetir: 'semanal' });
  assert.equal(r.erro, false, r.texto);
  assert.equal(r.dados.cliente, 'Sim Pneus');
  assert.equal(r.dados.responsavel, 'Giovanna');
  const [a] = await q(`select cliente_id, recorrencia, data::text from atividades where id = $1`, [r.dados.id]);
  assert.deepEqual(a, { cliente_id: 'c2', recorrencia: '7', data: '2026-11-04' });
  const [h] = await q(`select quem from historico order by ts desc limit 1`);
  assert.equal(h.quem, 'Giovanna (Cometinha)');
});

test('concluir tarefa que repete cria a próxima', async () => {
  const { ctx, q } = await contexto(SO_CONCLUI);
  const r = await rodar(ctx, 'concluir_tarefa', { tarefa_id: 'a1' });
  assert.equal(r.erro, false, r.texto);
  assert.ok(r.dados.proxima);
  const prox = await q(`select data::text from atividades where titulo = 'Postagem' and feita_em is null`);
  assert.deepEqual(prox, [{ data: '2026-11-08' }]); // 01/11 + 7
});

test('permissões valem também para o Cometinha', async () => {
  const { ctx } = await contexto(SO_CONCLUI);
  const r = await rodar(ctx, 'criar_tarefa', { cliente: 'Kyoto', titulo: 'X' });
  assert.equal(r.erro, true);
  assert.match(r.texto, /não tem permissão/);
  const f = await rodar(ctx, 'financeiro', {});
  assert.match(f.texto, /não tem permissão/);
  // quem não vê a agenda geral só enxerga as próprias tarefas
  const l = await rodar(ctx, 'listar_tarefas', { quando: 'abertas' });
  assert.equal(l.dados.filtro.responsavel, 'Lucas');
});

test('acesso bloqueado no meio da conversa para na hora', async () => {
  const { ctx, q } = await contexto(OPERADOR);
  await q(`update perfis set ativo = false where id = $1`, [OPERADOR]);
  const r = await rodar(ctx, 'panorama', {});
  assert.equal(r.erro, true);
  assert.match(r.texto, /desativado/);
});

test('cliente ambíguo: pede para escolher', async () => {
  const { ctx, q } = await contexto();
  await q(`insert into clientes (id, nome) values ('c9', 'Kyoto Sushi Centro')`);
  const r = await rodar(ctx, 'ver_cliente', { cliente: 'kyoto sushi' });
  assert.equal(r.dados.cliente, 'Kyoto Sushi Centro');
  const r2 = await rodar(ctx, 'ver_cliente', { cliente: 'kyot' });
  assert.equal(r2.erro, true);
  assert.match(r2.texto, /mais de um cliente/);
});

test('financeiro mostra quem está em atraso', async () => {
  const { ctx } = await contexto();
  const r = await rodar(ctx, 'financeiro', { mes: '2026-11' });
  assert.equal(r.dados.pagos, '0 de 2');
  assert.deepEqual(r.dados.em_atraso.map(x => x.cliente), []); // dia 10 e 15 ainda não chegaram (hoje é 02)
  const out = await rodar(ctx, 'financeiro', { mes: '2026-10' });
  assert.equal(out.dados.pagos, '2 de 2');
});

test('todas as ferramentas descritas têm execução', async () => {
  const { ctx } = await contexto();
  for (const f of FERRAMENTAS) {
    const r = await executar(ctx, f.name, {});
    assert.doesNotMatch(r.texto, /Ferramenta desconhecida/, f.name);
  }
});

// ---------------- Meta (simulada) ----------------
function metaFalsa(registro = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const caminho = u.pathname.replace(/^\/v[\d.]+\//, '');
    registro.push({ metodo: init.method || 'GET', caminho, corpo: init.body ? String(init.body) : null });
    const ok = d => new Response(JSON.stringify(d), { status: 200 });
    if (caminho === 'act_111') return ok({ name: 'Kyoto Ads', account_status: 1, currency: 'BRL', amount_spent: '90000', spend_cap: '100000', balance: '0', is_prepay_account: true, funding_source_details: { display_string: 'Saldo disponível (R$ 85,00 BRL)' } });
    if (caminho === 'act_111/insights') return ok({ data: [{ spend: '210.50', impressions: '30000', reach: '12000', clicks: '400', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '42' }] }] });
    if (caminho === 'act_111/campaigns') return ok({ data: [
      { id: 'cp1', name: 'Rodízio', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '3000', insights: { data: [{ spend: '200', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '40' }] }] } },
      { id: 'cp2', name: 'Delivery', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '2000' },
      { id: 'cp3', name: 'Antiga', status: 'PAUSED', effective_status: 'PAUSED', insights: { data: [{ spend: '10.5' }] } },
    ] });
    if (caminho === 'cp1' && (init.method || 'GET') === 'GET') return ok({ account_id: '111', name: 'Rodízio', status: 'ACTIVE', daily_budget: '3000' });
    if (caminho === 'cpX') return ok({ account_id: '999', name: 'De outro cliente', status: 'ACTIVE', daily_budget: '3000' });
    if (caminho === 'cp1') return ok({ success: true });
    return new Response(JSON.stringify({ error: { code: 100, error_subcode: 33, message: 'not found' } }), { status: 400 });
  };
}

test('resumo da Meta: gasto, limite, saldo, campanhas e alertas', async () => {
  const r = await meta.resumo({ token: 't', fetch: metaFalsa() }, 'act_111', '7d');
  assert.equal(r.total.gasto, 210.5);
  assert.equal(r.total.conversas, 42);
  assert.equal(r.total.custoConversa, 5.01);
  assert.equal(r.conta.gastoTotal, 900);
  assert.equal(r.conta.limite, 1000);
  assert.equal(r.conta.restanteLimite, 100);
  assert.match(r.conta.formaPagamento, /85,00/);
  assert.equal(r.campanhas[0].nome, 'Rodízio');       // ativas e com mais gasto primeiro
  assert.equal(r.campanhas[0].orcamentoDiario, 30);
  assert.ok(r.alertas.some(a => a.includes('Delivery') && a.includes('sem entrega')));
});

test('alterar campanha confere a conta antes (não mexe em cliente errado)', async () => {
  const reg = [];
  const cfg = { token: 't', fetch: metaFalsa(reg) };
  await assert.rejects(meta.alterar(cfg, '111', 'cpX', { status: 'PAUSED' }), /não é da conta/);
  assert.ok(!reg.some(x => x.metodo === 'POST'));
  const r = await meta.alterar(cfg, '111', 'cp1', { orcamentoDiario: 45 });
  assert.equal(r.depois.orcamentoDiario, 45);
  const post = reg.find(x => x.metodo === 'POST');
  assert.equal(post.corpo, 'daily_budget=4500');
  await assert.rejects(meta.alterar(cfg, '111', 'cp1', { orcamentoDiario: 9000 }), /5\.000/);
});

test('Cometinha só altera campanha depois do "sim" da pessoa', async () => {
  const reg = [];
  const { ctx, q } = await contexto(ADMIN, { meta: { tokenPadrao: 't', fetch: metaFalsa(reg) } });
  await q(`update clientes set meta_conta_id = '111' where id = 'c1'`);
  const pedido = { cliente: 'Kyoto', campanha_id: 'cp1', acao: 'pausar', confirmado: true };
  // mesmo mandando confirmado=true direto, sem o resumo antes não executa
  const r1 = await rodar(ctx, 'alterar_campanha', pedido);
  assert.equal(r1.dados.precisa_confirmar, true);
  assert.ok(!reg.some(x => x.metodo === 'POST'));

  const historico = [
    { role: 'user', content: 'pausa a campanha do rodízio' },
    { type: 'function_call', call_id: 't1', name: 'alterar_campanha', arguments: JSON.stringify({ ...pedido, confirmado: false }) },
    { type: 'function_call_output', call_id: 't1', output: r1.texto },
    { role: 'assistant', content: 'Confirma?' },
  ];
  assert.equal(confirmaveis(historico).size, 0); // ainda não respondeu
  historico.push({ role: 'user', content: 'sim' });
  ctx.confirmaveis = confirmaveis(historico);
  const r2 = await rodar(ctx, 'alterar_campanha', pedido);
  assert.equal(r2.dados.feito, true, r2.texto);
  assert.ok(reg.some(x => x.metodo === 'POST' && x.corpo === 'status=PAUSED'));
  // mudar o valor depois do "sim" exige confirmar de novo
  const r3 = await rodar(ctx, 'alterar_campanha', { ...pedido, acao: 'orcamento_diario', valor: '80' });
  assert.equal(r3.dados.precisa_confirmar, true);
});

// ---------------- ciclo da conversa (OpenAI simulada) ----------------
function roteiro(passos, chamadas = []) {
  let i = 0;
  return async corpo => {
    chamadas.push(structuredClone(corpo));
    const p = passos[i++];
    if (!p) throw new Error('roteiro acabou');
    return typeof p === 'function' ? p(corpo) : p;
  };
}
const raciocinio = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xyz' };
const texto = t => ({ output: [raciocinio, { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: t }] }] });
const usar = (call_id, name, args) => ({ output: [raciocinio, { type: 'function_call', id: 'fc_' + call_id, call_id, name, arguments: JSON.stringify(args) }] });

test('conversa completa: pergunta, ferramenta, resposta e histórico guardado', async () => {
  const { ctx, q } = await contexto(OPERADOR);
  const chamadas = [];
  const cfg = {
    chamar: roteiro([
      usar('u1', 'listar_tarefas', { quando: 'abertas', responsavel: 'eu' }),
      p => {
        const res = p.input.at(-1);
        assert.equal(res.type, 'function_call_output');
        assert.equal(res.call_id, 'u1');
        assert.match(res.output, /Postagem/);
        // dentro da mesma vez, o raciocínio do modelo volta junto
        assert.ok(p.input.some(i => i.type === 'reasoning'));
        return texto('Você tem *1 tarefa*: Postagem da Kyoto, atrasada desde ontem.');
      },
      p => {
        // na mensagem seguinte, o histórico volta sem o raciocínio interno
        assert.ok(!p.input.some(i => i.type === 'reasoning'));
        assert.ok(p.input.some(i => i.type === 'function_call' && i.call_id === 'u1'));
        return texto('De nada!');
      },
    ], chamadas),
  };
  const r1 = await conversar({ ctx, cfg, texto: 'quais são minhas tarefas?', canal: 'app' });
  assert.match(r1.resposta, /1 tarefa/);
  const p0 = chamadas[0];
  assert.equal(p0.model, 'gpt-6.1-terra');
  assert.equal(p0.store, false);
  assert.equal(p0.tools[0].type, 'function');
  assert.ok(p0.tools[0].parameters);
  assert.match(p0.input[0].content, /^\[segunda-feira, 02\/11\/2026, 10:00 · quem fala: Giovanna/);

  const r2 = await conversar({ ctx, cfg, texto: 'valeu', canal: 'app' });
  assert.equal(r2.conversaId, r1.conversaId);
  assert.equal(r2.resposta, 'De nada!');

  const leg = await historicoLegivel(q, r1.conversaId);
  assert.deepEqual(leg.map(m => m.de), ['eu', 'cometinha', 'eu', 'cometinha']);
  assert.equal(leg[0].texto, 'quais são minhas tarefas?');
});

test('conversa nova no dia seguinte', async () => {
  const { ctx } = await contexto();
  const cfg = { chamar: roteiro([texto('oi'), texto('oi de novo')]) };
  const a = await conversar({ ctx, cfg, texto: 'oi', canal: 'app' });
  const b = await conversar({ ctx: { ...ctx, agora: new Date('2026-11-03T13:00:00Z') }, cfg, texto: 'oi', canal: 'app' });
  assert.notEqual(a.conversaId, b.conversaId);
});

test('se a conversa ficou pela metade (queda no meio), começa outra em vez de quebrar', async () => {
  const { ctx } = await contexto();
  const quebra = { chamar: roteiro([usar('u1', 'panorama', {}), () => { throw new Error('queda de rede'); }]) };
  const a = await conversar({ ctx, cfg: quebra, texto: 'como estamos?', canal: 'app' }).catch(() => null);
  assert.equal(a, null);
  const chamadas = [];
  const cfg = { chamar: roteiro([texto('tudo certo')], chamadas) };
  const b = await conversar({ ctx, cfg, texto: 'e aí?', canal: 'app' });
  assert.equal(b.resposta, 'tudo certo');
  assert.equal(chamadas[0].input.length, 1); // não levou a conversa quebrada junto
});

test('limite de rodadas: na última o modelo é obrigado a responder', async () => {
  const { ctx } = await contexto();
  const chamadas = [];
  const passos = Array.from({ length: 9 }, (_, i) => usar('u' + i, 'equipe', {}));
  passos.push(p => { assert.equal(p.tool_choice, 'none'); return texto('fim'); });
  const r = await conversar({ ctx, cfg: { chamar: roteiro(passos, chamadas) }, texto: 'x', canal: 'app' });
  assert.equal(r.resposta, 'fim');
  assert.equal(chamadas.length, 10);
});

test('parâmetros quebrados viram erro explicado, não travam', async () => {
  const { ctx } = await contexto();
  const cfg = { chamar: roteiro([
    { output: [{ type: 'function_call', call_id: 'x', name: 'panorama', arguments: '{quebrado' }] },
    p => { assert.match(p.input.at(-1).output, /quebrados/); return texto('ok'); },
  ]) };
  assert.equal((await conversar({ ctx, cfg, texto: 'x', canal: 'app' })).resposta, 'ok');
});

// ---------------- WhatsApp (Evolution) ----------------
test('Evolution: lê texto e áudio, ignora grupo e o próprio chip', () => {
  const corpo = { event: 'messages.upsert', instance: 'cometinha', data: { key: { remoteJid: '553597104614@s.whatsapp.net', fromMe: false, id: 'w1' }, message: { conversation: 'oi' } } };
  const [m] = extrairMensagens(corpo);
  assert.deepEqual([m.id, m.numero, m.tipo, m.texto], ['w1', '553597104614', 'texto', 'oi']);

  const audio = extrairMensagens({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: '5535997104614@s.whatsapp.net', id: 'w2' }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' }, base64: 'AAA' } } });
  assert.deepEqual([audio[0].tipo, audio[0].audioBase64], ['audio', 'AAA']);

  const lid = extrairMensagens({ event: 'messages.upsert', data: { key: { remoteJid: '1234567@lid', senderPn: '553597104614@s.whatsapp.net', id: 'w3' }, message: { extendedTextMessage: { text: 'e aí' } } } });
  assert.equal(lid[0].numero, '553597104614');
  assert.equal(lid[0].jid, '1234567@lid'); // responde para onde veio

  assert.equal(extrairMensagens({ event: 'messages.upsert', data: { key: { remoteJid: '123@g.us', id: 'g' }, message: { conversation: 'grupo' } } }).length, 0);
  assert.equal(extrairMensagens({ event: 'messages.upsert', data: { key: { remoteJid: '5535@s.whatsapp.net', fromMe: true, id: 'f' }, message: { conversation: 'eu' } } }).length, 0);
  assert.equal(extrairMensagens({ event: 'connection.update', data: {} }).length, 0);
  assert.equal(dividir('a'.repeat(8000)).length, 3);
  assert.equal(iguais('segredo', 'segredo'), true);
  assert.equal(iguais('segredo', 'segredO'), false);
  assert.equal(iguais('', ''), false);
});
