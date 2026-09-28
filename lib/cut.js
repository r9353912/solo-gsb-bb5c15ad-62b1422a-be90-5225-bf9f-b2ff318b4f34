/*
 * 拼版裁切线（Panel Cut Lines）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 输入：一次成功拼版的每条标签全局凸点（含标签编号 label、凸点半径 r，
 *   可为 /api/panel 返回的 labels[]，或仅给顶层 dots[] 由本模块按 label 分组）、
 *   板材宽高，以及用户参数：
 *     minMargin  凸点到成品边的最小留边（mm）
 *     toolRadius 刀具半径（mm）
 *
 * 每条标签按“全局坐标”生成三层矩形（旋转 90° 的标签同样只使用旋转后的
 * 全局点坐标，不做任何反向旋转）：
 *   1. 凸点包络 envelope：全部 (凸点中心 + 凸点半径 r) 的轴对齐包围盒，
 *      即 [min(x-r), max(x+r)] × [min(y-r), max(y+r)]；
 *   2. 矩形成品边 finish：包络四边整体外扩 minMargin；
 *   3. 刀心线 toolCenter：成品边四边再整体外扩 toolRadius（半径刀具的中心轨迹）。
 *
 * 整版“允许的最大统一留边” maxMargin 取下列约束的最小值：
 *   · 板材边缘（共 4×标签数 条）：
 *       左/右：env.x0 - R ≥ m；env.x1 + R ≤ plateWidth  - m；
 *       上/下：env.y0 - R ≥ m；env.y1 + R ≤ plateHeight - m；
 *   · 标签对之间的刀具占位（每对一条，取分离轴=两轴净间距中的较大轴）：
 *       m ≤ max(gx, gy) / 2 - R，
 *     其中 gx、gy 为两个“凸点包络”在 x / y 轴上的净间距
 *     （投影重叠时净间距为 0）；几何含义：两刀心线矩形在分离轴上的
 *     间距为 g_axis - 2R - 2m，必须 ≥ 0。
 *
 * 若 minMargin > maxMargin：ok=false，errors 指出所有被违反的板边/标签对，
 * 首条（binding）为最紧的那条（数值最小且并列时按方向/标签索引稳定决胜），
 * 并给出可直接使用的最大统一留边；此时 labels/cutLines/svg/csv 全为空
 * ——绝不输出部分刀路。
 *
 * 坐标单位均为毫米 mm，原点在板材左上角，x 向右、y 向下。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PanelCut = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var EPS = 1e-9; // 判定阈值（mm，坐标为 0.001mm 的整数倍）

  /* ---------------- 工具 ---------------- */

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round2(n) { return Math.round(n * 100) / 100; }

  // SVG 属性/文本转义（标签原文可能含 & < > " 等字符）
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* ---------------- 输入收集：labels[] 优先，否则把 dots[] 按 label 分组 ---------------- */

  function collectLabels(input) {
    var errors = [];
    var groups = []; // [{ index, dots:[{x,y,r}] }]
    var i, j, d;

    if (Array.isArray(input.labels) && input.labels.length) {
      for (i = 0; i < input.labels.length; i++) {
        var lb = input.labels[i] || {};
        var index = num(lb.index);
        if (!isFinite(index) || index <= 0) {
          errors.push({ type: 'param', message: '第 ' + (i + 1) + ' 条标签缺少有效编号 index（必须为正数）。' });
          continue;
        }
        var rawDots = Array.isArray(lb.dots) ? lb.dots : [];
        var dots = [];
        for (j = 0; j < rawDots.length; j++) {
          d = rawDots[j] || {};
          var x = num(d.x), y = num(d.y), r = num(d.r);
          if (!isFinite(x) || !isFinite(y) || !(r > 0)) {
            errors.push({
              type: 'param',
              message: '标签 #' + index + ' 的第 ' + (j + 1) + ' 个凸点坐标/半径非法（x=' + d.x +
                '，y=' + d.y + '，r=' + d.r + '），请重新拼版后再生成裁切线。'
            });
            return { groups: [], errors: errors };
          }
          dots.push({ x: x, y: y, r: r });
        }
        if (!dots.length) {
          errors.push({ type: 'param', message: '标签 #' + index + ' 没有任何凸点，无法生成裁切线。' });
          continue;
        }
        groups.push({
          index: Math.trunc(index),
          text: typeof lb.text === 'string' ? lb.text : '',
          rotation: lb.rotation === 90 ? 90 : 0,
          dots: dots
        });
      }
    } else if (Array.isArray(input.dots) && input.dots.length) {
      // 顶层 dots 兜底：按 label 字段分组（label 必须为正整数）
      var byIndex = Object.create(null);
      for (i = 0; i < input.dots.length; i++) {
        d = input.dots[i] || {};
        var gi = num(d.label);
        if (!isFinite(gi) || gi <= 0) {
          errors.push({
            type: 'param',
            message: '第 ' + (i + 1) + ' 个凸点缺少所属标签编号 label（拼版凸点必须带 1 基标签索引）。'
          });
          return { groups: [], errors: errors };
        }
        var gx = num(d.x), gy = num(d.y), gr = num(d.r);
        if (!isFinite(gx) || !isFinite(gy) || !(gr > 0)) {
          errors.push({
            type: 'param',
            message: '第 ' + (i + 1) + ' 个凸点坐标/半径非法（x=' + d.x + '，y=' + d.y + '，r=' + d.r + '）。'
          });
          return { groups: [], errors: errors };
        }
        gi = Math.trunc(gi);
        if (!byIndex[gi]) { byIndex[gi] = { index: gi, text: '', rotation: d.rotation === 90 ? 90 : 0, dots: [] }; }
        byIndex[gi].dots.push({ x: gx, y: gy, r: gr });
      }
      Object.keys(byIndex).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) {
        groups.push(byIndex[k]);
      });
    } else {
      errors.push({
        type: 'no-panel',
        message: '缺少成功拼版的标签数据（labels 或 dots 均为空）；请先在「多标签拼版」完成一次成功拼版。'
      });
    }

    // 编号唯一 + 按编号排序
    var seen = Object.create(null);
    groups.forEach(function (g) {
      if (seen[g.index]) errors.push({ type: 'param', message: '标签编号 #' + g.index + ' 重复出现。' });
      seen[g.index] = true;
    });
    groups.sort(function (a, b) { return a.index - b.index; });
    return { groups: groups, errors: errors };
  }

  /* ---------------- 三层矩形 ----------------
   * 严格按全局凸点坐标计算（旋转标签传入的已是旋转后的全局点，
   * 故此处无需知道旋转角即可得到正确的轴对齐矩形）。
   */
  function rectExpand(r, d) {
    return { x0: round3(r.x0 - d), y0: round3(r.y0 - d), x1: round3(r.x1 + d), y1: round3(r.y1 + d) };
  }

  function rectOf(r) {
    return { x: r.x0, y: r.y0, width: round3(r.x1 - r.x0), height: round3(r.y1 - r.y0) };
  }

  // 四角：TL 左上、TR 右上、BR 右下、BL 左下（板材坐标系，y 向下）。
  // 入参可为 {x0,y0,x1,y1} 或矩形 {x,y,width,height}
  function corners(r) {
    var x0 = r.x0 != null ? r.x0 : r.x;
    var y0 = r.y0 != null ? r.y0 : r.y;
    var x1 = r.x1 != null ? r.x1 : round3(r.x + r.width);
    var y1 = r.y1 != null ? r.y1 : round3(r.y + r.height);
    return [
      { corner: 'TL', x: round3(x0), y: round3(y0) },
      { corner: 'TR', x: round3(x1), y: round3(y0) },
      { corner: 'BR', x: round3(x1), y: round3(y1) },
      { corner: 'BL', x: round3(x0), y: round3(y1) }
    ];
  }

  function buildLabel(group, m, R) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    group.dots.forEach(function (d) {
      if (d.x - d.r < x0) x0 = d.x - d.r;
      if (d.y - d.r < y0) y0 = d.y - d.r;
      if (d.x + d.r > x1) x1 = d.x + d.r;
      if (d.y + d.r > y1) y1 = d.y + d.r;
    });
    var envelope = { x0: round3(x0), y0: round3(y0), x1: round3(x1), y1: round3(y1) };
    var finish = rectExpand(envelope, m);
    var tool = rectExpand(envelope, m + R);
    return {
      index: group.index,
      text: group.text,
      rotation: group.rotation,
      dotCount: group.dots.length,
      envelope: rectOf(envelope),
      finish: rectOf(finish),
      toolCenter: rectOf(tool),
      corners: corners(tool),
      _env: envelope, // 内部约束计算用（不直接序列化）
      _dots: group.dots // 内部叠加绘制用（全局凸点，不直接序列化）
    };
  }

  /* ---------------- 约束集合 ----------------
   * 板边约束：m ≤ limit；标签对约束：m ≤ max(gx,gy)/2 - R。
   * 每条带 kind/side 或 a/b/axis 元数据，供报错定位与稳定排序。
   */
  var SIDE_NAME = { left: '左板边', right: '右板边', top: '上板边', bottom: '下板边' };

  function buildConstraints(labels, plateWidth, plateHeight, R) {
    var list = [];

    // 1) 板边（按标签索引 → 左/上/右/下 稳定顺序）
    labels.forEach(function (lb) {
      var e = lb._env;
      list.push({ kind: 'plate', side: 'left', label: lb.index, limit: round3(e.x0 - R) });
      list.push({ kind: 'plate', side: 'top', label: lb.index, limit: round3(e.y0 - R) });
      list.push({ kind: 'plate', side: 'right', label: lb.index, limit: round3(plateWidth - e.x1 - R) });
      list.push({ kind: 'plate', side: 'bottom', label: lb.index, limit: round3(plateHeight - e.y1 - R) });
    });

    // 2) 标签对（a<b；净间距取两轴较大者，即分离轴）
    for (var i = 0; i < labels.length; i++) {
      for (var j = i + 1; j < labels.length; j++) {
        var ea = labels[i]._env, eb = labels[j]._env;
        var gx = Math.max(0, Math.max(ea.x0 - eb.x1, eb.x0 - ea.x1));
        var gy = Math.max(0, Math.max(ea.y0 - eb.y1, eb.y0 - ea.y1));
        // 分离轴取两轴净间距较大者；等距（含均为 0）时按 x 稳定决胜
        var axis = (gy > gx + EPS) ? 'y' : 'x';
        var gap = Math.max(gx, gy);
        list.push({
          kind: 'pair', a: labels[i].index, b: labels[j].index,
          gapX: round3(gx), gapY: round3(gy), axis: axis,
          limit: round3(gap / 2 - R)
        });
      }
    }

    // 最紧约束（limit 最小；并列按 板边优先于标签对、side 顺序、标签/标签对索引稳定决胜）
    var sideRank = { left: 0, top: 1, right: 2, bottom: 3 };
    list.forEach(function (c) {
      c._r1 = c.kind === 'plate' ? 0 : 1;
      c._r2 = c.kind === 'plate' ? sideRank[c.side] : 0;
    });
    list.sort(function (c1, c2) {
      if (c1.limit < c2.limit - EPS) return -1;
      if (c1.limit > c2.limit + EPS) return 1;
      if (c1._r1 !== c2._r1) return c1._r1 - c2._r1;
      if (c1._r2 !== c2._r2) return c1._r2 - c2._r2;
      if (c1.kind === 'plate') return c1.label - c2.label;
      if (c1.a !== c2.a) return c1.a - c2.a;
      return c1.b - c2.b;
    });
    return list;
  }

  function constraintMessage(c, requested) {
    if (c.kind === 'plate') {
      return '标签 #' + c.label + ' 的刀心线超出' + SIDE_NAME[c.side] +
        '：凸点包络到该板边仅允许留边 ' + c.limit + ' mm（已扣刀具占位），输入留边 ' +
        requested + ' mm 超限';
    }
    var sideText = c.axis === 'x' ? '水平方向' : '竖直方向';
    return '标签对 #' + c.a + ' 与 #' + c.b + ' 的刀具占位冲突：两标签凸点包络在' + sideText +
      '（分离轴）的净间距为 ' + (c.axis === 'x' ? c.gapX : c.gapY) +
      ' mm（另一轴 ' + (c.axis === 'x' ? c.gapY : c.gapX) + ' mm），各侧留边之和不得超过 ' +
      round3((c.axis === 'x' ? c.gapX : c.gapY) / 2) + ' mm，再扣刀具半径后允许留边仅 ' +
      c.limit + ' mm，输入留边 ' + requested + ' mm 超限';
  }

  /* ---------------- CSV（每标签两行：finish / toolCenter，四角毫米坐标） ---------------- */

  function buildCsv(labels) {
    var rows = ['label_index,rotation_deg,rect,corner_tl_x_mm,corner_tl_y_mm,corner_tr_x_mm,corner_tr_y_mm,corner_br_x_mm,corner_br_y_mm,corner_bl_x_mm,corner_bl_y_mm'];
    function row(idx, rot, name, c) {
      return [idx, rot, name,
        c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y
      ].map(csvCell).join(',');
    }
    labels.forEach(function (lb) {
      rows.push(row(lb.index, lb.rotation, 'finish_edge', corners(lb.finish)));
      rows.push(row(lb.index, lb.rotation, 'tool_center', lb.corners));
    });
    return '﻿' + rows.join('\r\n');
  }

  /* ---------------- SVG（自包含整板叠加图：包络/成品边/刀心线/编号/四角坐标） ---------------- */

  function rectTag(cls, r, extra) {
    return '    <rect class="' + cls + '" x="' + r.x + '" y="' + r.y + '" width="' + r.width +
      '" height="' + r.height + '"' + (extra || '') + '/>';
  }

  function buildSvg(labels, plateWidth, plateHeight, m, R, maxMargin) {
    var W = plateWidth, H = plateHeight;
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" data-unit="mm" data-label-count="' + labels.length + '">');
    out.push('  <!-- 拼版裁切线叠加：板材 ' + W + 'mm × ' + H + 'mm；最小留边 ' + m +
      'mm；刀具半径 ' + R + 'mm；整版允许最大统一留边 ' + maxMargin +
      'mm；黄色虚线=凸点包络，黑色圆点=成功拼版的全局凸点（旋转标签同全局坐标），' +
      '蓝色实线=矩形成品边（包络外扩留边），红色实线=刀心线（成品边再外扩刀具半径）；坐标单位均为 mm -->');
    out.push('  <rect id="plate" x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');

    labels.forEach(function (lb) {
      var col = lb.rotation === 0 ? '#2563eb' : '#d97706';
      out.push('  <g data-label-index="' + lb.index + '" data-rotation="' + lb.rotation + '">');
      out.push('    <title>#' + lb.index + (lb.text ? ' ' + esc(lb.text) : '') +
        '（' + lb.rotation + '°）成品边 ' + lb.finish.width + '×' + lb.finish.height +
        'mm；刀心线四角 ' + lb.corners.map(function (c) { return c.corner + '(' + c.x + ',' + c.y + ')'; }).join(' ') + '</title>');

      // 凸点包络（黄色虚线）
      out.push(rectTag('cut-envelope', lb.envelope, ' fill="none" stroke="#ca8a04" stroke-width="0.15" stroke-dasharray="1 0.8"'));

      // 全局凸点（与拼版预览一致；置于矩形下层，半径沿用拼版凸点半径）
      out.push('    <g class="cut-dots" fill="#111111">');
      lb._dots.forEach(function (d) {
        out.push('      <circle cx="' + round3(d.x) + '" cy="' + round3(d.y) + '" r="' + round3(d.r) + '"/>');
      });
      out.push('    </g>');

      // 成品边（蓝色实线）
      out.push(rectTag('cut-finish', lb.finish,
        ' fill="none" stroke="' + col + '" stroke-width="0.25" data-label-index="' + lb.index + '"'));
      // 刀心线（红色实线，略粗）
      out.push(rectTag('cut-tool-center', lb.toolCenter,
        ' fill="none" stroke="#dc2626" stroke-width="0.35" data-label-index="' + lb.index + '"'));

      // 标签编号：成品边内左上角
      out.push('    <text class="cut-label-index" x="' + round3(lb.finish.x + 0.5) + '" y="' +
        round3(lb.finish.y + 2.4) + '" font-size="2.4" fill="' + col + '" pointer-events="none">#' +
        lb.index + (lb.rotation === 90 ? ' ⟳90°' : '') + '</text>');

      // 刀心线四角坐标（红色小字，沿角点外侧摆放）
      var tc = lb.toolCenter;
      var fs = 1.5;
      var pad = 0.35;
      var coords = [
        { x: tc.x, y: tc.y, dx: -pad, dy: -pad, anchor: 'end', baseline: 'auto' },       // TL 在左上
        { x: tc.x + tc.width, y: tc.y, dx: pad, dy: -pad, anchor: 'start', baseline: 'auto' }, // TR
        { x: tc.x + tc.width, y: tc.y + tc.height, dx: pad, dy: pad, anchor: 'start', baseline: 'text-after-edge' }, // BR
        { x: tc.x, y: tc.y + tc.height, dx: -pad, dy: pad, anchor: 'end', baseline: 'text-after-edge' } // BL
      ];
      lb.corners.forEach(function (c, k) {
        var pos = coords[k];
        out.push('    <text class="cut-corner" x="' + round3(pos.x + pos.dx) + '" y="' +
          round3(pos.y + pos.dy) + '" font-size="' + fs + '" text-anchor="' + pos.anchor +
          '" dominant-baseline="' + pos.baseline + '" fill="#b91c1c" pointer-events="none">' +
          c.corner + ' ' + round2(c.x) + ',' + round2(c.y) + '</text>');
      });
      out.push('  </g>');
    });

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- 主入口 ---------------- */

  function planCuts(input) {
    input = input || {};
    var errors = [];

    // 参数解析
    var minMargin = num(input.minMargin != null && input.minMargin !== '' ? input.minMargin : NaN);
    var toolRadius = num(input.toolRadius != null && input.toolRadius !== '' ? input.toolRadius : NaN);
    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);

    if (!isFinite(minMargin) || minMargin < 0) {
      errors.push({ type: 'param', message: '凸点到成品边的最小留边必须为不小于 0 的数字（mm）。' });
    }
    if (!isFinite(toolRadius) || toolRadius < 0) {
      errors.push({ type: 'param', message: '刀具半径必须为不小于 0 的数字（mm）。' });
    }
    if (!isFinite(plateWidth) || !(plateWidth > 0)) {
      errors.push({ type: 'param', message: '板材宽度必须为正数（mm）。' });
    }
    if (!isFinite(plateHeight) || !(plateHeight > 0)) {
      errors.push({ type: 'param', message: '板材高度必须为正数（mm）。' });
    }

    var collected = collectLabels(input);
    errors.push.apply(errors, collected.errors);

    var base = {
      ok: false,
      errors: errors,
      params: {
        minMargin: isFinite(minMargin) && minMargin >= 0 ? round3(minMargin) : null,
        toolRadius: isFinite(toolRadius) && toolRadius >= 0 ? round3(toolRadius) : null,
        plateWidth: isFinite(plateWidth) ? round3(plateWidth) : null,
        plateHeight: isFinite(plateHeight) ? round3(plateHeight) : null
      },
      labelCount: collected.groups.length,
      maxMargin: null,
      binding: null,
      labels: [],
      stats: null,
      svg: null,
      csv: null
    };
    if (errors.length) return base; // 参数/输入非法：不输出任何刀路

    var m = round3(minMargin);
    var R = round3(toolRadius);

    // 最大统一留边：先用包络（与留边无关）构造各标签与约束集合
    var probeLabels = collected.groups.map(function (g) { return buildLabel(g, 0, R); });
    var constraints = buildConstraints(probeLabels, plateWidth, plateHeight, R);
    var binding = constraints[0]; // 已按最紧 → 稳定决胜排序
    var maxMargin = binding ? binding.limit : null;

    base.maxMargin = maxMargin;
    base.binding = binding ? {
      kind: binding.kind,
      side: binding.kind === 'plate' ? binding.side : null,
      label: binding.kind === 'plate' ? binding.label : null,
      labelA: binding.kind === 'pair' ? binding.a : null,
      labelB: binding.kind === 'pair' ? binding.b : null,
      axis: binding.kind === 'pair' ? binding.axis : null,
      gapX: binding.kind === 'pair' ? binding.gapX : null,
      gapY: binding.kind === 'pair' ? binding.gapY : null,
      limit: binding.limit
    } : null;

    // 输入留边超限（含 maxMargin<0 这种任何留边都放不下的情形）：
    // 指出所有被违反的板边/标签对，最紧的一条排首位；不输出部分刀路
    if (!(maxMargin >= m - EPS)) {
      var violated = constraints.filter(function (c) { return m > c.limit + EPS; });
      var limitErrors = violated.map(function (c) {
        return {
          type: c.kind === 'plate' ? 'plate-edge-limit' : 'label-pair-limit',
          side: c.kind === 'plate' ? c.side : null,
          label: c.kind === 'plate' ? c.label : null,
          labelA: c.kind === 'pair' ? c.a : null,
          labelB: c.kind === 'pair' ? c.b : null,
          axis: c.kind === 'pair' ? c.axis : null,
          limit: c.limit,
          message: constraintMessage(c, m)
        };
      });
      var prefix = maxMargin < -EPS
        ? '刀具半径 ' + R + ' mm 已使刀心线无法落在板材内/标签之间（最大允许留边为 ' +
          maxMargin + ' mm，为负）；最紧约束：'
        : '输入留边 ' + m + ' mm 超过整版允许的最大统一留边 ' + maxMargin +
          ' mm（受板材边缘与标签之间刀具占位共同约束）；最紧约束：';
      limitErrors[0] = {
        type: limitErrors[0].type,
        side: limitErrors[0].side,
        label: limitErrors[0].label,
        labelA: limitErrors[0].labelA,
        labelB: limitErrors[0].labelB,
        axis: limitErrors[0].axis,
        limit: limitErrors[0].limit,
        binding: true,
        message: prefix + constraintMessage(binding, m)
      };
      if (limitErrors.length > 1) {
        limitErrors.push({
          type: 'limit-summary',
          message: '此外还有 ' + (limitErrors.length - 1) +
            ' 处板边/标签对不允许该留边；将留边降至 ' + maxMargin + ' mm 及以下即可整版可行。'
        });
      }
      base.errors = limitErrors;
      return base;
    }

    // 可行：按输入留边生成三层矩形、四角坐标、CSV/SVG
    var internal = collected.groups.map(function (g) { return buildLabel(g, m, R); });
    var labels = internal.map(function (lb) {
      // 内部字段（_env/_dots）以不可枚举属性挂载：模块内部绘制可用，JSON 序列化自动忽略
      var out = {
        index: lb.index,
        text: lb.text,
        rotation: lb.rotation,
        dotCount: lb.dotCount,
        envelope: lb.envelope,
        finish: lb.finish,
        toolCenter: lb.toolCenter,
        corners: lb.corners
      };
      Object.defineProperty(out, '_env', { value: lb._env, enumerable: false });
      Object.defineProperty(out, '_dots', { value: lb._dots, enumerable: false });
      return out;
    });

    base.ok = true;
    base.errors = [];
    base.labels = labels;
    base.stats = {
      labelCount: labels.length,
      minMargin: m,
      toolRadius: R,
      maxMargin: maxMargin,
      slack: round3(maxMargin - m), // 输入留边距极限还剩多少 mm
      plateWidth: round3(plateWidth),
      plateHeight: round3(plateHeight),
      plateConstraints: constraints.filter(function (c) { return c.kind === 'plate'; }).length,
      pairConstraints: constraints.filter(function (c) { return c.kind === 'pair'; }).length
    };
    // 贴线约束数（limit == maxMargin），仅作统计信息
    base.stats.bindingCount = constraints.filter(function (c) {
      return Math.abs(c.limit - maxMargin) <= EPS;
    }).length;
    base.svg = buildSvg(labels, plateWidth, plateHeight, m, R, maxMargin);
    base.csv = buildCsv(labels);
    return base;
  }

  return {
    planCuts: planCuts
  };
});
