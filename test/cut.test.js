'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PanelCut = require('../lib/cut');
const Panel = require('../lib/panel');

const P = { plateWidth: 120, plateHeight: 80 };

// 成功拼版结果（EXIT/WOMEN 同一货架，MEN 第二货架）
function panelOf(labels, opts = {}) {
  const r = Panel.packLabels(Object.assign({ labels, plateWidth: 120, plateHeight: 80 }, opts));
  assert.equal(r.ok, true, '前置拼版必须成功');
  return r;
}

function cutOf(panel, margin, toolRadius, extra = {}) {
  return PanelCut.planCuts(Object.assign({
    labels: panel.labels,
    plateWidth: panel.params.plateWidth,
    plateHeight: panel.params.plateHeight,
    margin, toolRadius
  }, extra));
}

/* ---------- 几何：包络 -> 成品边 -> 刀心线 ---------- */

test('成功生成裁切线：成品边 = 凸点包络外扩留边，刀心线 = 成品边外扩刀径', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN');
  const r = cutOf(panel, 1, 0.5);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.cuts.length, 3);

  // 用标签全局点+点半径独立复算包络
  panel.labels.forEach(lb => {
    const cut = r.cuts.find(c => c.label === lb.index);
    assert.ok(cut);
    const xs = lb.dots.map(d => d.x - d.r).concat(lb.dots.map(d => d.x + d.r));
    const ys = lb.dots.map(d => d.y - d.r).concat(lb.dots.map(d => d.y + d.r));
    const eL = Math.min(...xs), eR = Math.max(...xs), eT = Math.min(...ys), eB = Math.max(...ys);
    assert.deepEqual([cut.envelope.left, cut.envelope.right, cut.envelope.top, cut.envelope.bottom],
      [r3(eL), r3(eR), r3(eT), r3(eB)]);
    assert.equal(cut.finish.left, r3(eL - 1));
    assert.equal(cut.finish.right, r3(eR + 1));
    assert.equal(cut.tool.left, r3(eL - 1.5));
    assert.equal(cut.tool.right, r3(eR + 1.5));
    assert.equal(cut.tool.top, cut.finish.top - 0.5);
    assert.equal(cut.tool.bottom, cut.finish.bottom + 0.5);
    assert.equal(cut.tool.width, cut.finish.width + 1);
    // 四角顺时针 tl/tr/br/bl
    assert.deepEqual(cut.finish.corners.tl, { x: cut.finish.left, y: cut.finish.top });
    assert.deepEqual(cut.finish.corners.br, { x: cut.finish.right, y: cut.finish.bottom });
    assert.deepEqual(cut.finish.corners.bl, { x: cut.finish.left, y: cut.finish.bottom });
    assert.equal(cut.text, lb.text);
    assert.equal(cut.rotation, lb.rotation);
  });
});

test('旋转 90° 标签：全部按全局凸点坐标计算，与局部朝向无关', () => {
  const panel = panelOf('bbcdefghijklmno', { plateWidth: 95, plateHeight: 100 });
  assert.equal(panel.labels[0].rotation, 90);
  const r = cutOf(panel, 2, 1);
  assert.equal(r.ok, true);
  const cut = r.cuts[0];
  const lb = panel.labels[0];
  const xs = lb.dots.map(d => d.x - d.r).concat(lb.dots.map(d => d.x + d.r));
  const ys = lb.dots.map(d => d.y - d.r).concat(lb.dots.map(d => d.y + d.r));
  assert.equal(cut.envelope.left, r3(Math.min(...xs)));
  assert.equal(cut.envelope.bottom, r3(Math.max(...ys)));
  assert.equal(cut.rotation, 90);
  // 该标签包络 [4.25,10.75]×[4.25,92.25]：上板边约束 4.25-1=3.25 最紧
  assert.equal(r.maxMargin, 3.25);
  // 刀心线在可行留边下不越板
  assert.ok(cut.tool.left >= 0 - 1e-9 && cut.tool.top >= 0 - 1e-9);
  assert.ok(cut.tool.right <= 95 + 1e-9 && cut.tool.bottom <= 100 + 1e-9);
});

test('导出的 axisGap / expanded 几何助手与定义一致', () => {
  const a = { left: 0, top: 0, right: 10, bottom: 5 };
  assert.deepEqual(PanelCut.axisGap(a, { left: 20, top: 0, right: 30, bottom: 5 }), { x: 10, y: 0 });
  assert.deepEqual(PanelCut.axisGap(a, { left: 5, top: 8, right: 12, bottom: 20 }), { x: 0, y: 3 });
  assert.deepEqual(PanelCut.axisGap(a, { left: 2, top: 2, right: 8, bottom: 4 }), { x: 0, y: 0 });
  const e = PanelCut.expanded(a, 2);
  assert.deepEqual([e.left, e.top, e.right, e.bottom], [-2, -2, 12, 7]);
});

