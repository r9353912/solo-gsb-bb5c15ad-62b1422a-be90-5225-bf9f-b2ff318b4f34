'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Panel = require('../lib/panel');

const P = { plateWidth: 120, plateHeight: 80, dotSpacing: 2.5, lineSpacing: 10, margin: 5 };

/* ---------- 输入解析 ---------- */

test('parseLabels：字符串按行切分，去首尾空白，跳过纯空白行', () => {
  const r = Panel.parseLabels(' EXIT \n\n  \nWOMEN');
  assert.equal(r.items.length, 2);
  assert.equal(r.skippedBlank, 2);
  assert.deepEqual(r.items.map(i => [i.index, i.line, i.text]), [
    [1, 1, 'EXIT'],
    [2, 4, 'WOMEN']
  ]);
});

test('parseLabels：支持字符串数组', () => {
  const r = Panel.parseLabels(['ab', ' ', 'cd']);
  assert.deepEqual(r.items.map(i => i.text), ['ab', 'cd']);
  assert.equal(r.skippedBlank, 1);
});

/* ---------- 基本拼版：复用单标签转换 + 行级装箱 ---------- */

test('多条标签拼版成功：返回标签索引、0° 旋转、整板尺寸与凸点', () => {
  const r = Panel.packLabels({ labels: 'EXIT\nWOMEN\nMEN', ...P });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.labelCount, 3);
  assert.equal(r.stats.labelCount, 3);
  assert.equal(r.stats.rotatedCount, 0);

  // EXIT 宽44.5、WOMEN 宽56.5、间距5 => 同行 44.5+5+56.5=106 <= 有效宽110；MEN 新开一行
  assert.deepEqual(r.labels.map(l => l.index), [1, 2, 3]);
  assert.deepEqual(r.labels.map(l => l.rotation), [0, 0, 0]);
  assert.deepEqual([r.labels[0].x, r.labels[0].y], [5, 5]);
  assert.deepEqual([r.labels[1].x, r.labels[1].y], [54.5, 5]);
  assert.deepEqual([r.labels[2].x, r.labels[2].y], [5, 15]);
  assert.equal(r.stats.packWidth, 106);
  assert.equal(r.stats.packHeight, 15); // 两行，高 5+5+间距5

  // 顶层展平点带标签索引与旋转角；labels 内为该标签自己的点
  assert.ok(r.dots.every(d => d.label >= 1 && d.rotation === 0));
  const byLabel = r.dots.reduce(function (m, d) { m[d.label] = (m[d.label] || 0) + 1; return m; }, {});
  assert.deepEqual(byLabel, { 1: 16, 2: 21, 3: 12 });
  assert.equal(r.labels[0].dots.length, 16);

  // 全局点坐标与标签局部点一致（0° 平移）
  const p0 = r.labels[0].dots[0];
  assert.equal(p0.x, 5 + p0.localX);
  assert.equal(p0.y, 5 + p0.localY);

  assert.match(r.svg, /^<\?xml/);
  assert.match(r.svg, /width="120mm"/);
  assert.equal((r.svg.match(/data-label-index="1"/g) || []).length, 1);
  assert.match(r.svg, /class="label-bounds"/);
});

test('空白行被跳过并计入 skippedBlank；纯空白输入报 label-empty', () => {
  const r = Panel.packLabels({ labels: 'ab\n\n  \ncd', ...P });
  assert.equal(r.ok, true);
  assert.equal(r.stats.labelCount, 2);
  assert.equal(r.stats.skippedBlank, 2);

  const e = Panel.packLabels({ labels: '\n  \n', ...P });
  assert.equal(e.ok, false);
  assert.equal(e.svg, null);
  assert.ok(e.errors.some(x => x.type === 'label-empty'));
});

/* ---------- 旋转 90° ---------- */

