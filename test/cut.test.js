'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Panel = require('../lib/panel');
const PanelCut = require('../lib/cut');

const P = { plateWidth: 120, plateHeight: 80 };

function pack(labels, opts) {
  return Panel.packLabels(Object.assign({ labels: labels }, P, opts || {}));
}

function cut(panel, input) {
  return PanelCut.planCuts(Object.assign({
    labels: panel.labels,
    dots: panel.dots,
    plateWidth: panel.params.plateWidth,
    plateHeight: panel.params.plateHeight
  }, input));
}

/* ---------- 基本成功路径：三层矩形几何 ---------- */

test('可行留边：凸点包络 -> 外扩留边成品边 -> 外扩刀具半径刀心线', () => {
  const p = pack('EXIT\nWOMEN\nMEN');
  const r = cut(p, { minMargin: 0.5, toolRadius: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.labelCount, 3);

  const lb = r.labels[0];
  // 标签 #1 最左点为大写前缀的右列点（局部 x=2.5，全局 7.5）、最上点 y=5、最右点全局 49.5、
  // 最下点含点3/6 在 y=10；点 r=0.75 => 包络 (6.75,4.25)-(50.25,10.75)
  assert.deepEqual(lb.envelope, { x: 6.75, y: 4.25, width: 43.5, height: 6.5 });
  // 成品边 = 包络外扩 0.5
  assert.deepEqual(lb.finish, { x: 6.25, y: 3.75, width: 44.5, height: 7.5 });
  // 刀心线 = 包络外扩 0.5+0.5=1.0
  assert.deepEqual(lb.toolCenter, { x: 5.75, y: 3.25, width: 45.5, height: 8.5 });

  // 四角顺序 TL TR BR BL，坐标单位 mm
  assert.deepEqual(lb.corners.map(c => c.corner), ['TL', 'TR', 'BR', 'BL']);
  assert.deepEqual(lb.corners[0], { corner: 'TL', x: 5.75, y: 3.25 });
  assert.deepEqual(lb.corners[2], { corner: 'BR', x: 51.25, y: 11.75 });
});

test('留边为 0、刀具半径为 0：成品边=包络=刀心线', () => {
  const p = pack('a');
  const r = cut(p, { minMargin: 0, toolRadius: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.labels[0].finish, r.labels[0].envelope);
  assert.deepEqual(r.labels[0].toolCenter, r.labels[0].envelope);
});

test('最大统一留边与统计余量；binding 为最紧约束', () => {
  const p = pack('EXIT\nWOMEN\nMEN');
  const r = cut(p, { minMargin: 0.5, toolRadius: 0.5 });
  // 行间包络 y 净距 3.5（10.75 -> 14.25），m* = 3.5/2 - 0.5 = 1.25
  assert.equal(r.maxMargin, 1.25);
  assert.equal(r.stats.slack, 0.75);
  assert.deepEqual([r.binding.kind, r.binding.labelA, r.binding.labelB, r.binding.axis],
    ['pair', 1, 3, 'y']);
  assert.ok(r.stats.plateConstraints === 12); // 4 边 × 3 标签
  assert.equal(r.stats.pairConstraints, 3);   // C(3,2)
  assert.ok(r.stats.bindingCount >= 1);
});

/* ---------- 旋转 90° 标签按全局坐标计算 ---------- */

test('90° 旋转标签：包络按全局凸点（包围盒 5×86.5 含点半径）', () => {
  const p = Panel.packLabels({ labels: 'bbcdefghijklmno', plateWidth: 95, plateHeight: 100 });
  assert.equal(p.labels[0].rotation, 90);
  const r = cut(p, { minMargin: 1, toolRadius: 0.5 });
  assert.equal(r.ok, true);
  // 全局包围盒 (5,5)-(10,91.5)，点 r=0.75 => 包络 (4.25,4.25,6.5×88)
  assert.deepEqual(r.labels[0].envelope, { x: 4.25, y: 4.25, width: 6.5, height: 88 });
  assert.deepEqual(r.labels[0].finish, { x: 3.25, y: 3.25, width: 8.5, height: 90 });
  assert.deepEqual(r.labels[0].toolCenter, { x: 2.75, y: 2.75, width: 9.5, height: 91 });
  // 最紧约束是左板边：4.25-0.5 = 3.75
  assert.equal(r.maxMargin, 3.75);
  assert.deepEqual([r.binding.kind, r.binding.side, r.binding.label], ['plate', 'left', 1]);
});

/* ---------- 超限语义：指出板边/标签对，不输出部分刀路 ---------- */

test('留边超板边限制：ok=false，binding 指向板边且无任何刀路输出', () => {
  // 旋转标签包络到左板边 4.25，刀具半径 0.5 => m*=3.75；请求 4 超限
  const p = Panel.packLabels({ labels: 'bbcdefghijklmno', plateWidth: 95, plateHeight: 100 });
  const r = cut(p, { minMargin: 4, toolRadius: 0.5 });
  assert.equal(r.ok, false);
  assert.equal(r.labels.length, 0);
  assert.equal(r.svg, null);
  assert.equal(r.csv, null);
  assert.equal(r.maxMargin, 3.75);
  assert.equal(r.errors[0].binding, true);
  assert.equal(r.errors[0].type, 'plate-edge-limit');
  assert.equal(r.errors[0].side, 'left');
  assert.match(r.errors[0].message, /左板边/);
  assert.match(r.errors[0].message, /3\.75/);
});

test('留边超标签对刀具占位：binding 指向标签对与分离轴，并列出全部违反项', () => {
  const p = pack('EXIT\nWOMEN\nMEN');
  const r = cut(p, { minMargin: 5, toolRadius: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.svg, null);
  assert.equal(r.csv, null);
  // m* = 3.5/2 - 1 = 0.75，binding 为 #1↔#3 竖直分离轴
  assert.equal(r.maxMargin, 0.75);
  assert.equal(r.errors[0].binding, true);
  assert.equal(r.errors[0].type, 'label-pair-limit');
  assert.deepEqual([r.errors[0].labelA, r.errors[0].labelB, r.errors[0].axis], [1, 3, 'y']);
  assert.match(r.errors[0].message, /#1/);
  assert.match(r.errors[0].message, /#3/);
  assert.match(r.errors[0].message, /0\.75/);
  // 同时超同行 #1↔#2（水平 6/2-1=2）与两块上板边（4.25-1=3.25）
  const types = r.errors.map(e => e.type);
  assert.ok(types.filter(t => t === 'label-pair-limit').length >= 2);
  assert.ok(types.includes('plate-edge-limit'));
  assert.ok(types.includes('limit-summary'));
});

test('取到最大留边本身时恰好可行（贴线 = 0 间距，视为可行）', () => {
  const p = pack('EXIT\nWOMEN\nMEN');
  const r = cut(p, { minMargin: 1.25, toolRadius: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.stats.slack, 0);
});

test('刀具半径过大使最大留边为负：任何留边（含 0）都不可行', () => {
  // 旋转标签包络左缘 4.25；刀具半径 5 => m* = -0.75
  const p = Panel.packLabels({ labels: 'bbcdefghijklmno', plateWidth: 95, plateHeight: 100 });
  const r = cut(p, { minMargin: 0, toolRadius: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.maxMargin, -0.75);
  assert.equal(r.svg, null);
  assert.match(r.errors[0].message, /刀具半径 5/);
  assert.match(r.errors[0].message, /最大允许留边为 -0\.75/);
});

/* ---------- 输入兜底与校验 ---------- */

test('仅传顶层 dots（带 label）也能按标签分组生成', () => {
  const p = pack('EXIT\nWOMEN\nMEN');
  const r = PanelCut.planCuts({
    dots: p.dots,
    plateWidth: 120, plateHeight: 80,
    minMargin: 0.5, toolRadius: 0.5
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.labels.map(l => l.index), [1, 2, 3]);
  // 与传 labels 的几何一致
  const r2 = cut(p, { minMargin: 0.5, toolRadius: 0.5 });
  assert.deepEqual(r.labels[0].toolCenter, r2.labels[0].toolCenter);
});

test('缺少拼版数据 / 留边为负 / 刀具半径为负 / 板材非法：明确报错且无输出', () => {
  const noData = PanelCut.planCuts({ minMargin: 1, toolRadius: 0.5, plateWidth: 120, plateHeight: 80 });
  assert.equal(noData.ok, false);
  assert.equal(noData.svg, null);
  assert.equal(noData.errors[0].type, 'no-panel');

  const p = pack('a');
  assert.equal(cut(p, { minMargin: -1, toolRadius: 0.5 }).ok, false);
  assert.equal(cut(p, { minMargin: 1, toolRadius: -0.5 }).ok, false);
  assert.equal(PanelCut.planCuts({ labels: p.labels, plateWidth: 0, plateHeight: 80, minMargin: 1, toolRadius: 0.5 }).ok, false);
  assert.equal(PanelCut.planCuts({ labels: p.labels, plateWidth: 120, plateHeight: '宽', minMargin: 1, toolRadius: 0.5 }).ok, false);
});

test('凸点坐标/半径非法时逐个定位报错', () => {
  const bad = [{ index: 1, dots: [{ x: 'oops', y: 1, r: 0.75 }] }];
  const r = PanelCut.planCuts({ labels: bad, plateWidth: 120, plateHeight: 80, minMargin: 1, toolRadius: 0.5 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /标签 #1 的第 1 个凸点/);
});

/* ---------- 确定性与输出格式 ---------- */

test('相同输入结果严格一致（矩形/四角/CSV/SVG）', () => {
  const p = pack('EXIT\nWOMEN\nMEN');
  const a = cut(p, { minMargin: 0.5, toolRadius: 0.5 });
  const b = cut(p, { minMargin: 0.5, toolRadius: 0.5 });
  assert.deepEqual(a.labels, b.labels);
  assert.equal(a.csv, b.csv);
  assert.equal(a.svg, b.svg);
});

test('CSV：UTF-8 BOM、每标签 finish/toolCenter 两行，11 列含四角毫米坐标', () => {
  const p = pack('a\nb');
  const r = cut(p, { minMargin: 0.5, toolRadius: 0.5 });
  const lines = r.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0],
    'label_index,rotation_deg,rect,corner_tl_x_mm,corner_tl_y_mm,corner_tr_x_mm,corner_tr_y_mm,corner_br_x_mm,corner_br_y_mm,corner_bl_x_mm,corner_bl_y_mm');
  assert.equal(lines.length, 5); // 表头 + 2 标签 × 2 行
  assert.deepEqual(lines.slice(1).map(l => l.split(',')[2]), ['finish_edge', 'tool_center', 'finish_edge', 'tool_center']);
  assert.ok(lines.slice(1).every(l => l.split(',').length === 11));
  // toolCenter 行四角与 JSON corners 一致
  const tc = lines[2].split(',');
  assert.equal(Number(tc[3]), r.labels[0].corners[0].x);
  assert.equal(Number(tc[9]), r.labels[0].corners[3].x);
});

test('SVG：自包含整板文档，含包络/成品边/刀心线 class、标签编号与四角坐标文本', () => {
  const p = pack('EXIT\nWOMEN\nMEN');
  const r = cut(p, { minMargin: 0.5, toolRadius: 0.5 });
  assert.match(r.svg, /^<\?xml/);
  assert.match(r.svg, /width="120mm"/);
  assert.equal((r.svg.match(/class="cut-tool-center"/g) || []).length, 3);
  assert.equal((r.svg.match(/class="cut-finish"/g) || []).length, 3);
  assert.equal((r.svg.match(/class="cut-envelope"/g) || []).length, 3);
  assert.match(r.svg, /data-label-index="1"/);
  assert.match(r.svg, /class="cut-corner"/);
  assert.match(r.svg, /class="cut-label-index"/);
  // 叠加图保留成功拼版的全局凸点本体
  assert.equal((r.svg.match(/class="cut-dots"/g) || []).length, 3);
  assert.match(r.svg, /<circle /);
  // 输出 JSON 的 labels 不序列化内部字段（_env/_dots 为不可枚举）
  assert.ok(Object.keys(r.labels[0]).indexOf('_dots') < 0);
  assert.ok(Object.keys(r.labels[0]).indexOf('_env') < 0);
  assert.doesNotMatch(JSON.stringify(r.labels), /_dots|_env/);
  // 四角标注 TL/TR/BR/BL
  ['TL', 'TR', 'BR', 'BL'].forEach(c => assert.match(r.svg, new RegExp('>' + c + ' ')));
});
