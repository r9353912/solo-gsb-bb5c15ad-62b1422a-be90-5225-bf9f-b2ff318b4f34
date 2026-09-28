/*
 * 拼版裁切线（Panel Cut / Trim Lines）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 复用“成功拼版”（lib/panel.js 的 packLabels 结果）的每条标签：
 *   - 全局凸点 dots（含 label 编号；旋转标签也已在全局坐标系中）；
 *   - 标签编号 index / 文本 text / 旋转角 rotation；
 *   - 板材尺寸 plateWidth × plateHeight。
 *
 * 用户输入：
 *   - margin       凸点到成品边的最小留边（mm，≥0）；
 *   - toolRadius   刀具半径（mm，>0）。
 *
 * 几何生成（全部在全局毫米坐标中，旋转标签同样按全局点处理）：
 *   1. 凸点包络 envelope：以每个凸点中心 (x,y) 加凸点半径 r 形成圆盘，取全部圆盘的
 *      轴对齐包围矩形（x 向左到最左点、y 向上到最上点……）；
 *   2. 成品边 finish：包络四周外扩 margin（成品零件的裁切边界，矩形）；
 *   3. 刀心线 tool：成品边四周再外扩 toolRadius（刀具中心轨迹矩形——半径刀沿
 *      成品边走一圈时，刀心始终与成品边保持一个刀径）。
 *
 * 整版允许的“最大统一留边” maxMargin：
 *   - 板边约束：每条刀心线必须落在板材 [0,W]×[0,H] 内（刀心外扩 R 后恰好到板边），
 *     对每个标签 × 四条边给出一个留边上限 = 包络到该板边的距离 − toolRadius；
 *   - 标签之间的刀具占位约束：两个标签的“刀心占位矩形”（包络外扩 m+R）不得在
 *     内部相交（仅角点/边相接允许），得到
 *       m ≤ (max(gx, gy) − 2R) / 2，
 *     gx/gy 为两个包络矩形在 x/y 方向的净间距（重叠记 0）；
 *   - maxMargin = 全部约束上限的最小值；其来源（板边或标签对）记为 binding[]。
 *
 * 失败语义（与拼版/压印路径一致，绝不输出部分刀路）：
 *   - maxMargin < 0：即使留边 0 也放不下（刀具本身已越板或标签包络重叠），
 *     或输入 margin > maxMargin：ok=false，errors 明确指出限制它的板边（哪条边、
 *     距包络多少、需 ≤多少）或标签对（两标签编号、各自方向净间距、需 ≤多少），
 *     排在最前的即决定 maxMargin 的最紧约束；cuts/svg/csv 全部为空。
 *
 * 成功时：cuts[] 给出每个标签的包络/成品边/刀心线矩形与四角毫米坐标，
 * svg 为叠加在拼版上的裁切线图（灰点虚线包络、红色成品边、蓝色刀心线 + #编号），
 * csv 为 UTF-8 BOM 下载文本（含标签编号、原文、旋转角与成品边/刀心线四角毫米坐标）。
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

  var EPS = 1e-9;          // 约束判定阈值（mm）
  var MAX_LABELS = 100;    // 与拼版一致的标签条数上限（防止标签对 O(n²) 失控）
  var MAX_ERRORS = 12;     // errors 中最多展开的超限约束条数（其余仅计数提示）

  var EDGE_NAMES = {
    left: '左板边',
    right: '右板边',
    top: '上板边',
    bottom: '下板边'
  };

  /* ---------------- 工具 ---------------- */

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function fmt(n) { return String(round3(n)); }

  // SVG 属性/文本转义
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- 输入解析与校验 ---------------- */

  function collectLabels(input) {
    var errors = [];
    var raw = input.labels;
    if (!Array.isArray(raw)) {
      errors.push({ type: 'param', message: '缺少 labels 标签数据（必须为最近一次成功拼版结果的 labels 数组）。' });
      return { labels: [], errors: errors };
    }
    if (raw.length === 0) {
      errors.push({ type: 'param', message: '当前拼版没有任何标签，无法生成裁切线；请先完成一次成功的多标签拼版。' });
      return { labels: [], errors: errors };
    }
    if (raw.length > MAX_LABELS) {
      errors.push({
        type: 'too-many-labels',
        message: '标签数量为 ' + raw.length + ' 条，超过单次裁切线 ' + MAX_LABELS +
          ' 条上限（与拼版上限一致）。'
      });
      return { labels: [], errors: errors };
    }

    var labels = [];
    for (var i = 0; i < raw.length; i++) {
      var lb = raw[i] || {};
      var idx = num(lb.index);
      if (!(idx >= 1) || Math.floor(idx) !== idx) {
        errors.push({
          type: 'param',
          labelIndex: i + 1,
          message: '第 ' + (i + 1) + ' 条标签数据缺少合法编号 index（成功拼版结果的 label.index 应为 ≥1 的整数）。'
        });
        return { labels: [], errors: errors };
      }
      if (!Array.isArray(lb.dots) || lb.dots.length === 0) {
        errors.push({
          type: 'label-no-dots',
          labelIndex: idx,
          message: '标签 #' + idx + ' 没有任何全局凸点数据，无法形成凸点包络；请重新拼版后再生成裁切线。'
        });
        return { labels: [], errors: errors };
      }

      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      var dotError = null;
      for (var k = 0; k < lb.dots.length; k++) {
        var d = lb.dots[k] || {};
        var dx = num(d.x), dy = num(d.y), dr = num(d.r);
        if (!isFinite(dx) || !isFinite(dy) || !(dr > 0)) {
          dotError = '标签 #' + idx + ' 的第 ' + (k + 1) +
            ' 个凸点坐标或半径非法（x=' + d.x + '，y=' + d.y + '，r=' + d.r +
            '），请重新拼版后再生成裁切线。';
          break;
        }
        if (dx - dr < minX) minX = dx - dr;
        if (dy - dr < minY) minY = dy - dr;
        if (dx + dr > maxX) maxX = dx + dr;
        if (dy + dr > maxY) maxY = dy + dr;
      }
      if (dotError) {
        errors.push({ type: 'param', labelIndex: idx, message: dotError });
        return { labels: [], errors: errors };
      }

      var rot = num(lb.rotation);
      labels.push({
        index: idx,
        text: String(lb.text == null ? '' : lb.text),
        rotation: isFinite(rot) ? Math.floor(rot) : 0,
        dots: lb.dots,
        envelope: {
          left: round3(minX), top: round3(minY),
          right: round3(maxX), bottom: round3(maxY)
        }
      });
    }

    // 编号必须唯一（拼版编号语义），排序后逐条检查
    var indices = labels.map(function (l) { return l.index; }).sort(function (a, b) { return a - b; });
    for (var j = 1; j < indices.length; j++) {
      if (indices[j] === indices[j - 1]) {
        errors.push({
          type: 'param',
          labelIndex: indices[j],
          message: '标签编号 #' + indices[j] + ' 在 labels 中重复出现，裁切线要求每条标签编号唯一（请使用成功拼版的原始结果）。'
        });
        return { labels: [], errors: errors };
      }
    }
    return { labels: labels, errors: errors };
  }

  /* ---------------- 矩形与四角 ---------------- */

  function rect(left, top, right, bottom) {
    return {
      left: round3(left), top: round3(top), right: round3(right), bottom: round3(bottom),
      width: round3(right - left), height: round3(bottom - top),
      corners: {
        tl: { x: round3(left), y: round3(top) },        // 左上
        tr: { x: round3(right), y: round3(top) },       // 右上
        br: { x: round3(right), y: round3(bottom) },    // 右下
        bl: { x: round3(left), y: round3(bottom) }      // 左下（顺时针 tl→tr→br→bl）
      }
    };
  }

  function expanded(env, amount) {
    return rect(env.left - amount, env.top - amount, env.right + amount, env.bottom + amount);
  }

  // 两个轴对齐矩形在 x / y 方向的净间距（重叠或相接记 0）
  function axisGap(a, b) {
    var gx = Math.max(0, a.left - b.right, b.left - a.right);
    var gy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return { x: gx, y: gy };
  }

  /* ---------------- 约束求解 ----------------
   * 返回 { constraints, maxMargin }，constraints 每项：
   *   { kind:'plate', label, edge, dist, limit }
   *   { kind:'pair',  labelA, labelB, gapX, gapY, limit }
   * limit 为该约束允许的统一留边最大值（原始数值，未取整）。
   */
  function buildConstraints(labels, plateWidth, plateHeight, toolRadius) {
    var list = [];

    // 板边：刀心线（包络外扩 m+R）不得越出板材
    labels.forEach(function (lb) {
      var e = lb.envelope;
      list.push({ kind: 'plate', label: lb.index, edge: 'left', dist: e.left, limit: e.left - toolRadius });
      list.push({ kind: 'plate', label: lb.index, edge: 'right', dist: round3(plateWidth - e.right), limit: plateWidth - e.right - toolRadius });
      list.push({ kind: 'plate', label: lb.index, edge: 'top', dist: e.top, limit: e.top - toolRadius });
      list.push({ kind: 'plate', label: lb.index, edge: 'bottom', dist: round3(plateHeight - e.bottom), limit: plateHeight - e.bottom - toolRadius });
    });

    // 标签之间：刀心占位矩形（包络外扩 m+R）不得在内部相交
    for (var i = 0; i < labels.length; i++) {
      for (var j = i + 1; j < labels.length; j++) {
        var a = labels[i].envelope, b = labels[j].envelope;
        var g = axisGap(a, b);
        list.push({
          kind: 'pair',
          labelA: labels[i].index,
          labelB: labels[j].index,
          gapX: round3(g.x),
          gapY: round3(g.y),
          limit: (Math.max(g.x, g.y) - 2 * toolRadius) / 2
        });
      }
    }

    list.sort(function (a, b) {
      if (a.limit !== b.limit) return a.limit - b.limit;
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      var ai = a.kind === 'plate' ? a.label : a.labelA;
      var bi = b.kind === 'plate' ? b.label : b.labelA;
      if (ai !== bi) return ai - bi;
      if (a.kind === 'plate') return a.edge < b.edge ? -1 : (a.edge > b.edge ? 1 : 0);
      return a.labelB - b.labelB;
    });

    return { constraints: list, maxMargin: list.length ? list[0].limit : Infinity };
  }

  /* ---------------- 超限约束 -> 错误信息 ---------------- */

  function constraintError(c, margin, maxMargin, toolRadius) {
    if (c.kind === 'plate') {
      var msg =
        '板边约束：标签 #' + c.label + ' 的凸点包络到' + EDGE_NAMES[c.edge] + '仅 ' + fmt(c.dist) +
        ' mm，扣除刀具半径 ' + fmt(toolRadius) + ' mm 后留边最多 ' + fmt(c.limit) +
        ' mm（刀心线外扩一个刀径后不得越出板材）；当前输入留边 ' + fmt(margin) + ' mm 超过该上限。';
      return { type: 'plate-edge-limit', constraintType: 'plate', labelIndex: c.label, edge: c.edge,
        distMm: c.dist, limitMm: round3(c.limit), maxMarginMm: round3(maxMargin), message: msg };
    }
    var msg =
      '标签对刀具占位：标签 #' + c.labelA + ' 与 #' + c.labelB + ' 的凸点包络净间距为 x 方向 ' +
      fmt(c.gapX) + ' mm、y 方向 ' + fmt(c.gapY) + ' mm（取较大方向 ' + fmt(Math.max(c.gapX, c.gapY)) +
      ' mm），两侧刀心占位后统一留边最多 ' + fmt(c.limit) + ' mm；当前输入留边 ' + fmt(margin) +
      ' mm 超过该上限（两把刀的占位矩形会相交）。';
    return { type: 'label-pair-limit', constraintType: 'pair', labelA: c.labelA, labelB: c.labelB,
      gapXMm: c.gapX, gapYMm: c.gapY, limitMm: round3(c.limit), maxMarginMm: round3(maxMargin), message: msg };
  }

  /* ---------------- 裁切线构造 ---------------- */

  function buildCuts(labels, margin, toolRadius) {
    return labels.map(function (lb) {
      var e = lb.envelope;
      var env = rect(e.left, e.top, e.right, e.bottom);
      var finish = expanded(e, margin);
      var tool = expanded(e, margin + toolRadius);
      return {
        label: lb.index,
        text: lb.text,
        rotation: lb.rotation,
        envelope: env,
        finish: finish,
        tool: tool
      };
    });
  }

  /* ---------------- 叠加 SVG（拼版预览 + 独立下载） ---------------- */

  function buildSvg(labels, cuts, plateWidth, plateHeight, margin, toolRadius, maxMargin) {
    var W = plateWidth, H = plateHeight;
    var byIndex = {};
    labels.forEach(function (lb) { byIndex[lb.index] = lb; });
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" data-unit="mm" data-label-count="' + cuts.length + '" ' +
      'data-margin="' + round3(margin) + '" data-tool-radius="' + round3(toolRadius) +
      '" data-max-margin="' + round3(maxMargin) + '">');
    out.push('  <!-- 拼版裁切线：板材 ' + W + 'mm × ' + H + 'mm；最小留边 ' + round3(margin) +
      'mm，刀具半径 ' + round3(toolRadius) + 'mm，整版最大统一留边 ' + round3(maxMargin) +
      'mm；灰色点虚线=凸点包络，红色实线=成品边（包络外扩留边），蓝色虚线=刀心线（成品边再外扩刀径）；坐标单位均为 mm -->');
    out.push('  <rect id="plate" x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');

    cuts.forEach(function (cut) {
      var lb = byIndex[cut.label];
      var col = cut.rotation === 90 ? '#d97706' : '#2563eb';
      out.push('  <g class="cut-label" data-label-index="' + cut.label + '" data-rotation="' + cut.rotation + '">');
      out.push('    <title>#' + cut.label + ' ' + esc(cut.text) + '（' + cut.rotation + '°）：成品边 ' +
        cut.finish.width + ' × ' + cut.finish.height + ' mm；刀心线 ' + cut.tool.width + ' × ' +
        cut.tool.height + ' mm</title>');

      // 凸点（淡黑小圆，仅定位参照）
      out.push('    <g class="cut-dots" fill="#111111" fill-opacity="0.5">');
      lb.dots.forEach(function (d) {
        out.push('      <circle cx="' + d.x + '" cy="' + d.y + '" r="' + d.r + '"/>');
      });
      out.push('    </g>');

      // 凸点包络：灰点虚线
      var e = cut.envelope;
      out.push('    <rect class="cut-envelope" x="' + e.left + '" y="' + e.top + '" width="' + e.width +
        '" height="' + e.height + '" fill="none" stroke="#9ca3af" stroke-width="0.15" stroke-dasharray="0.6 0.5"/>');

      // 刀心线：蓝色虚线（先画，成品边压在其上）
      var t = cut.tool;
      out.push('    <rect class="cut-tool" x="' + t.left + '" y="' + t.top + '" width="' + t.width +
        '" height="' + t.height + '" fill="none" stroke="#2563eb" stroke-width="0.25" stroke-dasharray="1.6 0.8"/>');

      // 成品边：红色实线
      var f = cut.finish;
      out.push('    <rect class="cut-finish" x="' + f.left + '" y="' + f.top + '" width="' + f.width +
        '" height="' + f.height + '" fill="none" stroke="#dc2626" stroke-width="0.3"/>');

      // 标签编号（旋转标签沿用橙色）
      var fs = 2.6;
      var tx = f.left + 0.4;
      var ty = f.top - 0.7 >= 0 ? f.top - 0.7 : f.top + fs * 0.9;
      out.push('    <text class="cut-index" x="' + round3(tx) + '" y="' + round3(ty) +
        '" font-size="' + fs + '" text-anchor="start" fill="' + col + '" opacity="0.95" ' +
        'pointer-events="none">#' + cut.label + (cut.rotation === 90 ? ' ⟳90°' : '') + '</text>');

      // 成品边四角毫米坐标（出板的角不标）
      var cf = 1.0; // 文字离角点的净距
      [f.corners.tl, f.corners.tr, f.corners.br, f.corners.bl].forEach(function (q, qi) {
        var onPlate = q.x >= -EPS && q.x <= W + EPS && q.y >= -EPS && q.y <= H + EPS;
        if (!onPlate) return;
        var ax, ay, anchor;
        if (qi === 0) { ax = q.x - cf; ay = q.y - cf; anchor = 'end'; }
        else if (qi === 1) { ax = q.x + cf; ay = q.y - cf; anchor = 'start'; }
        else if (qi === 2) { ax = q.x + cf; ay = q.y + cf + 1.4; anchor = 'start'; }
        else { ax = q.x - cf; ay = q.y + cf + 1.4; anchor = 'end'; }
        out.push('    <text class="cut-corner" x="' + round3(ax) + '" y="' + round3(ay) +
          '" font-size="1.5" text-anchor="' + anchor + '" fill="#7f1d1d" pointer-events="none" ' +
          'stroke="#ffffff" stroke-width="0.35" paint-order="stroke">' +
          fmt(q.x) + ',' + fmt(q.y) + '</text>');
      });

      out.push('  </g>');
    });

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- CSV（标签编号 + 成品边/刀心线四角毫米坐标） ---------------- */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function corners4(r) {
    var c = r.corners;
    return [
      c.tl.x, c.tl.y, c.tr.x, c.tr.y,
      c.br.x, c.br.y, c.bl.x, c.bl.y
    ];
  }

  function buildCsv(cuts) {
    var rows = [
      'label,text,rotation_deg,' +
      'finish_tl_x_mm,finish_tl_y_mm,finish_tr_x_mm,finish_tr_y_mm,' +
      'finish_br_x_mm,finish_br_y_mm,finish_bl_x_mm,finish_bl_y_mm,' +
      'tool_tl_x_mm,tool_tl_y_mm,tool_tr_x_mm,tool_tr_y_mm,' +
      'tool_br_x_mm,tool_br_y_mm,tool_bl_x_mm,tool_bl_y_mm'
    ];
    cuts.forEach(function (cut) {
      var row = [cut.label, cut.text, cut.rotation]
        .concat(corners4(cut.finish))
        .concat(corners4(cut.tool));
      rows.push(row.map(csvCell).join(','));
    });
    return '﻿' + rows.join('\r\n');
  }

  /* ---------------- 主入口 ---------------- */

  function planCuts(input) {
    input = input || {};
    var errors = [];

    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);
    if (!(plateWidth > 0)) errors.push({ type: 'param', message: '板材宽度必须为正数（mm）。' });
    if (!(plateHeight > 0)) errors.push({ type: 'param', message: '板材高度必须为正数（mm）。' });

    // 凸点到成品边的最小留边：≥0 的有限数（字段名兼容 minMargin）
    var marginRaw = input.margin != null && input.margin !== '' ? input.margin : input.minMargin;
    var margin = num(marginRaw);
    if (!isFinite(margin)) {
      errors.push({ type: 'param', message: '凸点到成品边的最小留边必须是数字（mm）。' });
    } else if (margin < 0) {
      errors.push({ type: 'param', message: '凸点到成品边的最小留边不能为负数（mm）。' });
    }

    var toolRadius = num(input.toolRadius != null && input.toolRadius !== '' ? input.toolRadius : NaN);
    if (!isFinite(toolRadius)) {
      errors.push({ type: 'param', message: '刀具半径必须是数字（mm）。' });
    } else if (!(toolRadius > 0)) {
      errors.push({ type: 'param', message: '刀具半径必须为正数（mm）。' });
    }

    var collected = collectLabels(input);
    errors.push.apply(errors, collected.errors);

    var base = {
      ok: false,
      errors: errors,
      params: {
        margin: isFinite(margin) && margin >= 0 ? round3(margin) : null,
        toolRadius: isFinite(toolRadius) && toolRadius > 0 ? round3(toolRadius) : null,
        plateWidth: isFinite(plateWidth) && plateWidth > 0 ? round3(plateWidth) : null,
        plateHeight: isFinite(plateHeight) && plateHeight > 0 ? round3(plateHeight) : null
      },
      labelCount: collected.labels.length,
      maxMargin: null,
      binding: [],
      cuts: [],
      stats: null,
      svg: null,
      csv: null
    };
    if (errors.length) return base; // 参数/标签数据非法：不输出任何部分刀路

    var labels = collected.labels;
    labels.sort(function (a, b) { return a.index - b.index; });

    // 1. 全部板边 + 标签对约束，求整版最大统一留边
    var solved = buildConstraints(labels, plateWidth, plateHeight, toolRadius);
    var maxMargin = solved.maxMargin;
    base.maxMargin = round3(maxMargin);
    base.binding = solved.constraints.map(function (c) {
      if (c.kind === 'plate') {
        return { kind: 'plate', label: c.label, edge: c.edge, distMm: c.dist, limitMm: round3(c.limit) };
      }
      return { kind: 'pair', labelA: c.labelA, labelB: c.labelB, gapXMm: c.gapX, gapYMm: c.gapY, limitMm: round3(c.limit) };
    });

    // 2. 可行性：最大留边为负（留边 0 也放不下），或输入留边超限
    if (maxMargin < -EPS || margin > maxMargin + EPS) {
      var limiting = solved.constraints.filter(function (c) {
        return margin > c.limit + EPS;
      });
      var detailErrors = limiting.slice(0, MAX_ERRORS).map(function (c) {
        return constraintError(c, margin, maxMargin, toolRadius);
      });
      if (limiting.length > MAX_ERRORS) {
        detailErrors.push({
          type: 'more-limits',
          message: '另有 ' + (limiting.length - MAX_ERRORS) + ' 条约束同样超限（板边/标签对）；' +
            '整版最大统一留边为 ' + fmt(maxMargin) + ' mm，请把留边降到该值以内，或加大板材/标签间距/减小刀径。'
        });
      }
      if (maxMargin < -EPS && detailErrors.length) {
        // 首条即最紧约束；补一句总判定
        detailErrors.unshift({
          type: 'no-feasible-margin',
          message: '整版允许的最大统一留边为 ' + fmt(maxMargin) +
            ' mm（小于 0）：即使留边取 0，刀具占位也会越出板材或标签之间占位相交，无法在当前板材/刀径下裁切；' +
            '请加大板材、增大标签间距或减小刀具半径。限制最紧的约束如下：'
        });
      }
      base.errors = detailErrors;
      return base; // 不输出部分刀路
    }

    // 3. 可行：生成每标签包络/成品边/刀心线 + SVG + CSV
    var cuts = buildCuts(labels, margin, toolRadius);

    base.ok = true;
    base.errors = [];
    base.cuts = cuts;
    base.stats = {
      labelCount: cuts.length,
      margin: round3(margin),
      toolRadius: round3(toolRadius),
      maxMargin: round3(maxMargin),
      marginHeadroom: round3(maxMargin - margin), // 输入留边距上限的余量
      bindingCount: solved.constraints.filter(function (c) {
        return Math.abs(c.limit - maxMargin) <= 1e-6;
      }).length,
      plateWidth: round3(plateWidth),
      plateHeight: round3(plateHeight)
    };
    base.svg = buildSvg(labels, cuts, plateWidth, plateHeight, margin, toolRadius, maxMargin);
    base.csv = buildCsv(cuts);
    return base;
  }

  return {
    MAX_LABELS: MAX_LABELS,
    planCuts: planCuts,
    // 导出纯几何步骤便于单元测试
    expanded: function (env, amount) { return expanded(env, amount); },
    axisGap: axisGap
  };
});