test('0° 放不下而 90° 可放时自动旋转；凸点按顺时针 90° 全局映射且不越边距', () => {
  // 15 个小写单元：宽 2.5+14*6=86.5，高 5；有效幅面 85×90
  // 0° 宽 86.5>85 不可；90° 后占地 5×86.5 可放
  const r = Panel.packLabels({ labels: 'bbcdefghijklmno', plateWidth: 95, plateHeight: 100 });
  assert.equal(r.ok, true);
  const l = r.labels[0];
  assert.equal(l.rotation, 90);
  assert.deepEqual(l.bounds, { x: 5, y: 5, width: 5, height: 86.5 });
  // 锚点为局部原点（矩形右上角）
  assert.equal(l.x, 10);
  assert.equal(l.y, 5);

  // 局部点（字母 b = 点1+点2）：(0,0) -> 全局 (x, y) = (10,5)；(0,2.5) -> (x-2.5,y) = (7.5,5)；
  // 第二单元点1 局部 (6,0) -> (x, y+6) = (10,11)
  const d1 = l.dots.find(d => d.cell === 1 && d.dot === 1);
  const d2 = l.dots.find(d => d.cell === 1 && d.dot === 2);
  const c2d1 = l.dots.find(d => d.cell === 2 && d.dot === 1);
  assert.ok(d1 && d2 && c2d1, '字母 b 含点1、点2，第二单元为 c 含点1');
  assert.deepEqual([d1.x, d1.y], [10, 5]);
  assert.deepEqual([d2.x, d2.y], [7.5, 5]);
  assert.deepEqual([c2d1.x, c2d1.y], [10, 11]);

  // 所有点必须在板材边距以内
  r.dots.forEach(d => {
    assert.ok(d.x >= 5 - 1e-9 && d.x <= 90 + 1e-9, 'x 在有效幅面内: ' + d.x);
    assert.ok(d.y >= 5 - 1e-9 && d.y <= 95 + 1e-9, 'y 在有效幅面内: ' + d.y);
  });
  assert.match(r.svg, /rotate\(90\)/);
});

/* ---------- 装箱择优：剩余面积最小 -> y -> x -> 0° ---------- */

test('同行放得下时优先填现有行（剩余面积最小），而非新开行', () => {
  const r = Panel.packLabels({ labels: 'EXIT\nWOMEN', ...P });
  // 两个标签均在第一行（y=5），packHeight 仅一行高度 5
  assert.deepEqual(r.labels.map(l => l.y), [5, 5]);
  assert.equal(r.stats.packHeight, 5);
});

