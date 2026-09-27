/*
 * 多标签拼版（Multi-Label Panel Imposition）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 流程：
 *   1. 用户输入多条英文标签（每行一条）+ 共享的板材 / 点距 / 行距 / 边距 / 标签间距参数；
 *   2. 逐条复用单标签盲文转换（Braille.textToCells）与单行排版（Braille.layout，
 *      虚拟板材宽度恰好容纳该标签全部单元、边距 0，故绝不换行、绝不裁切），
 *      得到每个标签作为“不可拆分矩形”的宽高与局部凸点坐标；
 *   3. 带板材边距的二维行级（shelf）装箱：从上到下开“行”，每行内从左到右摆放，
 *      标签间留 labelGap；每个标签允许 0° / 90° 两种朝向，在“所有可行候选
 *      （现有行内放得下 / 新开一行）”中按
 *        ① 放入后整张已装区域（envelope）剩余面积最小
 *          （标签面积在旋转下不变，等价于已装包围盒面积最小）；
 *        ② 再相同则 y 最小、③ x 最小、④ 优先 0°、⑤ 行序号最小
 *      稳定择优；
 *   4. 任一标签含不支持字符、两个朝向都超出板材有效幅面、或装箱阶段无处可放时，
 *      返回逐条（标签序号 + 原因）错误，且不输出任何部分版面（svg/dots/labels 全空）。
 *
 * 坐标单位均为毫米 mm，原点在板材左上角，x 向右、y 向下。
 * 90° 旋转采用与 SVG 一致的“顺时针 90°”：局部点 (lx,ly) 经
 *   translate(x,y) rotate(90) 映射为全局 (x-ly, y+lx)，
 * 即旋转后标签文字沿 +y 方向向下阅读，包围矩形为 (x-h, y, w=h0, h=w0)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./braille'));
  } else {
    root.Panel = factory(root.Braille);
  }
})(typeof self !== 'undefined' ? self : this, function (Braille) {
  'use strict';

  var EPS = 1e-9;

  var MAX_LABELS = 100;        // 单次拼版的非空标签条数上限
  var LABEL_TEXT_MAX = 500;    // 单条标签字符上限（与单标签排版一致）

  var DEFAULTS = {
    plateWidth: 120,
    plateHeight: 80,
    dotSpacing: 2.5,
    lineSpacing: 10,
    margin: 5,
    labelGap: 5, // 相邻标签之间（水平与竖直方向）的净间距 mm
    cellGap: null,
    dotDiameter: null
  };

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }

  // SVG 属性/文本转义（防御性：当前插值多为数字，未来加入用户文本时也安全）
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- 输入解析 ---------------- */

  // labels 支持字符串（每行一条）或字符串数组；去除行首尾空白，跳过纯空白行。
  // 返回 { items:[{index, line, text}], skippedBlank }，index 为 1 基的非空序号。
  function parseLabels(input) {
    var raw = [];
    if (typeof input === 'string') {
      raw = input.split(/\r\n|\r|\n/);
    } else if (Array.isArray(input)) {
      for (var i = 0; i < input.length; i++) raw.push(String(input[i] == null ? '' : input[i]));
    }
    var items = [];
    var skippedBlank = 0;
    for (var li = 0; li < raw.length; li++) {
      var text = String(raw[li]).trim();
      if (text === '') { skippedBlank++; continue; }
      items.push({ index: items.length + 1, line: li + 1, text: text });
    }
    return { items: items, skippedBlank: skippedBlank };
  }

  /* ---------------- 单标签 -> 不可拆分矩形（复用单标签盲文转换） ----------------
   * 以“边距 0、宽恰好容纳全部单元、高恰为一行单元高度”的虚拟板材调用
   * Braille.layout：容量按整词换行计算，而宽度严格等于整行所需宽度，
   * 因此结果恒为单行、无换行；任何不支持字符直接作为该标签错误返回。
   */
  function buildLabel(item, p) {
    var conv = Braille.textToCells(item.text);
    if (conv.errors.length) {
      return {
        ok: false,
        errors: conv.errors.map(function (e) {
          return {
            type: 'label-unsupported-char',
            labelIndex: item.index,
            message: '标签 #' + item.index + '「' + item.text + '」：' + e.message
          };
        })
      };
    }

    var n = conv.cells.length;
    if (n === 0) {
      return { ok: false, errors: [{ type: 'label-empty', labelIndex: item.index, message: '标签 #' + item.index + ' 为空。' }] };
    }

    var width = round3(p.dotSpacing + (n - 1) * p.cellPitch); // 单行占宽
    var height = p.cellHeight;                                 // 单行占高 = 2×点距
    var vr = Braille.layout({
      text: item.text,
      plateWidth: width,
      plateHeight: height,
      dotSpacing: p.dotSpacing,
      lineSpacing: p.lineSpacing,
      margin: 0,
      cellGap: p.cellGap,
      dotDiameter: p.dotDiameter
    });

    if (!vr.ok || vr.errors.length) {
      var msg = vr.errors && vr.errors[0] ? vr.errors[0].message : '单行盲文排版失败。';
      return {
        ok: false,
        errors: [{ type: 'label-layout', labelIndex: item.index, message: '标签 #' + item.index + '「' + item.text + '」：' + msg }]
      };
    }

    return {
      ok: true,
      label: {
        index: item.index,
        line: item.line,
        text: item.text,
        brailleText: vr.brailleText,
        cells: n,
        localWidth: width,
        localHeight: height,
        localDots: vr.dots // 虚拟板材边距 0，即标签局部坐标（原点在标签左上角）
      }
    };
  }

  /* ---------------- 二维行级装箱（shelf packing，允许 0/90° 旋转） ---------------- */

  // 按当前货架（行）高度 + 行间距，重算每行 y 与每个标签的最终锚点
  function reflow(shelves, originY, gap) {
    var y = originY;
    var envW = 0;
    for (var s = 0; s < shelves.length; s++) {
      var sh = shelves[s];
      sh.y = round3(y);
      if (sh.usedW > envW) envW = sh.usedW;
      for (var t = 0; t < sh.items.length; t++) {
        var it = sh.items[t];
        it.y = sh.y;
      }
      y += sh.h + gap;
    }
    var envH = shelves.length
      ? shelves.reduce(function (sum, x) { return sum + x.h; }, 0) + gap * (shelves.length - 1)
      : 0;
    return { envW: round3(envW), envH: round3(envH) };
  }

  /* 依次装入 labels（已保证至少一个朝向能放进有效幅面）。
   * 每步枚举：每个现有货架 × 两个朝向（水平放得下且竖直不溢出）+ 新开货架 × 两朝向，
   * 以“放入后已装包围盒剩余面积最小 → y → x → 0°优先 → 货架序号”择优。
   * 返回 { placements, shelves, packWidth, packHeight } 或 { failures:[{labelIndex,message}] }。
   */
  function pack(labelRects, originX, originY, usableW, usableH, gap) {
    var shelves = [];
    var placed = [];
    var failures = [];

    for (var li = 0; li < labelRects.length; li++) {
      var L = labelRects[li];
      var best = null; // { shelfIndex, isNew, rot, x, y, w, h, envW, envH, envArea }

      function consider(shelfIndex, isNew, rot, w, h) {
        var target = isNew ? null : shelves[shelfIndex];
        // 候选包围矩形左缘：货架首项对齐 originX，其后每项前加一个 labelGap
        var shelfHasItems = !isNew && target.items.length > 0;
        var boundsLeft = originX + (shelfHasItems ? gap + target.usedW : 0);
        // 锚点 = 局部原点：0° 时即矩形左边；90° 时在矩形右边（translate(x,y) rotate(90)）
        var x = boundsLeft + (rot === 0 ? 0 : w);

        // 水平方向必须放得下（该货架放入后的已用宽度：首项无间距，其后每项前加一次 gap）
        var usedAfter = (isNew ? 0 : target.usedW) + (shelfHasItems ? gap : 0) + w;
        if (usedAfter > usableW + EPS) return;

        // 竖直方向：模拟放入后的货架高度序列，总高不得超出有效幅面；
        // 同时计算该候选标签的锚点 y（= 所在货架当前 y，只取决于上方货架高度）
        var envH = 0, envW = 0;
        var placedY = 0, offset = 0;
        for (var s = 0; s < shelves.length; s++) {
          var shH = shelves[s].h;
          if (!isNew && s === shelfIndex) {
            placedY = offset; // 现有货架：本行 y 不因本行加高而变化
            shH = Math.max(shH, h);
          }
          offset += shH + gap;
          envH += shH;
        }
        if (isNew) {
          placedY = shelves.length ? offset - gap : 0; // 新行紧跟最后一行（去掉末尾行间距）
          envH += h;
        }
        envH += gap * (isNew ? shelves.length : shelves.length - 1);

        for (var s3 = 0; s3 < shelves.length; s3++) {
          var sw = shelves[s3].usedW;
          if (!isNew && s3 === shelfIndex) sw = Math.max(sw, usedAfter);
          if (sw > envW) envW = sw;
        }
        if (isNew && w > envW) envW = w;
        if (envH > usableH + EPS) return;

        var cand = {
          shelfIndex: isNew ? shelves.length : shelfIndex,
          isNew: isNew,
          rot: rot,
          x: round3(x),
          boundsLeft: round3(boundsLeft),
          y: round3(originY + placedY),
          w: w,
          h: h,
          envW: round3(envW),
          envH: round3(envH),
          envArea: round3(envW * envH)
        };

        if (best === null ||
          cand.envArea < best.envArea - EPS ||
          (Math.abs(cand.envArea - best.envArea) <= EPS &&
            (cand.y < best.y - EPS ||
              (Math.abs(cand.y - best.y) <= EPS &&
                (cand.boundsLeft < best.boundsLeft - EPS ||
                  (Math.abs(cand.boundsLeft - best.boundsLeft) <= EPS &&
                    (cand.rot < best.rot ||
                      (cand.rot === best.rot && cand.shelfIndex < best.shelfIndex)))))))) {
          best = cand;
        }
      }

      // 现有货架 × 0° / 90°
      for (var si = 0; si < shelves.length; si++) {
        consider(si, false, 0, L.localWidth, L.localHeight);
        consider(si, false, 90, L.localHeight, L.localWidth);
      }
      // 新开货架 × 0° / 90°
      consider(-1, true, 0, L.localWidth, L.localHeight);
      consider(-1, true, 90, L.localHeight, L.localWidth);

      if (best === null) {
        failures.push({
          type: 'label-pack-fail',
          labelIndex: L.index,
          message: '标签 #' + L.index + '「' + L.text + '」（尺寸 ' + L.localWidth + ' × ' + L.localHeight +
            ' mm，含 0°/90° 两种朝向）在当前板材有效幅面 ' + round3(usableW) + ' × ' + round3(usableH) +
            ' mm 与已排 ' + placed.length + ' 个标签之后已无空位可放；请加大板材、减小边距/标签间距/点距，或减少标签。'
        });
        continue;
      }

      var sh;
      if (best.isNew) {
        sh = { h: best.h, usedW: 0, items: [] };
        shelves.push(sh);
      } else {
        sh = shelves[best.shelfIndex];
        sh.h = Math.max(sh.h, best.h);
      }
      var placement = {
        index: L.index,
        line: L.line,
        text: L.text,
        brailleText: L.brailleText,
        cells: L.cells,
        localWidth: L.localWidth,
        localHeight: L.localHeight,
        localDots: L.localDots,
        rotation: best.rot,
        placedW: best.w,
        placedH: best.h,
        x: best.x,
        y: best.y
      };
      sh.items.push(placement);
      // 该货架已用宽度按 items 重建（首项无间距，其后每项前加 labelGap）
      sh.usedW = round3(sh.items.reduce(function (acc2, it, k) {
        return acc2 + (k ? gap : 0) + it.placedW;
      }, 0));
      placed.push(placement);
    }

    if (failures.length) return { failures: failures };

    var flow2 = reflow(shelves, originY, gap);
    return {
      placements: placed,
      shelves: shelves,
      packWidth: flow2.envW,
      packHeight: flow2.envH
    };
  }

  /* ---------------- 坐标 / 输出构造 ---------------- */

  // 局部凸点 -> 全局凸点（90° 顺时针，见文件头说明）
  function globalDots(placement) {
    var x = placement.x, y = placement.y, rot = placement.rotation;
    return placement.localDots.map(function (d) {
      var gx, gy;
      if (rot === 0) {
        gx = x + d.x;
        gy = y + d.y;
      } else {
        gx = x - d.y;
        gy = y + d.x;
      }
      return {
        label: placement.index,
        rotation: rot,
        localX: round3(d.x),
        localY: round3(d.y),
        x: round3(gx),
        y: round3(gy),
        r: d.r,
        line: d.line,
        cell: d.cell,
        dot: d.dot
      };
    });
  }

  // 标签在板材上的包围矩形（90° 时锚点在矩形右上角）
  function placementBounds(pl) {
    if (pl.rotation === 0) {
      return { x: pl.x, y: pl.y, width: pl.placedW, height: pl.placedH };
    }
    return { x: round3(pl.x - pl.placedW), y: pl.y, width: pl.placedW, height: pl.placedH };
  }

  function buildPanelSvg(p, labels) {
    var W = p.plateWidth, H = p.plateHeight;
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" data-unit="mm">');
    out.push('  <!-- 多标签拼版：板材 ' + W + 'mm × ' + H + 'mm；点距 ' + p.dotSpacing + 'mm，行距 ' +
      p.lineSpacing + 'mm，板材边距 ' + p.margin + 'mm，标签间距 ' + p.labelGap +
      'mm；每个标签为不可拆分矩形，允许 0°/90° 旋转；坐标单位均为 mm -->');
    out.push('  <rect id="plate" x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');
    out.push('  <rect id="margin-guide" x="' + p.margin + '" y="' + p.margin + '" width="' + round3(W - 2 * p.margin) +
      '" height="' + round3(H - 2 * p.margin) + '" fill="none" stroke="#bbbbbb" stroke-width="0.15" stroke-dasharray="1 1"/>');

    labels.forEach(function (lb) {
      var b = lb.bounds;
      var col = lb.rotation === 0 ? '#2563eb' : '#d97706';
      out.push('  <g data-label-index="' + lb.index + '" data-rotation="' + lb.rotation + '">');
      out.push('    <title>#' + lb.index + ' ' + esc(lb.text) + '（' + lb.rotation + '°）</title>');
      out.push('    <rect class="label-bounds" x="' + b.x + '" y="' + b.y + '" width="' + b.width +
        '" height="' + b.height + '" rx="0.6" ry="0.6" fill="#ffffff" fill-opacity="0.72" stroke="' +
        col + '" stroke-width="0.25"/>');
      // 标签索引：优先画在边界左上角上方（凸点无遮挡）；上方到板顶不足时画在框内左上角
      var fs = 2.6;
      var tx = b.x + 0.4;
      var ty;
      if (b.y - 0.9 >= 0) {
        ty = b.y - 0.7; // 基线在框线上方
      } else {
        ty = b.y + fs * 0.9;
      }
      out.push('    <text class="label-index" x="' + round3(tx) + '" y="' + round3(ty) +
        '" font-size="' + fs + '" text-anchor="start" fill="' + col + '" opacity="0.9" ' +
        'pointer-events="none">#' + lb.index + (lb.rotation === 90 ? ' ⟳90°' : '') + '</text>');
      // 凸点以标签局部坐标 + transform 输出（与下载 JSON 的旋转角/锚点严格对应）
      if (lb.rotation === 0) {
        out.push('    <g class="label-dots" transform="translate(' + lb.x + ',' + lb.y + ')" fill="#111111">');
      } else {
        out.push('    <g class="label-dots" transform="translate(' + lb.x + ',' + lb.y + ') rotate(90)" fill="#111111">');
      }
      lb.dots.forEach(function (d) {
        out.push('      <circle cx="' + d.localX + '" cy="' + d.localY + '" r="' + d.r +
          '" data-line="' + d.line + '" data-cell="' + d.cell + '" data-dot="' + d.dot + '"/>');
      });
      out.push('    </g>');
      out.push('  </g>');
    });

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- 主入口 ---------------- */

  function packLabels(input) {
    input = input || {};
    var errors = [];

    // 1. 共享板材/点距参数复用单标签排版的规范化与校验（text 置空，长度另行逐条校验）
    var norm = Braille.normalizeParams({
      text: '',
      plateWidth: input.plateWidth != null ? input.plateWidth : DEFAULTS.plateWidth,
      plateHeight: input.plateHeight != null ? input.plateHeight : DEFAULTS.plateHeight,
      dotSpacing: input.dotSpacing != null ? input.dotSpacing : DEFAULTS.dotSpacing,
      lineSpacing: input.lineSpacing != null ? input.lineSpacing : DEFAULTS.lineSpacing,
      margin: input.margin != null ? input.margin : DEFAULTS.margin,
      cellGap: input.cellGap,
      dotDiameter: input.dotDiameter
    });
    var p = norm.params;
    errors.push.apply(errors, norm.errors);

    var labelGap = num(input.labelGap != null && input.labelGap !== '' ? input.labelGap : DEFAULTS.labelGap);
    if (!(labelGap >= 0)) errors.push({ type: 'param', message: '标签间距不能为负数。' });
    if (p) p.labelGap = isFinite(labelGap) ? round3(labelGap) : null;

    // 2. 解析标签行
    var parsed = parseLabels(input.labels);
    var items = parsed.items;
    if (items.length === 0) {
      errors.push({ type: 'label-empty', labelIndex: null, message: '请至少输入一条非空标签（每行一条英文标签）。' });
    }
    if (items.length > MAX_LABELS) {
      errors.push({ type: 'param', message: '一次最多拼版 ' + MAX_LABELS + ' 条标签，当前为 ' + items.length + ' 条。' });
    }
    items.forEach(function (it) {
      if (it.text.length > LABEL_TEXT_MAX) {
        errors.push({
          type: 'label-too-long',
          labelIndex: it.index,
          message: '标签 #' + it.index + '「' + it.text + '」长度为 ' + it.text.length +
            ' 字符，超过单条标签 ' + LABEL_TEXT_MAX + ' 字符上限。'
        });
      }
    });

    var base = {
      ok: false,
      errors: errors,
      mode: 'panel',
      params: p ? p : null,
      labelCount: items.length,
      skippedBlank: parsed.skippedBlank,
      labels: [],
      dots: [],
      stats: null,
      svg: null
    };
    if (errors.length || !p) return base;

    // 3. 逐条复用单标签转换，得到不可拆分矩形；先收集全部转换/超尺寸错误，绝不带着部分版面返回
    var rects = [];
    var usableW = round3(p.plateWidth - 2 * p.margin);
    var usableH = round3(p.plateHeight - 2 * p.margin);
    items.forEach(function (it) {
      var built = buildLabel(it, p);
      if (!built.ok) {
        errors.push.apply(errors, built.errors);
        return;
      }
      var lb = built.label;
      var fit0 = lb.localWidth <= usableW + EPS && lb.localHeight <= usableH + EPS;
      var fit90 = lb.localHeight <= usableW + EPS && lb.localWidth <= usableH + EPS;
      if (!fit0 && !fit90) {
        errors.push({
          type: 'label-too-wide',
          labelIndex: it.index,
          message: '标签 #' + it.index + '「' + it.text + '」单行盲文尺寸为 ' + lb.localWidth + ' × ' + lb.localHeight +
            ' mm（宽 × 高），即使旋转 90°（' + lb.localHeight + ' × ' + lb.localWidth +
            ' mm）也超出板材有效幅面 ' + usableW + ' × ' + usableH +
            ' mm；请加宽/加高板材、减小边距或点距，或缩短该标签。'
        });
        return;
      }
      rects.push(lb);
    });
    if (errors.length) {
      base.errors = errors;
      return base;
    }

    // 4. 二维行级装箱（带边距、允许 0/90° 旋转、剩余面积最小 + y/x 稳定择优）
    var packed = pack(rects, p.margin, p.margin, usableW, usableH, p.labelGap);
    if (packed.failures) {
      base.errors = errors.concat(packed.failures);
      return base;
    }

    // 5. 构造输出：每个标签的全局点、包围矩形、旋转角；顶层 dots 展平供质检等下游复用
    var labelsOut = [];
    var allDots = [];
    var labelArea = 0;
    var rotatedCount = 0;
    packed.placements.forEach(function (pl) {
      var dots = globalDots(pl);
      var bounds = placementBounds(pl);
      labelArea += pl.localWidth * pl.localHeight;
      if (pl.rotation !== 0) rotatedCount++;
      allDots.push.apply(allDots, dots);
      labelsOut.push({
        index: pl.index,
        sourceLine: pl.line,
        text: pl.text,
        brailleText: pl.brailleText,
        cells: pl.cells,
        rotation: pl.rotation,
        x: pl.x,
        y: pl.y,
        localWidth: pl.localWidth,
        localHeight: pl.localHeight,
        placedWidth: pl.placedW,
        placedHeight: pl.placedH,
        bounds: bounds,
        dots: dots
      });
    });

    // 标签序号按输入顺序输出（packed 已按顺序，显式排序以防未来改动）
    labelsOut.sort(function (a, b) { return a.index - b.index; });

    var remainingArea = round3(Math.max(0, packed.packWidth * packed.packHeight - labelArea));
    base.ok = true;
    base.errors = [];
    base.labels = labelsOut;
    base.dots = allDots;
    base.stats = {
      labelCount: labelsOut.length,
      skippedBlank: parsed.skippedBlank,
      rotatedCount: rotatedCount,
      totalCells: labelsOut.reduce(function (s, l) { return s + l.cells; }, 0),
      totalDots: allDots.length,
      packWidth: packed.packWidth,
      packHeight: packed.packHeight,
      labelArea: round3(labelArea),
      remainingArea: remainingArea,
      usableWidth: usableW,
      usableHeight: usableH,
      plateWidth: p.plateWidth,
      plateHeight: p.plateHeight
    };
    base.svg = buildPanelSvg(p, labelsOut);
    return base;
  }

  return {
    DEFAULTS: DEFAULTS,
    MAX_LABELS: MAX_LABELS,
    LABEL_TEXT_MAX: LABEL_TEXT_MAX,
    parseLabels: parseLabels,
    packLabels: packLabels
  };
});