/* ---------- 最大统一留边 ---------- */

test('最大统一留边：默认拼版下受标签对 #1↔#3 刀具占位约束（1.25mm）', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN');
  const r = cutOf(panel, 1, 0.5);
  assert.equal(r.ok, true);
  assert.equal(r.maxMargin, 1.25);
  assert.ok(r.binding.length > 0);
  // binding 按 limit 升序，首条即最紧约束
  assert.equal(r.binding[0].kind, 'pair');
  assert.deepEqual([r.binding[0].labelA, r.binding[0].labelB], [1, 3]);
  assert.equal(r.binding[0].gapYMm, 3.5);
  assert.equal(r.stats.marginHeadroom, 0.25);
});

test('板边约束：贴板边的单标签，maxMargin = 包络到板边距离 − 刀径', () => {
  const panel = panelOf('ab', { plateWidth: 20, plateHeight: 15, margin: 5 });
  const r = cutOf(panel, 2, 2);
  assert.equal(r.ok, true);
  assert.equal(r.maxMargin, 2.25); // 包络到左/上板边 4.25 − R 2
  assert.equal(r.binding[0].kind, 'plate');
  assert.ok(['left', 'top'].includes(r.binding[0].edge));
});

test('取留边 = maxMargin（边界）可行：刀心线恰好贴板边/占位矩形恰好相接', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN');
  const r = cutOf(panel, 1.25, 0.5);
  assert.equal(r.ok, true);
  assert.equal(r.stats.marginHeadroom, 0);
  // 任意两条刀心占位矩形不得在内部相交（允许边/角相接）
  for (let i = 0; i < r.cuts.length; i++) {
    for (let j = i + 1; j < r.cuts.length; j++) {
      const a = r.cuts[i].tool, b = r.cuts[j].tool;
      const overlapX = a.right > b.left + 1e-6 && b.right > a.left + 1e-6;
      const overlapY = a.bottom > b.top + 1e-6 && b.bottom > a.top + 1e-6;
      assert.ok(!(overlapX && overlapY), '刀心占位矩形不得内部相交: #' + a + ' vs #' + b);
    }
  }
});

/* ---------- 超限与失败语义 ---------- */

test('输入留边超过标签对上限：ok=false，指出限制的标签对，且不输出部分刀路', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN');
  const r = cutOf(panel, 3, 0.5);
  assert.equal(r.ok, false);
  assert.equal(r.maxMargin, 1.25);
  assert.equal(r.cuts.length, 0);
  assert.equal(r.svg, null);
  assert.equal(r.csv, null);
  const pair = r.errors.find(e => e.type === 'label-pair-limit');
  assert.ok(pair);
  assert.deepEqual([pair.labelA, pair.labelB], [1, 3]);
  assert.equal(pair.gapYMm, 3.5);
  assert.match(pair.message, /标签 #1 与 #3/);
  assert.match(pair.message, /1\.25 mm/);
  // 首条错误即决定 maxMargin 的最紧约束
  assert.equal(r.errors[0].type, 'label-pair-limit');
  assert.deepEqual([r.errors[0].labelA, r.errors[0].labelB], [1, 3]);
});

test('输入留边超过板边上限：错误类型 plate-edge-limit 且带 edge/标签编号', () => {
  const panel = panelOf('ab', { plateWidth: 20, plateHeight: 15, margin: 5 });
  const r = cutOf(panel, 3, 2);
  assert.equal(r.ok, false);
  assert.equal(r.cuts.length, 0);
  assert.equal(r.svg, null);
  assert.equal(r.csv, null);
  const e = r.errors.find(x => x.type === 'plate-edge-limit');
  assert.ok(e);
  assert.equal(e.labelIndex, 1);
  assert.ok(['left', 'right', 'top', 'bottom'].includes(e.edge));
  assert.match(e.message, /板边约束/);
  assert.match(e.message, /3 mm 超过/);
});

