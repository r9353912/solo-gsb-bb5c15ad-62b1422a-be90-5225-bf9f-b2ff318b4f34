'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// 只在本文件需要时惰性启动服务（端口 0 = 系统分配），避免与其他测试文件的进程互相干扰
let server;
let baseUrl;

test.before(async () => {
  const app = require('../server');
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  baseUrl = 'http://127.0.0.1:' + addr.port;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('POST /api/panel 成功拼版：返回标签索引/旋转角/全局点/SVG', async () => {
  const res = await postJson('/api/panel', {
    labels: 'EXIT\nWOMEN\nMEN',
    plateWidth: 120, plateHeight: 80
  });
  assert.equal(res.status, 200);
  const r = res.json;
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'panel');
  assert.equal(r.labelCount, 3);
  assert.deepEqual(r.labels.map(l => l.index), [1, 2, 3]);
  assert.ok(r.labels.every(l => l.rotation === 0 || l.rotation === 90));
  assert.ok(r.dots.length > 0);
  assert.match(r.svg, /<svg /);
  assert.match(r.svg, /data-label-index="1"/);
});

test('POST /api/panel labels 支持数组；放不下时 ok=false 且无部分版面', async () => {
  const ok = await postJson('/api/panel', { labels: ['ab', 'cd'], plateWidth: 120, plateHeight: 80 });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.labelCount, 2);

  const fail = await postJson('/api/panel', { labels: ['bbcdefghijklmno'], plateWidth: 90, plateHeight: 60 });
  assert.equal(fail.json.ok, false);
  assert.equal(fail.json.svg, null);
  assert.equal(fail.json.dots.length, 0);
  assert.ok(fail.json.errors.some(e => e.labelIndex === 1));
});

