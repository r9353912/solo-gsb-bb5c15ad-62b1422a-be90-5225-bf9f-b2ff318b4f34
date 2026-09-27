'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const EmbossPath = require('../lib/path');
const Braille = require('../lib/braille');
const Panel = require('../lib/panel');

// 生成网格点（无标签），坐标 0.001mm 的整数倍，贴近真实排版点
function gridDots(nx, ny, gap = 2.5) {
  const dots = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      dots.push({ x: Math.round((5 + ix * gap) * 1000) / 1000, y: Math.round((5 + iy * gap) * 1000) / 1000, r: 0.75 });
    }
  }
  return dots;
}

test('单标签排版 dots：成功生成路径，每个凸点恰好访问一次，step 从 1 连续编号', () => {
  const layout = Braille.layout({ text: 'EXIT', plateWidth: 100, plateHeight: 50 });
  assert.equal(layout.ok, true);
  const r = EmbossPath.planPath({ dots: layout.dots, startX: 0, startY: 0, plateWidth: 100, plateHeight: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.steps.length, layout.dots.length);
  const seqs = r.steps.map(s => s.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, layout.dots.map((_, i) => i + 1)); // 原序号 1..n 的一个排列
  assert.deepEqual(r.steps.map(s => s.step), layout.dots.map((_, i) => i + 1));
  // 单标签点没有 label 归属
  assert.ok(r.steps.every(s => s.label === null));
});

test('拼版 dots：步骤保留标签索引，且每个标签的点都被访问', () => {
  const panel = Panel.packLabels({ labels: 'EXIT\nWOMEN\nMEN', plateWidth: 120, plateHeight: 80 });
  assert.equal(panel.ok, true);
  const r = EmbossPath.planPath({ dots: panel.dots, startX: 0, startY: 0, plateWidth: 120, plateHeight: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, panel.dots.length);
  const byLabel = {};
  panel.dots.forEach(d => { byLabel[d.label] = (byLabel[d.label] || 0) + 1; });
  const stepByLabel = {};
  r.steps.forEach(s => { stepByLabel[s.label] = (stepByLabel[s.label] || 0) + 1; });
  assert.deepEqual(stepByLabel, byLabel);
  assert.equal(r.stats.labelCount, 3);
});

test('最近邻首步选择距用户起点最近的点；travel 为首边距离', () => {
  // (3,4) 距原点 5 最近；该点集上 2-opt 不存在任何严格缩短反转，故首点稳定为 (3,4)
  const dots = [{ x: 3, y: 4 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  const r = EmbossPath.planPath({ dots, startX: 0, startY: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.steps[0].x, r.steps[0].y], [3, 4]);
  assert.equal(r.steps[0].travel_mm, 5);
  assert.equal(r.stats.roundsRun, 0);
});

test('同距离稳定决胜：标签索引升序 → x 升序 → y 升序 → 原序号', () => {
  // 四个点到原点距离均为 5：label1 的三个点 x 分别 -3/0/3，label2 一个点
  const dots = [
    { x: 0, y: 5, label: 2 },
    { x: 3, y: 4, label: 1 },
    { x: -3, y: 4, label: 1 },
    { x: 0, y: 5, label: 1 }
  ];
  let r = EmbossPath.planPath({ dots, startX: 0, startY: 0 });
  assert.equal(r.ok, true);
  // 首点：label1 中 x 最小 (-3,4)
  assert.deepEqual([r.steps[0].x, r.steps[0].y], [-3, 4]);

  // 同标签、按 x 决胜
  r = EmbossPath.planPath({
    dots: [{ x: 3, y: 4 }, { x: 0, y: 5 }, { x: 4, y: 3 }],
    startX: 0, startY: 0
  });
  assert.deepEqual([r.steps[0].x, r.steps[0].y], [0, 5]);

  // 坐标完全相同：按原序号（输入下标）决胜
  r = EmbossPath.planPath({
    dots: [{ x: 5, y: 0, tag: 'a' }, { x: 5, y: 0, tag: 'b' }, { x: 6, y: 0 }],
    startX: 0, startY: 0
  });
  assert.equal(r.steps[0].seq, 1);
});

test('相同输入结果严格一致（重复调用与 steps 序列化相同）', () => {
  const panel = Panel.packLabels({ labels: 'EXIT\nWOMEN\nMEN\nPULL\nPUSH', plateWidth: 120, plateHeight: 80 });
  const input = { dots: panel.dots, startX: 2, startY: 3, plateWidth: 120, plateHeight: 80 };
  const a = EmbossPath.planPath(input);
  const b = EmbossPath.planPath(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(a.steps, b.steps);
  assert.equal(a.svg, b.svg);
  assert.equal(a.csv, b.csv);
});

test('2-opt 不增长空移且统计自洽；steps 的 travel 之和等于优化后总长', () => {
  const dots = gridDots(12, 6);
  const r = EmbossPath.planPath({ dots, startX: 0, startY: 0 });
  assert.equal(r.ok, true);
  const s = r.stats;
  assert.ok(s.optTravelMm <= s.nnTravelMm + 1e-6);
  assert.equal(s.maxRounds, 20);
  assert.ok(s.roundsRun >= 0 && s.roundsRun <= 20);
  assert.ok(Math.abs(s.nnTravelMm - s.optTravelMm - s.savedMm) < 0.01);
  assert.ok(s.savedPercent >= 0 && s.savedPercent <= 100);
  // travel 段和（四舍五入误差范围内）等于优化后总长
  const sum = r.steps.reduce((acc, st) => acc + st.travel_mm, 0);
  assert.ok(Math.abs(sum - s.optTravelMm) < r.steps.length * 0.002);
});

test('2-opt 在交错双列点上实际缩短路线（相对最近邻有节省）', () => {
  // 两列点上下交错：最近邻容易走出之字形，2-opt 应消除折返
  const dots = [];
  for (let i = 0; i < 10; i++) {
    dots.push({ x: 0, y: i * 3 });
    dots.push({ x: 10, y: i * 3 + 1.5 });
  }
  const r = EmbossPath.planPath({ dots, startX: -5, startY: 0 });
  assert.equal(r.ok, true);
  assert.ok(r.stats.optTravelMm < r.stats.nnTravelMm - 1e-6);
  assert.ok(r.stats.roundsRun >= 1);
});

test('2-opt 每轮接受首个严格缩短的反转（手工矩阵：首轮只可能接受 (i=0,j=1)）', () => {
  // n=4，构造距离矩阵（不要求度量合法，算法只读矩阵）：
  // 初始顺序 [0,1,2,3]，起点距离 sd=[10,1,100,100]。
  // (0,1) 反转：旧 sd0+dm(1,2)=10+100=110，新 sd1+dm(0,2)=1+10=11 → 严格缩短；
  // 按扫描顺序它是第一个候选，必须立即接受。第二轮起对新顺序 [1,0,2,3] 无严格缩短。
  const n = 4;
  const dm = new Float64Array(n * n);
  function setD(a, b, v) { dm[a * n + b] = v; dm[b * n + a] = v; }
  setD(0, 1, 100);
  setD(0, 2, 10);
  setD(0, 3, 100);
  setD(1, 2, 100);
  setD(1, 3, 100);
  setD(2, 3, 1);
  const sd = Float64Array.from([10, 1, 100, 100]);
  const order = [0, 1, 2, 3];
  const rounds = EmbossPath.twoOpt(order, sd, dm);
  assert.equal(rounds, 1);
  assert.deepEqual(order, [1, 0, 2, 3]);
});

test('2-opt 最多执行 20 轮：构造每轮恰好一个改进的矩阵，验证在 20 轮处停止', () => {
  // n=25：sd[k]=100-k（点 24 离起点最近），点间距离恒为 10。
  // 初始 [0..24]，第 r 轮（r=1..24）只有 (i=0,j=r) 严格缩短 1，故可改进 24 轮，
  // 但算法必须在 20 轮处封顶；此时首点为点 20（逐轮 0,2,4,… 被翻到首位）。
  const n = 25;
  const dm = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) if (i !== j) dm[i * n + j] = 10;
  }
  const sd = new Float64Array(n);
  for (let k = 0; k < n; k++) sd[k] = 100 - k;
  const order = [];
  for (let k = 0; k < n; k++) order.push(k);
  const rounds = EmbossPath.twoOpt(order, sd, dm);
  assert.equal(rounds, 20);
  assert.equal(order[0], 20);
});

test('点数上限 2000：恰好 2000 个点成功；2001 个点明确报错且不输出部分路径', () => {
  const ok = EmbossPath.planPath({ dots: gridDots(50, 40), startX: 0, startY: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.steps.length, 2000);

  const tooMany = EmbossPath.planPath({ dots: gridDots(2001, 1), startX: 0, startY: 0 });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.steps.length, 0);
  assert.equal(tooMany.svg, null);
  assert.equal(tooMany.csv, null);
  assert.ok(tooMany.errors.some(e => e.type === 'too-many-points' && /2000/.test(e.message)));
});

test('参数非法：缺少/空 dots、起点非数字、点坐标非法、板材尺寸非法均报错且无部分输出', () => {
  function expectFail(input, type) {
    const r = EmbossPath.planPath(input);
    assert.equal(r.ok, false);
    assert.equal(r.steps.length, 0);
    assert.equal(r.svg, null);
    assert.equal(r.csv, null);
    assert.equal(r.stats, null);
    if (type) assert.ok(r.errors.some(e => e.type === type), '应有错误类型 ' + type);
  }
  expectFail({ startX: 0, startY: 0 }, 'param');           // 缺 dots
  expectFail({ dots: [], startX: 0, startY: 0 }, 'param'); // 空 dots
  expectFail({ dots: 'not-array', startX: 0, startY: 0 }, 'param');
  expectFail({ dots: [{ x: 1, y: 1 }], startX: NaN, startY: 0 }, 'param');
  expectFail({ dots: [{ x: 1, y: 1 }], startX: 0, startY: '' }, 'param');
  expectFail({ dots: [{ x: 1, y: 1 }], startX: 'abc', startY: 0 }, 'param');
  expectFail({ dots: [{ x: 1, y: NaN }], startX: 0, startY: 0 }, 'param');
  expectFail({ dots: [{ x: 1, y: 1 }], startX: 0, startY: 0, plateWidth: -10 }, 'param');
  expectFail({ dots: [{ x: 1, y: 1 }], startX: 0, startY: 0, plateHeight: 0 }, 'param');
});

test('起点可以在板材外（数值合法即可），路径仍正常生成', () => {
  const r = EmbossPath.planPath({ dots: gridDots(3, 2), startX: -50, startY: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, 6);
  assert.equal(r.params.startX, -50);
  assert.equal(r.params.startY, 80);
});

test('CSV：表头为 step,label,x_mm,y_mm,travel_mm；单标签 label 列留空、拼版填标签索引；UTF-8 BOM', () => {
  const layout = Braille.layout({ text: 'ab', plateWidth: 100, plateHeight: 50 });
  const r1 = EmbossPath.planPath({ dots: layout.dots, startX: 0, startY: 0 });
  const lines1 = r1.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines1[0], 'step,label,x_mm,y_mm,travel_mm');
  assert.match(lines1[1], /^1,,/);
  assert.ok(r1.csv.charCodeAt(0) === 0xFEFF);
  // 每行 5 列
  assert.ok(lines1.slice(1).every(line => line.split(',').length === 5));

  const panel = Panel.packLabels({ labels: 'a\nb', plateWidth: 120, plateHeight: 80 });
  const r2 = EmbossPath.planPath({ dots: panel.dots, startX: 0, startY: 0 });
  const lines2 = r2.csv.replace(/^﻿/, '').split('\r\n');
  assert.match(lines2[1], /^1,\d+,/);
  assert.ok(lines2.slice(1).every(line => line.split(',').length === 5));
});

test('SVG：含最近邻虚线、优化路线方向箭头、每个 step 序号与起点标记', () => {
  const panel = Panel.packLabels({ labels: 'EXIT\nWOMEN', plateWidth: 120, plateHeight: 80 });
  const r = EmbossPath.planPath({ dots: panel.dots, startX: 0, startY: 0, plateWidth: 120, plateHeight: 80 });
  assert.match(r.svg, /^<\?xml/);
  assert.match(r.svg, /class="nn-path"/);
  assert.match(r.svg, /class="opt-path"/);
  assert.match(r.svg, /id="path-arrow"/);
  assert.match(r.svg, /marker-mid="url\(#path-arrow\)"/);
  assert.match(r.svg, /class="path-start"/);
  assert.match(r.svg, /data-point-count="\d+"/);
  // 每个凸点一个 data-step（1 基）
  const stops = r.svg.match(/class="path-stop"/g) || [];
  assert.equal(stops.length, panel.dots.length);
  assert.match(r.svg, /data-step="1"/);
  assert.match(r.svg, new RegExp('data-step="' + panel.dots.length + '"'));
  // 拼版点在 SVG 上保留标签属性
  assert.match(r.svg, /data-label="1"/);
});
