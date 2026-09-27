/*
 * 压印路径（Embossing Toolpath）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 输入：单标签排版或多标签拼版成功后的当前 dots（毫米坐标）+ 用户指定起点 (startX, startY)。
 * 生成压印机逐点作业顺序：
 *   1. 最近邻（Nearest Neighbor）：从用户起点出发，每一步走到距离当前位置最近的
 *      未访问凸点；同距离时按 ① 标签索引升序 → ② 点坐标（x 升序、再 y 升序）→
 *      ③ 原序号（输入 dots 数组下标）升序稳定决胜，故相同输入结果严格一致；
 *   2. 2-opt 局部优化：最多执行 20 轮，每轮按反转段“起点下标 i 升序、终点下标 j
 *      升序”的顺序扫描，接受首个使空移总长严格缩短的反转（立即反转并结束本轮，
 *      下一轮重新从 i=0 开始扫描）；某轮无任何缩短反转时提前结束；
 *   3. 起点只是虚拟首边（起点 -> 第一个凸点），反转段允许从 i=0 开始（更换首点），
 *      也允许以 j=n-1 结尾（更换末点）。
 *
 * 保证：每个凸点在 steps 中恰好出现一次（下标的一个排列）；点数超过 2000 或
 * 任何参数非法时 ok=false 且 steps/svg/csv 全空——绝不输出部分路径。
 *
 * 坐标单位均为毫米 mm，原点在板材左上角，x 向右、y 向下。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EmbossPath = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var MAX_POINTS = 2000; // 单次压印路径的凸点数量上限
  var MAX_ROUNDS = 20;   // 2-opt 最大轮数
  var EPS = 1e-9;       // “严格缩短 / 同距离”判定阈值（mm，坐标为 0.001mm 的整数倍）

  /* ---------------- 工具 ---------------- */

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round1(n) { return Math.round(n * 10) / 10; }

  function hyp(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ---------------- 输入校验与点集构造 ---------------- */

  function collectPoints(input) {
    var errors = [];
    var raw = input.dots;
    if (!Array.isArray(raw)) {
      errors.push({ type: 'param', message: '缺少 dots 凸点数据（必须为最近一次成功排版/拼版的凸点数组）。' });
      return { points: [], errors: errors };
    }
    if (raw.length === 0) {
      errors.push({ type: 'param', message: '当前没有任何凸点，无法生成压印路径；请先完成一次成功的排版或拼版。' });
      return { points: [], errors: errors };
    }
    if (raw.length > MAX_POINTS) {
      errors.push({
        type: 'too-many-points',
        message: '凸点数量为 ' + raw.length + ' 个，超过单次压印路径 ' + MAX_POINTS +
          ' 个上限；请减少标签文字或拆分为多次压印作业。'
      });
      return { points: [], errors: errors };
    }

    var points = new Array(raw.length);
    for (var i = 0; i < raw.length; i++) {
      var d = raw[i] || {};
      var x = num(d.x), y = num(d.y);
      if (!isFinite(x) || !isFinite(y)) {
        errors.push({
          type: 'param',
          message: '第 ' + (i + 1) + ' 个凸点坐标非法（x=' + d.x + '，y=' + d.y +
            '），请重新排版/拼版后再生成压印路径。'
        });
        return { points: [], errors: errors };
      }
      var label = num(d.label);
      points[i] = {
        seq: i,                 // 原序号（0 基输入下标），决胜最后一档
        x: x,
        y: y,
        label: isFinite(label) ? Math.trunc(label) : null, // 拼版点带标签索引；单标签点为 null
        labelKey: isFinite(label) ? Math.trunc(label) : 0,
        r: isFinite(num(d.r)) && num(d.r) > 0 ? num(d.r) : null
      };
    }
    return { points: points, errors: errors };
  }

  /* ---------------- 距离矩阵 ----------------
   * n ≤ 2000，矩阵存为 Float64Array（n²×8 字节，最大约 32MB），
   * 最近邻与 20 轮 2-opt 全程复用，避免重复开方。
   */
  function buildDistanceMatrix(points) {
    var n = points.length;
    var m = new Float64Array(n * n);
    for (var i = 0; i < n; i++) {
      var pi = points[i];
      for (var j = i + 1; j < n; j++) {
        var pj = points[j];
        var d = hyp(pi.x, pi.y, pj.x, pj.y);
        m[i * n + j] = d;
        m[j * n + i] = d;
      }
    }
    return m;
  }

  function buildStartDistances(points, sx, sy) {
    var n = points.length;
    var s = new Float64Array(n);
    for (var i = 0; i < n; i++) s[i] = hyp(sx, sy, points[i].x, points[i].y);
    return s;
  }

  /* ---------------- 最近邻初始路线 ----------------
   * 返回点下标的排列。同距离决胜：labelKey -> x -> y -> seq。
   */
  function nearestNeighbor(points, dm, sd) {
    var n = points.length;
    var used = new Uint8Array(n);
    var order = new Array(n);
    var cur = -1; // -1 表示当前位置为用户起点（虚拟首边）

    for (var step = 0; step < n; step++) {
      var best = -1;
      var bestD = 0;
      for (var j = 0; j < n; j++) {
        if (used[j]) continue;
        var dj = cur < 0 ? sd[j] : dm[cur * n + j];
        if (best < 0) { best = j; bestD = dj; continue; }
        var bj = points[j], bp = points[best];
        if (dj < bestD - EPS ||
            (Math.abs(dj - bestD) <= EPS &&
              (bj.labelKey < bp.labelKey ||
                (bj.labelKey === bp.labelKey &&
                  (bj.x < bp.x ||
                    (bj.x === bp.x &&
                      (bj.y < bp.y ||
                        (bj.y === bp.y && bj.seq < bp.seq)))))))) {
          best = j;
          bestD = dj;
        }
      }
      used[best] = 1;
      order[step] = best;
      cur = best;
    }
    return order;
  }

  function routeLength(order, sd, dm) {
    if (order.length === 0) return 0;
    var total = sd[order[0]]; // 用户起点 -> 第一个凸点
    for (var k = 1; k < order.length; k++) total += dm[order[k - 1] * order.length + order[k]];
    return total;
  }

  /* ---------------- 2-opt（最多 MAX_ROUNDS 轮，每轮接受首个严格缩短的反转） ----------------
   * 每轮严格按 (i=0..n-2, j=i+1..n-1) 的下标顺序扫描，取首个使空移总长严格
   * 缩短的反转并立即结束本轮；下一轮重新从 (i=0,j=1) 开始。
   * 反转 order[i..j]：边 (pred -> order[i]) 与 (order[j] -> succ) 替换为
   * (pred -> order[j]) 与 (order[i] -> succ)；i=0 时 pred 为用户起点，
   * j=n-1 时无 succ 边（路线末端开放）。
   * 注意：起点到所有点等距时 (0,j) 的首边增量恒为 0，必须继续扫到 i=1 之后，
   * 不能因为“数值不变”就在 i=0 处任意反转——扫描顺序必须与文档一致。
   * 返回实际执行的反转轮数。
   */
  function twoOpt(order, sd, dm) {
    var n = order.length;
    var rounds = 0;
    for (var round = 0; round < MAX_ROUNDS; round++) {
      var chosenI = -1, chosenJ = -1;
      for (var i = 0; i < n - 1 && chosenI < 0; i++) {
        for (var j = i + 1; j < n; j++) {
          var a = order[i], b = order[j];
          var oldFirst, newFirst;
          if (i === 0) {
            oldFirst = sd[a];
            newFirst = sd[b]; // 起点改连反转后的新首点
          } else {
            var pred = order[i - 1];
            oldFirst = dm[pred * n + a];
            newFirst = dm[pred * n + b];
          }
          var oldSecond = 0, newSecond = 0;
          if (j < n - 1) {
            var succ = order[j + 1];
            oldSecond = dm[b * n + succ];
            newSecond = dm[a * n + succ]; // 反转后的新末点 a 改连后继
          }
          var delta = (newFirst + newSecond) - (oldFirst + oldSecond);
          if (delta < -EPS) { chosenI = i; chosenJ = j; break; } // 首个严格缩短者
        }
      }
      if (chosenI < 0) break; // 本轮无改进，结束
      var lo = chosenI, hi = chosenJ;
      while (lo < hi) {
        var tmp = order[lo];
        order[lo] = order[hi];
        order[hi] = tmp;
        lo++; hi--;
      }
      rounds++;
    }
    return rounds;
  }

  /* ---------------- 作业步骤 / CSV ---------------- */

  function buildSteps(points, order, sd, dm) {
    var n = order.length;
    var steps = new Array(n);
    for (var k = 0; k < n; k++) {
      var idx = order[k];
      var p = points[idx];
      var travel = k === 0 ? sd[idx] : dm[order[k - 1] * n + idx];
      steps[k] = {
        step: k + 1,
        label: p.label, // 单标签排版的点为 null（CSV 中留空）；拼版点为标签 1 基索引
        seq: p.seq + 1, // 原序号（1 基，仅输出/SVG 标注用）
        x: round3(p.x),
        y: round3(p.y),
        travel_mm: round3(travel)
      };
    }
    return steps;
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCsv(steps) {
    var rows = ['step,label,x_mm,y_mm,travel_mm'];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      rows.push([s.step, s.label == null ? '' : s.label, s.x, s.y, s.travel_mm].map(csvCell).join(','));
    }
    return '\uFEFF' + rows.join('\r\n');
  }

  /* ---------------- 叠加 SVG（序号 + 方向） ---------------- */

  function pathD(order, points) {
    var d = '';
    for (var k = 0; k < order.length; k++) {
      var p = points[order[k]];
      d += (k === 0 ? 'M' : 'L') + round3(p.x) + ' ' + round3(p.y);
    }
    return d;
  }

  function buildSvg(points, nnOrder, optOrder, sd, startX, startY, plateWidth, plateHeight, stats) {
    var n = points.length;
    var out = [];

    // 视口：给了板材幅面就用板材；否则取凸点与用户起点的包围盒
    var minX = 0, minY = 0, maxX = 0, maxY = 0;
    var hasPlate = isFinite(plateWidth) && plateWidth > 0 && isFinite(plateHeight) && plateHeight > 0;
    if (hasPlate) {
      maxX = plateWidth;
      maxY = plateHeight;
    } else {
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      points.forEach(function (p) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
    }
    minX = Math.min(minX, startX); minY = Math.min(minY, startY);
    maxX = Math.max(maxX, startX); maxY = Math.max(maxY, startY);
    if (!(maxX > minX) || !(maxY > minY)) { maxX = minX + 10; maxY = minY + 10; }
    var pad = Math.max(3, round3((maxX - minX) * 0.04));
    minX = round3(minX - pad); minY = round3(minY - pad);
    var W = round3(maxX - minX + 2 * pad), H = round3(maxY - minY + 2 * pad);

    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="' + minX + ' ' + minY + ' ' + W + ' ' + H + '" data-unit="mm" data-point-count="' + n + '">');
    out.push('  <desc>压印路径：共 ' + n + ' 个凸点；绿色三角为用户起点；灰色虚线为最近邻初始路线' +
      '（空移 ' + stats.nnTravelMm + ' mm），蓝色实线带箭头为 2-opt 优化后作业顺序（空移 ' +
      stats.optTravelMm + ' mm，节省 ' + stats.savedPercent + '%，执行 ' + stats.roundsRun +
      ' 轮反转）；每个凸点旁数字为压印 step 序号，绿圈为第 1 点、橙圈为末点。</desc>');
    out.push('  <defs>');
    out.push('    <marker id="path-arrow" viewBox="0 0 4 4" refX="3.2" refY="2" markerWidth="4" markerHeight="4" ' +
      'markerUnits="userSpaceOnUse" orient="auto-start-reverse">');
    out.push('      <path d="M0,0 L4,2 L0,4 z" fill="#2563eb"/>');
    out.push('    </marker>');
    out.push('  </defs>');

    if (hasPlate) {
      out.push('  <rect x="0" y="0" width="' + plateWidth + '" height="' + plateHeight +
        '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');
    } else {
      out.push('  <rect x="' + minX + '" y="' + minY + '" width="' + W + '" height="' + H +
        '" fill="#ffffff" stroke="none"/>');
    }

    // 最近邻初始路线（淡灰虚线，置于下层，仅供优化前后对照）
    out.push('  <path class="nn-path" d="' + pathD(nnOrder, points) + '" fill="none" stroke="#9ca3af" ' +
      'stroke-width="0.18" stroke-dasharray="1.2 0.8" opacity="0.55"/>');

    // 优化后作业路线（蓝色实线 + 每个顶点方向箭头）
    out.push('  <path class="opt-path" d="' + pathD(optOrder, points) + '" fill="none" stroke="#2563eb" ' +
      'stroke-width="0.3" marker-mid="url(#path-arrow)" marker-end="url(#path-arrow)"/>');

    // 用户起点：绿色三角 + 到首点的标注
    var sx = round3(startX), sy = round3(startY);
    out.push('  <g class="path-start">');
    out.push('    <path d="M' + sx + ' ' + round3(sy - 1.1) + ' L' + round3(sx + 1) + ' ' +
      round3(sy + 0.7) + ' L' + round3(sx - 1) + ' ' + round3(sy + 0.7) + ' z" ' +
      'fill="#16a34a" stroke="#14532d" stroke-width="0.15"/>');
    out.push('    <text x="' + round3(sx + 1.3) + '" y="' + round3(sy - 1) + '" font-size="1.8" ' +
      'fill="#166534" pointer-events="none">起点</text>');
    out.push('  </g>');

    // 凸点 + step 序号（1 基）；首点绿圈、末点橙圈
    var defaultR = 0.75;
    for (var k = 0; k < optOrder.length; k++) {
      var p = points[optOrder[k]];
      var r = p.r != null ? p.r : defaultR;
      var ring = k === 0 ? '#16a34a' : (k === n - 1 ? '#d97706' : null);
      var labelAttr = p.label == null ? '' : ' data-label="' + p.label + '"';
      out.push('  <g class="path-stop" data-step="' + (k + 1) + '" data-seq="' + (p.seq + 1) + '"' + labelAttr + '>');
      out.push('    <circle cx="' + round3(p.x) + '" cy="' + round3(p.y) + '" r="' + round3(r) +
        '" fill="#111111"' + (ring ? ' stroke="' + ring + '" stroke-width="0.35"' : '') + '/>');
      // 序号放在凸点右上方，避免压住点本体
      out.push('    <text x="' + round3(p.x + r + 0.25) + '" y="' + round3(p.y - r - 0.1) +
        '" font-size="1.6" text-anchor="start" fill="#1e3a8a" pointer-events="none">' + (k + 1) + '</text>');
      out.push('  </g>');
    }

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- 主入口 ---------------- */

  function planPath(input) {
    input = input || {};
    var errors = [];

    var startX = num(input.startX != null && input.startX !== '' ? input.startX : NaN);
    var startY = num(input.startY != null && input.startY !== '' ? input.startY : NaN);
    if (!isFinite(startX)) errors.push({ type: 'param', message: '起点 X 坐标必须是数字（mm）。' });
    if (!isFinite(startY)) errors.push({ type: 'param', message: '起点 Y 坐标必须是数字（mm）。' });

    // 板材幅面仅用于叠加图取景；不传时按凸点包围盒绘制；传了就必须为正数
    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);
    if (input.plateWidth != null && input.plateWidth !== '' && !(plateWidth > 0)) {
      errors.push({ type: 'param', message: '板材宽度必须为正数。' });
    }
    if (input.plateHeight != null && input.plateHeight !== '' && !(plateHeight > 0)) {
      errors.push({ type: 'param', message: '板材高度必须为正数。' });
    }

    var collected = collectPoints(input);
    errors.push.apply(errors, collected.errors);

    var base = {
      ok: false,
      errors: errors,
      params: {
        startX: isFinite(startX) ? round3(startX) : null,
        startY: isFinite(startY) ? round3(startY) : null,
        maxRounds: MAX_ROUNDS,
        pointLimit: MAX_POINTS
      },
      pointCount: collected.points.length,
      steps: [],
      stats: null,
      svg: null,
      csv: null
    };
    if (errors.length) return base; // 参数/点数非法：不输出任何部分路径

    var points = collected.points;
    var n = points.length;

    // 1. 距离矩阵 + 起点距离
    var dm = buildDistanceMatrix(points);
    var sd = buildStartDistances(points, startX, startY);

    // 2. 最近邻初始路线
    var nnOrder = nearestNeighbor(points, dm, sd);
    var nnTotal = routeLength(nnOrder, sd, dm);

    // 3. 最多 20 轮 2-opt（原地反转；nnOrder 的副本保留用于叠加对照）
    var optOrder = nnOrder.slice();
    var roundsRun = twoOpt(optOrder, sd, dm);
    var optTotal = routeLength(optOrder, sd, dm);

    var labelCount = 0;
    var seenLabel = Object.create(null);
    points.forEach(function (p) {
      if (p.label != null && !seenLabel[p.label]) { seenLabel[p.label] = true; labelCount++; }
    });

    var stats = {
      pointCount: n,
      labelCount: labelCount,
      nnTravelMm: round3(nnTotal),
      optTravelMm: round3(optTotal),
      savedMm: round3(Math.max(0, nnTotal - optTotal)),
      savedPercent: nnTotal > 0 ? round1((nnTotal - optTotal) / nnTotal * 100) : 0,
      roundsRun: roundsRun,
      maxRounds: MAX_ROUNDS
    };

    base.ok = true;
    base.errors = [];
    base.steps = buildSteps(points, optOrder, sd, dm);
    base.stats = stats;
    base.svg = buildSvg(points, nnOrder, optOrder, sd, startX, startY,
      isFinite(plateWidth) ? plateWidth : null,
      isFinite(plateHeight) ? plateHeight : null,
      stats);
    base.csv = buildCsv(base.steps);
    return base;
  }

  return {
    MAX_POINTS: MAX_POINTS,
    MAX_ROUNDS: MAX_ROUNDS,
    planPath: planPath,
    // 导出纯算法步骤便于单元测试
    nearestNeighbor: nearestNeighbor,
    twoOpt: twoOpt
  };
});