test('maxMargin < 0：留边 0 也放不下，报 no-feasible-margin 且无任何刀路', () => {
  // 板材宽恰好等于标签局部宽，margin=0 时凸点包络已伸出 0.75；R=1 -> 上限 -1.75
  const panel = panelOf('abcdefghij', { plateWidth: 65.5, plateHeight: 6, margin: 0 });
  const r = cutOf(panel, 0, 1);
  assert.equal(r.ok, false);
  assert.equal(r.maxMargin, -1.75);
  assert.equal(r.cuts.length, 0);
  assert.equal(r.svg, null);
  assert.equal(r.csv, null);
  assert.ok(r.errors.some(e => e.type === 'no-feasible-margin'));
  assert.ok(r.errors.some(e => e.type === 'plate-edge-limit'));
});

/* ---------- 参数与数据校验 ---------- */

test('参数非法：留边负/非数、刀径非正、板材非正、缺 labels 均报错且无部分输出', () => {
  const panel = panelOf('ab');
  function fail(extra, typeRe) {
    const r = PanelCut.planCuts(Object.assign({
      labels: panel.labels, plateWidth: 120, plateHeight: 80, margin: 1, toolRadius: 0.5
    }, extra));
    assert.equal(r.ok, false);
    assert.equal(r.cuts.length, 0);
    assert.equal(r.svg, null);
    assert.equal(r.csv, null);
    if (typeRe) assert.ok(r.errors.some(e => typeRe.test(e.message)), '期望匹配 ' + typeRe);
  }
  fail({ margin: -0.1 }, /留边不能为负/);
  fail({ margin: 'x' }, /留边必须是数字/);
  fail({ toolRadius: 0 }, /刀具半径必须为正数/);
  fail({ toolRadius: -1 }, /刀具半径必须为正数/);
  fail({ toolRadius: '' }, /刀具半径必须是数字/);
  fail({ plateWidth: 0 }, /板材宽度/);
  fail({ plateHeight: -5 }, /板材高度/);
  fail({ labels: undefined }, /缺少 labels/);
  fail({ labels: [] }, /没有任何标签/);
});

test('凸点数据非法：坐标/半径问题逐个定位到标签与点序号', () => {
  const panel = panelOf('ab\ncd');
  const badLabels = JSON.parse(JSON.stringify(panel.labels));
  badLabels[1].dots[2].r = 0;
  const r = PanelCut.planCuts({ labels: badLabels, plateWidth: 120, plateHeight: 80, margin: 1, toolRadius: 0.5 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /标签 #2 的第 3 个凸点/);
});

test('标签编号重复 / 编号缺失被拒绝', () => {
  const panel = panelOf('ab\ncd');
  const dup = JSON.parse(JSON.stringify(panel.labels));
  dup[1].index = 1;
  const r1 = PanelCut.planCuts({ labels: dup, plateWidth: 120, plateHeight: 80, margin: 1, toolRadius: 0.5 });
  assert.equal(r1.ok, false);
  assert.match(r1.errors[0].message, /重复出现/);

  const noIdx = JSON.parse(JSON.stringify(panel.labels));
  delete noIdx[0].index;
  const r2 = PanelCut.planCuts({ labels: noIdx, plateWidth: 120, plateHeight: 80, margin: 1, toolRadius: 0.5 });
  assert.equal(r2.ok, false);
  assert.match(r2.errors[0].message, /编号/);
});

test('标签条数上限 100：100 条成功、101 条拒绝', () => {
  function mk(n) {
    const panel = panelOf(Array.from({ length: n }, (_, i) => 'a' + (i % 20)).join('\n'),
      { plateWidth: 1000, plateHeight: 1000 });
    return panel;
  }
  const ok = cutOf(mk(100), 1, 0.5);
  assert.equal(ok.ok, true);
  assert.equal(ok.cuts.length, 100);
  const tooMany = cutOf(mk(100) /* 100 条拼版 */, 1, 0.5);
  assert.equal(tooMany.cuts.length, 100);
  // 直接构造 101 条 labels（几何任意）
  const labels101 = Array.from({ length: 101 }, (_, i) => ({
    index: i + 1, text: 'a', rotation: 0,
    dots: [{ x: 5 + i, y: 5, r: 0.75 }]
  }));
  const r = PanelCut.planCuts({ labels: labels101, plateWidth: 1000, plateHeight: 1000, margin: 1, toolRadius: 0.5 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.type === 'too-many-labels'));
});

/* ---------- CSV / SVG / 确定性 ---------- */

test('CSV：UTF-8 BOM、CRLF、19 列表头，含编号/原文/旋转角与成品边/刀心线四角坐标', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN');
  const r = cutOf(panel, 1, 0.5);
  assert.ok(r.csv.charCodeAt(0) === 0xFEFF);
  const lines = r.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0],
    'label,text,rotation_deg,' +
    'finish_tl_x_mm,finish_tl_y_mm,finish_tr_x_mm,finish_tr_y_mm,' +
    'finish_br_x_mm,finish_br_y_mm,finish_bl_x_mm,finish_bl_y_mm,' +
    'tool_tl_x_mm,tool_tl_y_mm,tool_tr_x_mm,tool_tr_y_mm,' +
    'tool_br_x_mm,tool_br_y_mm,tool_bl_x_mm,tool_bl_y_mm');
  assert.equal(lines.length, 4); // 表头 + 3 标签
  assert.ok(lines.slice(1).every(l => l.split(',').length === 19));
  assert.match(lines[1], /^1,EXIT,0,/);
  // 与 cuts 中四角一致
  const c1 = r.cuts[0];
  const cols = lines[1].split(',');
  assert.equal(Number(cols[3]), c1.finish.corners.tl.x);
  assert.equal(Number(cols[10]), c1.finish.corners.bl.y);
  assert.equal(Number(cols[11]), c1.tool.corners.tl.x);
  assert.equal(Number(cols[18]), c1.tool.corners.bl.y);
});