test('货架高度随旋转标签增高，后续行 y 正确下移', () => {
  // 两个需要 90° 的长标签（占地 5×86.5）+ 一个短标签；板材有效 85×190
  const r = Panel.packLabels({ labels: 'abcdefghijklmno\nabcdefghijklmno\nab',
    plateWidth: 95, plateHeight: 200, labelGap: 4 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.labels.map(l => l.rotation), [90, 90, 90]);
  // 第1行 y=5 高86.5，间距4 => 第2行 y=95.5；再 +86.5+4 => 第3行 y=186
  assert.deepEqual(r.labels.map(l => l.y), [5, 95.5, 186]);
  assert.equal(r.stats.packHeight, 189.5);
});

test('旋转标签纵向优先（包围盒面积更小）；纵向放满后横向填入最上方行（y 决胜）', () => {
  // 旋转标签各占地 5×86.5、间距 2；有效幅面 20×175：
  //   标签1 -> 第1行；标签2：同横排包围盒 12×86.5=1038 ＞ 新开竖行 5×175=875，故竖排到第2行；
  //   标签3：第3行需 263.5 >175 不可，只能横排进第1/2行，两者包围盒相同，y 小者（第1行）胜。
  const r = Panel.packLabels({ labels: 'bbcdefghijklmno\nbbcdefghijklmno\nbbcdefghijklmno',
    plateWidth: 30, plateHeight: 185, margin: 5, labelGap: 2 });
  assert.equal(r.ok, true);
  assert.ok(r.labels.every(l => l.rotation === 90));
  // 按输入索引：标签1 第1行左、标签2 第2行左、标签3 第1行第二个（左缘12、锚点17）
  assert.deepEqual(r.labels.map(l => l.bounds.x), [5, 5, 12]);
  assert.deepEqual(r.labels.map(l => l.x), [10, 10, 17]); // 锚点=右边缘
  assert.deepEqual(r.labels.map(l => l.y), [5, 93.5, 5]);
  assert.equal(r.stats.packWidth, 12);
  assert.equal(r.stats.packHeight, 175);
});

/* ---------- 失败语义：逐条原因，不输出部分版面 ---------- */

test('任一朝向都超出有效幅面：返回该标签原因且 svg/dots 为空', () => {
  // 宽 86.5×高5，有效幅面 80×50：0° 宽超、90° 高超（86.5>50）
  const r = Panel.packLabels({ labels: 'bbcdefghijklmno', plateWidth: 90, plateHeight: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.svg, null);
  assert.equal(r.dots.length, 0);
  assert.equal(r.labels.length, 0);
  const err = r.errors.find(e => e.type === 'label-too-wide');
  assert.ok(err);
  assert.equal(err.labelIndex, 1);
  assert.match(err.message, /标签 #1/);
  assert.match(err.message, /86\.5/);
});

test('不支持字符：逐条报 label-unsupported-char 且不输出版面', () => {
  const r = Panel.packLabels({ labels: 'café\nok', ...P });
  assert.equal(r.ok, false);
  assert.equal(r.svg, null);
  const err = r.errors.find(e => e.type === 'label-unsupported-char');
  assert.ok(err);
  assert.equal(err.labelIndex, 1);
  assert.match(err.message, /标签 #1/);
});

test('装箱阶段无处可放：报 label-pack-fail（逐条），前面能放的标签也不输出', () => {
  // 有效幅面 8×178：第一个旋转标签（5×86.5）可放；横向余 3 容不下第二个（需 5+2），
  // 纵向第二行需要 86.5+2+86.5=175 <=178 本可……故有效高取 90，第二行也放不下。
  const long = 'bbcdefghijklmno';
  const r = Panel.packLabels({
    labels: [long, long].join('\n'),
    plateWidth: 18, plateHeight: 100, margin: 5, labelGap: 2
  });
  assert.equal(r.ok, false);
  assert.equal(r.svg, null);
  assert.equal(r.dots.length, 0); // 不输出部分版面
  const err = r.errors.find(e => e.type === 'label-pack-fail');
  assert.ok(err);
  assert.equal(err.labelIndex, 2);
});

test('多条问题一次返回全部逐条原因', () => {
  const r = Panel.packLabels({ labels: 'café\n§§\nok', ...P });
  assert.equal(r.ok, false);
  const idx = r.errors.filter(e => e.labelIndex != null).map(e => e.labelIndex).sort();
  assert.deepEqual(idx, [1, 2]);
});

/* ---------- 参数校验与统计 ---------- */

test('标签间距不能为负数；超过标签条数上限报错', () => {
  const r1 = Panel.packLabels({ labels: 'ab', labelGap: -1, ...P });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some(e => /标签间距/.test(e.message)));

  const many = Array.from({ length: Panel.MAX_LABELS + 1 }, function (_, i) { return 'a' + i; }).join('\n');
  const r2 = Panel.packLabels({ labels: many, plateWidth: 1000, plateHeight: 1000 });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => /最多拼版/.test(e.message)));
});

test('剩余面积 = 已装包围盒面积 − 标签面积；旋转标签面积不变', () => {
  const r = Panel.packLabels({ labels: 'bbcdefghijklmno', plateWidth: 95, plateHeight: 100 });
  assert.equal(r.ok, true);
  // 旋转后占地 5×86.5，恰好等于标签面积 86.5×5 => 剩余面积 0
  assert.equal(r.stats.labelArea, round(86.5 * 5));
  assert.equal(r.stats.packWidth, 5);
  assert.equal(r.stats.packHeight, 86.5);
  assert.equal(r.stats.remainingArea, 0);
});

test('JSON 输出：labels 含 sourceLine/文本/旋转角/包围盒，顶层 dots 可作质检基准', () => {
  const r = Panel.packLabels({ labels: 'a\n\nb', ...P });
  assert.equal(r.ok, true);
  assert.equal(r.labels[0].sourceLine, 1);
  assert.equal(r.labels[1].sourceLine, 3); // 第二行是空行
  assert.equal(r.labels[0].text, 'a');
  assert.ok(Number.isFinite(r.labels[0].bounds.x));
  // 顶层点结构与单标签排版 dots 兼容（x/y/r）
  r.dots.forEach(d => {
    assert.equal(typeof d.x, 'number');
    assert.equal(typeof d.y, 'number');
    assert.ok(d.r > 0);
  });
});

test('共享板材/点距非法参数被拒绝（复用单标签校验）', () => {
  const r = Panel.packLabels({ labels: 'ab', plateWidth: -1, plateHeight: 80 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /板材宽度/.test(e.message)));
});

function round(n) { return Math.round(n * 1000) / 1000; }