test('POST /api/layout 单标签接口行为不变（向后兼容）', async () => {
  const r = await postJson('/api/layout', { text: 'ab', plateWidth: 100, plateHeight: 50 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dots.length > 0, true);
  assert.doesNotMatch(r.json.svg, /data-label-index/);
});

test('POST /api/qc 质检接口可直接消费拼版结果的顶层 dots（接口兼容）', async () => {
  const panel = await postJson('/api/panel', { labels: 'a\nb', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.json.ok, true);
  const qc = await postJson('/api/qc', {
    design: panel.json.dots,
    csv: panel.json.dots.map(d => d.x + ',' + d.y).join('\n'),
    tolerance: 0.5,
    maxRadius: 2,
    plateWidth: 120,
    plateHeight: 80
  });
  assert.equal(qc.json.ok, true);
  assert.equal(qc.json.stats.missingCount, 0);
  assert.equal(qc.json.stats.extraCount, 0);
  assert.equal(qc.json.stats.passCount, panel.json.dots.length);
});

test('POST /api/qc 消费拼版 dots 时保留 label/rotation：baseline、pairs、SVG、CSV 均标注标签', async () => {
  const panel = await postJson('/api/panel', { labels: 'EXIT\nWOMEN', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.json.ok, true);
  const qc = await postJson('/api/qc', {
    design: panel.json.dots,
    csv: panel.json.dots.map(d => d.x + ',' + d.y).join('\n'),
    tolerance: 0.5,
    maxRadius: 2,
    plateWidth: 120,
    plateHeight: 80
  });
  assert.equal(qc.json.ok, true);
  // baseline 含标签数量及各标签索引/旋转角
  assert.equal(qc.json.baseline.labelCount, 2);
  assert.deepEqual(qc.json.baseline.labels.map(l => [l.index, l.rotation]),
    panel.json.labels.map(l => [l.index, l.rotation]));
  // pairs 带标签归属
  const src = panel.json.dots[0];
  assert.equal(qc.json.pairs[0].label, src.label);
  assert.equal(qc.json.pairs[0].labelRotation, src.rotation);
  // 叠加图与 CSV 标注对应标签
  assert.match(qc.json.svg, /data-label-count="2"/);
  assert.match(qc.json.svg, new RegExp('data-label="' + src.label + '"'));
  assert.match(qc.json.csv, /label_index,label_rotation_deg/);
  assert.match(qc.json.csv, /# summary,label_count,design_count/);
});

test('POST /api/path 单标签排版 dots：逐点作业顺序、优化前后统计与 CSV/SVG', async () => {
  const layout = await postJson('/api/layout', { text: 'EXIT Door 2', plateWidth: 100, plateHeight: 50 });
  assert.equal(layout.json.ok, true);
  const r = await postJson('/api/path', {
    dots: layout.json.dots,
    startX: 0, startY: 0,
    plateWidth: 100, plateHeight: 50
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const n = layout.json.dots.length;
  assert.equal(r.json.pointCount, n);
  assert.equal(r.json.steps.length, n);
  // 每个凸点恰好访问一次：原序号是 1..n 的排列
  assert.deepEqual(r.json.steps.map(s => s.seq).sort((a, b) => a - b),
    Array.from({ length: n }, (_, i) => i + 1));
  assert.deepEqual(r.json.steps.map(s => s.step), Array.from({ length: n }, (_, i) => i + 1));
  assert.ok(r.json.steps.every(s => s.label === null));
  const s = r.json.stats;
  assert.ok(s.optTravelMm <= s.nnTravelMm);
  assert.ok(s.roundsRun <= 20 && s.maxRounds === 20);
  assert.ok(s.savedPercent >= 0 && s.savedPercent <= 100);
  // CSV 表头与列
  const lines = r.json.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'step,label,x_mm,y_mm,travel_mm');
  assert.equal(lines.length, n + 1);
  assert.match(lines[1], /^1,,/);
  // SVG 带序号与方向
  assert.match(r.json.svg, /class="opt-path"/);
  assert.match(r.json.svg, /id="path-arrow"/);
  assert.match(r.json.svg, /data-step="1"/);
});

test('POST /api/path 拼版 dots：label 列填标签索引且每标签点数一致', async () => {
  const panel = await postJson('/api/panel', { labels: 'EXIT\nWOMEN\nMEN', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.json.ok, true);
  const r = await postJson('/api/path', {
    dots: panel.json.dots,
    startX: 2, startY: 3,
    plateWidth: 120, plateHeight: 80
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.steps.length, panel.json.dots.length);
  const expected = {};
  panel.json.dots.forEach(d => { expected[d.label] = (expected[d.label] || 0) + 1; });
  const actual = {};
  r.json.steps.forEach(st => { actual[st.label] = (actual[st.label] || 0) + 1; });
  assert.deepEqual(actual, expected);
  assert.equal(r.json.stats.labelCount, 3);
  const lines = r.json.csv.replace(/^﻿/, '').split('\r\n');
  assert.match(lines[1], /^1,\d+,/);
  assert.ok(lines.slice(1).every(line => line.split(',').length === 5));
});

test('POST /api/path 相同输入结果一致（两次请求 steps 完全相同）', async () => {
  const panel = await postJson('/api/panel', { labels: 'PULL\nPUSH\nMEN', plateWidth: 120, plateHeight: 80 });
  const payload = { dots: panel.json.dots, startX: 1, startY: 1, plateWidth: 120, plateHeight: 80 };
  const a = await postJson('/api/path', payload);
  const b = await postJson('/api/path', payload);
  assert.deepEqual(a.json.steps, b.json.steps);
});

test('POST /api/path 超过 2000 个点：ok=false 且不输出部分路径', async () => {
  const dots = Array.from({ length: 2001 }, (_, i) => ({ x: 5 + i * 0.05, y: 5 }));
  const r = await postJson('/api/path', { dots, startX: 0, startY: 0 });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.steps.length, 0);
  assert.equal(r.json.svg, null);
  assert.equal(r.json.csv, null);
  assert.ok(r.json.errors.some(e => /2000/.test(e.message)));
});

test('POST /api/path 参数非法（缺起点/空 dots/坐标非法）明确报错', async () => {
  const noStart = await postJson('/api/path', { dots: [{ x: 1, y: 1 }] });
  assert.equal(noStart.json.ok, false);
  assert.equal(noStart.json.svg, null);
  assert.ok(noStart.json.errors.some(e => /起点/.test(e.message)));

  const empty = await postJson('/api/path', { dots: [], startX: 0, startY: 0 });
  assert.equal(empty.json.ok, false);
  assert.equal(empty.json.steps.length, 0);

  const badDot = await postJson('/api/path', { dots: [{ x: 'oops', y: 1 }], startX: 0, startY: 0 });
  assert.equal(badDot.json.ok, false);
  assert.equal(badDot.json.csv, null);
  assert.ok(badDot.json.errors.some(e => /第 1 个凸点坐标非法/.test(e.message)));
});

test('POST /api/decode 成功解码：decodedText/cells/errors 完整', async () => {
  const res = await postJson('/api/decode', { text: '⠠⠑⠠⠭⠀⠼⠃' });
  assert.equal(res.status, 200);
  const r = res.json;
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, 'EX 2');
  assert.ok(Array.isArray(r.cells));
  assert.deepEqual(r.errors, []);
  assert.ok(r.cells.some(c => c.kind === 'caps-prefix'));
  assert.ok(r.cells.some(c => c.kind === 'number-prefix'));
  assert.deepEqual(r.cells.filter(c => c.kind === 'digit').map(c => c.char), ['2']);
  // 单元顺序：⠠ ⠑ ⠠ ⠭ ⠀ ⠼ ⠃，空格在第 5 个单元、输入位置 4
  const sp = r.cells.find(c => c.kind === 'space');
  assert.equal(sp.position, 4);
  assert.equal(sp.char, ' ');
});

test('POST /api/decode 与 /api/layout 往返一致', async () => {
  const layout = await postJson('/api/layout', { text: 'EXIT Door 2', plateWidth: 200, plateHeight: 50 });
  assert.equal(layout.json.ok, true);
  // 单行版面时 brailleText 不含换行，直接往返
  const decoded = await postJson('/api/decode', { text: layout.json.brailleText });
  assert.equal(decoded.json.ok, true);
  assert.equal(decoded.json.decodedText, 'EXIT Door 2');
});

test('POST /api/decode 未知字符逐个返回位置/码点/原因且原样保留', async () => {
  const res = await postJson('/api/decode', { text: 'a中⠿⠀' });
  assert.equal(res.status, 200);
  const r = res.json;
  assert.equal(r.ok, false);
  assert.equal(r.decodedText, 'a中⠿ '); // 非盲文字符原样保留，盲文空白单元还原为空格
  assert.equal(r.errors.length, 3);
  assert.equal(r.errors[0].type, 'unknown-char');
  assert.equal(r.errors[0].position, 0);
  assert.equal(r.errors[0].codePoint, 'U+0061');
  assert.equal(r.errors[2].type, 'unknown-pattern');
  assert.equal(r.errors[2].codePoint, 'U+283F');
  assert.ok(r.errors.every(e => /位置/.test(e.message) && /U\+/.test(e.message)));
});

test('POST /api/decode 非字符串输入返回 bad-input', async () => {
  const r = await postJson('/api/decode', { text: 123 });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.errors[0].type, 'bad-input');
});

test('GET /api/health 健康检查正常', async () => {  const r = await new Promise((resolve, reject) => {
    http.get(baseUrl + '/api/health', res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('静态资源：/lib/panel.js 与首页可访问', async () => {
  const fetchText = path => new Promise((resolve, reject) => {
    http.get(baseUrl + path, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
  const lib = await fetchText('/lib/panel.js');
  assert.equal(lib.status, 200);
  assert.match(lib.body, /packLabels/);
  const pathLib = await fetchText('/lib/path.js');
  assert.equal(pathLib.status, 200);
  assert.match(pathLib.body, /planPath/);
  const page = await fetchText('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /tabPanel/);
  assert.match(page.body, /多标签拼版/);
  assert.match(page.body, /点阵解码/);
  assert.match(page.body, /\/api\/decode|decodeInput/);
  assert.match(page.body, /压印路径/);
});