test('CSV：标签原文含逗号/引号时按 RFC4180 加引号转义', () => {
  const labels = [{ index: 1, text: 'A,B"C', rotation: 0, dots: [{ x: 5, y: 5, r: 0.75 }] }];
  const r = PanelCut.planCuts({ labels, plateWidth: 50, plateHeight: 50, margin: 1, toolRadius: 0.5 });
  assert.equal(r.ok, true);
  const lines = r.csv.replace(/^﻿/, '').split('\r\n');
  assert.ok(lines[1].indexOf('"A,B""C"') >= 0);
});

test('SVG：板材视口、包络/成品边/刀心线三层、编号、四角毫米坐标与 data 属性', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN');
  const r = cutOf(panel, 1, 0.5);
  assert.match(r.svg, /^<\?xml/);
  assert.match(r.svg, /width="120mm"/);
  assert.match(r.svg, /data-label-count="3"/);
  assert.match(r.svg, /data-margin="1"/);
  assert.match(r.svg, /data-tool-radius="0.5"/);
  assert.match(r.svg, /data-max-margin="1.25"/);
  assert.equal((r.svg.match(/class="cut-label"/g) || []).length, 3);
  assert.equal((r.svg.match(/class="cut-envelope"/g) || []).length, 3);
  assert.equal((r.svg.match(/class="cut-finish"/g) || []).length, 3);
  assert.equal((r.svg.match(/class="cut-tool"/g) || []).length, 3);
  assert.match(r.svg, /data-label-index="1"/);
  // 成品边角坐标标注存在（格式 x,y）
  assert.match(r.svg, /class="cut-corner"[^>]*>[\d.]+,[\d.]+</);
  // 旋转标记
  const panel2 = panelOf('bbcdefghijklmno', { plateWidth: 95, plateHeight: 100 });
  const r2 = cutOf(panel2, 1, 0.5);
  assert.match(r2.svg, /⟳90°/);
});

test('相同输入结果严格一致（cuts/svg/csv/binding 全部相同）', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN\nPULL\nPUSH');
  const payload = { labels: panel.labels, plateWidth: 120, plateHeight: 80, margin: 1, toolRadius: 0.5 };
  const a = PanelCut.planCuts(payload);
  const b = PanelCut.planCuts(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(a.cuts, b.cuts);
  assert.deepEqual(a.binding, b.binding);
  assert.equal(a.svg, b.svg);
  assert.equal(a.csv, b.csv);
});

test('可行时全部刀心线均在板材范围内', () => {
  const panel = panelOf('EXIT\nWOMEN\nMEN\nPULL\nPUSH');
  const r = cutOf(panel, r0(panel, 0.5), 0.5);
  assert.equal(r.ok, true);
  r.cuts.forEach(c => {
    assert.ok(c.tool.left >= -1e-9 && c.tool.top >= -1e-9);
    assert.ok(c.tool.right <= 120 + 1e-9 && c.tool.bottom <= 80 + 1e-9);
  });
});

// 取该拼版在给定刀径下的最大留边（边界值）作为输入
function r0(panel, R) {
  return PanelCut.planCuts({
    labels: panel.labels,
    plateWidth: panel.params.plateWidth,
    plateHeight: panel.params.plateHeight,
    margin: 0, toolRadius: R
  }).maxMargin;
}

function r3(n) { return Math.round(n * 1000) / 1000; }
