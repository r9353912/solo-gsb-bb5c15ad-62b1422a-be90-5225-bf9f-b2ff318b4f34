/*
 * 盲文标签排版台 前端逻辑
 * 四种模式：
 *   - 点阵解码：粘贴六点盲文 Unicode -> POST /api/decode -> 还原英文文本、逐单元对照、
 *     未知字符位置/码点错误定位与一键复制（服务不可用时回退浏览器内置同构解码）
 *   - 排版：输入变化 -> 防抖调用 POST /api/layout -> 渲染 SVG 预览 / 错误 -> 下载 SVG/JSON
 *   - 多标签拼版：每行一条标签 + 共享板材/点距/行距/边距/标签间距 -> POST /api/panel，
 *     整板预览全部标签边界与点位，下载含标签索引与旋转角的 SVG/JSON；
 *     拼版成功后可生成压印路径（/api/path）与拼版裁切线（/api/panel/cut：
 *     凸点包络 -> 成品边 -> 刀心线，最大统一留边校验，四角 CSV/叠加 SVG）
 *   - 压印质检：以最近一次成功排版的设计点为基准，粘贴实测 CSV 并设置偏移/公差/半径，
 *     调用 POST /api/qc（浏览器端也可直接用 window.QC 同构计算），渲染四类叠加 SVG 与报告下载
 */
(function () {
  'use strict';

  /* ================= 模式切换 ================= */

  var tabDecode = document.getElementById('tabDecode');
  var tabLayout = document.getElementById('tabLayout');
  var tabPanel = document.getElementById('tabPanel');
  var tabQc = document.getElementById('tabQc');
  var viewDecode = document.getElementById('viewDecode');
  var viewLayout = document.getElementById('viewLayout');
  var viewPanel = document.getElementById('viewPanel');
  var viewQc = document.getElementById('viewQc');

  function setMode(mode) {
    var isDecode = mode === 'decode';
    tabDecode.classList.toggle('active', isDecode);
    tabLayout.classList.toggle('active', mode === 'layout');
    tabPanel.classList.toggle('active', mode === 'panel');
    var isQc = mode === 'qc';
    tabQc.classList.toggle('active', isQc);
    tabDecode.setAttribute('aria-selected', String(isDecode));
    tabLayout.setAttribute('aria-selected', String(mode === 'layout'));
    tabPanel.setAttribute('aria-selected', String(mode === 'panel'));
    tabQc.setAttribute('aria-selected', String(isQc));
    viewDecode.hidden = !isDecode;
    viewLayout.hidden = mode !== 'layout';
    viewPanel.hidden = mode !== 'panel';
    viewQc.hidden = !isQc;
    if (isDecode) ensureDecodeLoaded();
    if (isQc) refreshBaselineBox();
  }
  tabDecode.addEventListener('click', function () { setMode('decode'); });
  tabLayout.addEventListener('click', function () { setMode('layout'); });
  tabPanel.addEventListener('click', function () { setMode('panel'); });
  tabQc.addEventListener('click', function () { setMode('qc'); });

  /* ================= 排版模式 ================= */

  var fields = ['text', 'plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'];
  var els = {};
  fields.forEach(function (id) { els[id] = document.getElementById(id); });

  var errorsBox = document.getElementById('errors');
  var statsBox = document.getElementById('stats');
  var preview = document.getElementById('preview');
  var brailleLine = document.getElementById('brailleLine');
  var btnSvg = document.getElementById('downloadSvg');
  var btnJson = document.getElementById('downloadJson');

  var lastResult = null;     // 最近一次成功的排版结果（用于下载）
  var lastBaseline = null;   // 最近一次成功排版的设计点基准（质检模式用，失败时不被清空）
  var debounceTimer = null;

  function collectParams() {
    var p = { text: els.text.value };
    ['plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'].forEach(function (id) {
      var v = els[id].value.trim();
      if (v !== '') p[id] = Number(v);
    });
    return p;
  }

  function renderErrors(errors) {
    errorsBox.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    errorsBox.appendChild(ul);
    errorsBox.hidden = false;
  }

  function renderStats(r) {
    var p = r.params;
    var s = r.stats;
    statsBox.innerHTML =
      '每行最多 <b>' + r.cellsPerLine + '</b> 个盲文单元，最多 <b>' + r.maxLines + '</b> 行；' +
      '本次 <b>' + s.totalLines + '</b> 行 / <b>' + s.totalCells + '</b> 个单元 / <b>' + s.totalDots + '</b> 个凸点<br>' +
      '占用幅面 ' + s.usedWidth + ' × ' + s.usedHeight + ' mm（板材 ' + p.plateWidth + ' × ' + p.plateHeight + ' mm，' +
      '字距 ' + p.cellGap + ' mm，凸点直径 ' + p.dotDiameter + ' mm）';
    statsBox.hidden = false;
  }

  function fmtTime(d) {
    function z(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) +
      ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  }

  function update() {
    var params = collectParams();
    fetch('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) {
        if (r.ok) {
          lastResult = r;
          // 排版结果已变化：旧压印路径与新凸点集不再对应，作废待重新生成
          invalidateLayoutPath();
          // 质检基准：记录最近一次成功排版（含时间戳与完整参数）
          lastBaseline = {
            time: fmtTime(new Date()),
            text: r.params.text,
            params: r.params,
            dots: r.dots
          };
          errorsBox.hidden = true;
          // 内联预览时去掉 XML 声明，避免被 HTML 解析器当作冗余节点
          preview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
          brailleLine.textContent = r.brailleText.replace(/\n/g, ' / ');
          renderStats(r);
          btnSvg.disabled = false;
          btnJson.disabled = false;
          if (!viewQc.hidden) refreshBaselineBox();
        } else {
          lastResult = null;
          invalidateLayoutPath();
          statsBox.hidden = true;
          brailleLine.textContent = '';
          preview.innerHTML = '<p class="placeholder">排版失败：请根据左侧原因调整参数</p>';
          renderErrors(r.errors || [{ message: '未知错误' }]);
          btnSvg.disabled = true;
          btnJson.disabled = true;
        }
      })
      .catch(function () {
        lastResult = null;
        invalidateLayoutPath();
        statsBox.hidden = true;
        preview.innerHTML = '<p class="placeholder">无法连接服务器</p>';
        renderErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        btnSvg.disabled = true;
        btnJson.disabled = true;
      });
  }

  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, 250);
  }

  fields.forEach(function (id) {
    els[id].addEventListener('input', scheduleUpdate);
  });

  function download(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  btnSvg.addEventListener('click', function () {
    if (lastResult) download('braille-label.svg', 'image/svg+xml;charset=utf-8', lastResult.svg);
  });

  btnJson.addEventListener('click', function () {
    if (!lastResult) return;
    var copy = {};
    Object.keys(lastResult).forEach(function (k) {
      if (k !== 'svg') copy[k] = lastResult[k]; // JSON 下载不含 svg 字符串本体
    });
    download('braille-layout.json', 'application/json;charset=utf-8', JSON.stringify(copy, null, 2));
  });

  /* ================= 多标签拼版模式 ================= */

  var panelFields = ['panelLabels', 'panelPlateWidth', 'panelPlateHeight', 'panelDotSpacing',
    'panelLineSpacing', 'panelMargin', 'panelLabelGap', 'panelCellGap', 'panelDotDiameter'];
  var pEls = {};
  panelFields.forEach(function (id) { pEls[id] = document.getElementById(id); });

  var panelErrorsBox = document.getElementById('panelErrors');
  var panelStatsBox = document.getElementById('panelStats');
  var panelPreview = document.getElementById('panelPreview');
  var btnPanelSvg = document.getElementById('panelDownloadSvg');
  var btnPanelJson = document.getElementById('panelDownloadJson');
  var lastPanel = null;
  var lastPanelBaseline = null; // 最近一次成功拼版（质检基准用，失败时不被清空）
  var panelTimer = null;

  function collectPanelParams() {
    var p = { labels: pEls.panelLabels.value };
    ['panelPlateWidth', 'panelPlateHeight', 'panelDotSpacing', 'panelLineSpacing',
      'panelMargin', 'panelLabelGap', 'panelCellGap', 'panelDotDiameter'].forEach(function (id) {
      var key = id.replace(/^panel/, '');
      key = key.charAt(0).toLowerCase() + key.slice(1);
      var v = pEls[id].value.trim();
      if (v !== '') p[key] = Number(v);
    });
    return p;
  }

  function renderPanelErrors(errors) {
    panelErrorsBox.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    panelErrorsBox.appendChild(ul);
    panelErrorsBox.hidden = false;
  }

  function renderPanelStats(r) {
    var s = r.stats;
    var p = r.params;
    panelStatsBox.innerHTML =
      '共 <b>' + s.labelCount + '</b> 条标签（跳过空行 <b>' + s.skippedBlank + '</b>），' +
      '其中 <b>' + s.rotatedCount + '</b> 条旋转 90°；共 <b>' + s.totalCells + '</b> 个单元 / <b>' +
      s.totalDots + '</b> 个凸点<br>' +
      '已装区域 <b>' + s.packWidth + ' × ' + s.packHeight + '</b> mm（标签面积 ' + s.labelArea +
      ' mm²，剩余面积 <b>' + s.remainingArea + '</b> mm²）；有效幅面 ' + s.usableWidth + ' × ' +
      s.usableHeight + ' mm，板材 ' + p.plateWidth + ' × ' + p.plateHeight + ' mm，标签间距 ' +
      p.labelGap + ' mm';
    panelStatsBox.hidden = false;
  }

  function updatePanel() {
    var params = collectPanelParams();
    fetch('/api/panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
      .then(function (res) { return res.json(); })
      .then(handlePanelResult)
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.Panel) {
          try {
            handlePanelResult(Panel.packLabels(params));
          } catch (e) {
            renderPanelErrors([{ message: '拼版计算失败：' + e.message }]);
          }
        } else {
          lastPanel = null;
          invalidatePanelCut();
          panelStatsBox.hidden = true;
          panelPreview.innerHTML = '<p class="placeholder">无法连接服务器</p>';
          renderPanelErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
          btnPanelSvg.disabled = true;
          btnPanelJson.disabled = true;
        }
      });
  }

  // fetch 成功路径与本地回退路径共用
  function handlePanelResult(r) {
    if (r.ok) {
      lastPanel = r;
      // 拼版结果已变化：旧压印路径与新凸点集不再对应，作废待重新生成
      invalidatePanelPath();
      // 旧裁切线同样作废（每条标签的全局凸点/编号已变）
      invalidatePanelCut();
      // 质检拼版基准：记录最近一次成功拼版（含时间戳、标签索引/旋转角与带元数据的全局 dots）
      lastPanelBaseline = {
        time: fmtTime(new Date()),
        params: r.params,
        labels: r.labels.map(function (l) {
          return { index: l.index, text: l.text, rotation: l.rotation };
        }),
        labelCount: r.labelCount,
        rotatedCount: r.stats ? r.stats.rotatedCount : 0,
        dots: r.dots
      };
      panelErrorsBox.hidden = true;
      panelPreview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
      renderPanelStats(r);
      btnPanelSvg.disabled = false;
      btnPanelJson.disabled = false;
      // 若用户停留在质检页，立即刷新基准区（按钮可用性/标签摘要随最新拼版更新）
      if (!viewQc.hidden) refreshBaselineBox();
    } else {
      lastPanel = null;
      invalidatePanelPath();
      invalidatePanelCut();
      panelStatsBox.hidden = true;
      renderPanelErrors(r.errors || [{ message: '未知错误' }]);
      btnPanelSvg.disabled = true;
      btnPanelJson.disabled = true;
      if (!viewQc.hidden) refreshBaselineBox();
    }
  }

  function schedulePanelUpdate() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(updatePanel, 250);
  }

  panelFields.forEach(function (id) {
    pEls[id].addEventListener('input', schedulePanelUpdate);
  });

  btnPanelSvg.addEventListener('click', function () {
    if (lastPanel) download('braille-panel.svg', 'image/svg+xml;charset=utf-8', lastPanel.svg);
  });

  btnPanelJson.addEventListener('click', function () {
    if (!lastPanel) return;
    var copy = {};
    Object.keys(lastPanel).forEach(function (k) {
      if (k !== 'svg') copy[k] = lastPanel[k]; // JSON 下载不含 svg 字符串本体
    });
    download('braille-panel.json', 'application/json;charset=utf-8', JSON.stringify(copy, null, 2));
  });

  // 首屏进入时不请求；切到拼版页签后若从未加载过则立即排一次
  var panelLoaded = false;
  tabPanel.addEventListener('click', function () {
    if (!panelLoaded) { panelLoaded = true; updatePanel(); }
  });

  /* ================= 压印质检模式 ================= */

  var qcCsv = document.getElementById('qcCsv');
  var qcOffsetX = document.getElementById('qcOffsetX');
  var qcOffsetY = document.getElementById('qcOffsetY');
  var qcRotation = document.getElementById('qcRotation');
  var qcTolerance = document.getElementById('qcTolerance');
  var qcMaxRadius = document.getElementById('qcMaxRadius');
  var qcRun = document.getElementById('qcRun');
  var qcErrors = document.getElementById('qcErrors');
  var qcStats = document.getElementById('qcStats');
  var qcPreview = document.getElementById('qcPreview');
  var qcLegend = document.getElementById('qcLegend');
  var qcBaseline = document.getElementById('qcBaseline');
  var qcMaxOffsetX = document.getElementById('qcMaxOffsetX');
  var qcMaxOffsetY = document.getElementById('qcMaxOffsetY');
  var qcMaxAngle = document.getElementById('qcMaxAngle');
  var qcAngleStep = document.getElementById('qcAngleStep');
  var qcAutoCalibrate = document.getElementById('qcAutoCalibrate');
  var qcCalibMsg = document.getElementById('qcCalibMsg');
  var btnQcCsv = document.getElementById('qcDownloadCsv');
  var btnQcSvg = document.getElementById('qcDownloadSvg');
  var qcUseLayout = document.getElementById('qcUseLayout');
  var qcUsePanel = document.getElementById('qcUsePanel');

  var lastQc = null;
  var qcTimer = null;
  // 当前质检基准来源：'layout'=最近单标签排版；'panel'=最近多标签拼版
  var baselineSource = 'layout';

  function escapeHtml(s) {
    return String(s).replace(/[<>&]/g, function (c) {
      return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;';
    });
  }

  function activeBaseline() {
    return baselineSource === 'panel' ? lastPanelBaseline : lastBaseline;
  }

  // 切换基准来源：刷新按钮/基准条并清掉上一次质检结果，避免叠加图与 CSV 与新基准错配；
  // 已粘贴实测 CSV 时直接按新基准重跑
  function selectBaselineSource(source) {
    baselineSource = source;
    qcUseLayout.classList.toggle('active', source === 'layout');
    qcUsePanel.classList.toggle('active', source === 'panel');
    qcUseLayout.setAttribute('aria-pressed', String(source === 'layout'));
    qcUsePanel.setAttribute('aria-pressed', String(source === 'panel'));
    lastQc = null;
    qcStats.hidden = true;
    qcLegend.hidden = true;
    qcErrors.hidden = true;
    if (!qcCalibMsg.hidden) qcCalibMsg.hidden = true;
    btnQcCsv.disabled = true;
    btnQcSvg.disabled = true;
    qcPreview.innerHTML = '<p class="placeholder">已切换基准，点击「开始质检」查看叠加结果</p>';
    refreshBaselineBox();
    if (activeBaseline() && qcCsv.value.trim() !== '') runQc();
  }

  qcUseLayout.addEventListener('click', function () { selectBaselineSource('layout'); });
  qcUsePanel.addEventListener('click', function () { selectBaselineSource('panel'); });

  function refreshBaselineBox() {
    // 按钮可用性：单标签排版在首屏即会自动成功；拼版按钮在尚无成功拼版时禁用并提示先完成拼版
    qcUseLayout.disabled = !lastBaseline;
    qcUsePanel.disabled = !lastPanelBaseline;
    qcUseLayout.title = lastBaseline ? '以最近一次成功的单标签排版设计点为基准' : '请先在「排版模式」完成一次成功排版';
    qcUsePanel.title = lastPanelBaseline ? '以最近一次成功拼版的全局 dots 为基准' : '尚无成功拼版，请先在「多标签拼版」完成一次成功拼版';
    qcUseLayout.classList.toggle('active', baselineSource === 'layout');
    qcUsePanel.classList.toggle('active', baselineSource === 'panel');

    if (baselineSource === 'panel') {
      if (lastPanelBaseline) {
        renderPanelBaseline(lastPanelBaseline);
      } else {
        qcBaseline.className = 'baseline warn';
        qcBaseline.innerHTML = '尚无成功拼版基准：请先切换到「多标签拼版」完成一次成功拼版（拼版失败不会生成基准）。';
      }
      return;
    }
    if (lastBaseline) {
      renderLayoutBaseline(lastBaseline);
    } else {
      qcBaseline.className = 'baseline warn';
      qcBaseline.innerHTML = '尚无成功排版基准：请先切换到「排版模式」完成一次成功排版。';
    }
  }

  function renderLayoutBaseline(base) {
    var safeText = escapeHtml(base.text);
    qcBaseline.className = 'baseline ok';
    qcBaseline.innerHTML =
      '基准（<b>单标签排版</b>）：最近一次成功排版「<b>' + (safeText || '（空白标签）') + '</b>」' +
      '（' + base.dots.length + ' 个设计点，板材 ' +
      base.params.plateWidth + ' × ' + base.params.plateHeight + ' mm）<br>' +
      '<span class="muted">排版时间 ' + base.time + '</span>';
  }

  function renderPanelBaseline(base) {
    // 各标签的索引/旋转角以小圆标列出（0° 蓝 / 90° 橙），title 悬停显示标签原文
    var chips = base.labels.map(function (l) {
      var cls = l.rotation === 90 ? 'rot90' : 'rot0';
      return '<span class="label-chip ' + cls + '" title="' + escapeHtml(l.text) + '">#' +
        l.index + (l.rotation === 90 ? ' ⟳90°' : '') + '</span>';
    }).join(' ');
    qcBaseline.className = 'baseline ok';
    qcBaseline.innerHTML =
      '基准（<b>多标签拼版</b>）：最近一次成功拼版共 <b>' + base.labelCount + '</b> 条标签' +
      '（<b>' + base.rotatedCount + '</b> 条旋转 90°），展平 <b>' + base.dots.length +
      '</b> 个设计点（保留 label / rotation 元数据），板材 ' +
      base.params.plateWidth + ' × ' + base.params.plateHeight + ' mm<br>' +
      '<span class="muted">拼版时间 ' + base.time + '；各标签索引 / 旋转角：</span>' +
      '<span class="label-chips">' + chips + '</span>';
  }

  function numVal(input) {
    var v = input.value.trim();
    return v === '' ? null : Number(v);
  }

  function renderQcErrors(errors) {
    qcErrors.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      if (e.line != null) li.dataset.line = e.line;
      ul.appendChild(li);
    });
    qcErrors.appendChild(ul);
    qcErrors.hidden = false;
  }

  function renderQcStats(r) {
    var s = r.stats;
    var bl = r.baseline || {};
    var labelInfo = bl.labelCount
      ? '标签 <b>' + bl.labelCount + '</b> 条，'
      : '';
    qcStats.innerHTML =
      '通过率 <b class="rate">' + s.passRatePercent + '%</b>' +
      '（合格 <b>' + s.passCount + '</b> / 设计点 ' + s.designCount + '）　' +
      labelInfo +
      '配对 <b>' + s.matchedCount + '</b>，其中偏移超差 <b>' + s.offsetCount + '</b>；' +
      '缺失 <b>' + s.missingCount + '</b>，多余 <b>' + s.extraCount + '</b><br>' +
      '最大偏差 <b>' + (s.maxDeviation == null ? '—' : s.maxDeviation) + '</b> mm；' +
      '平均偏差 <b>' + (s.meanDeviation == null ? '—' : s.meanDeviation) + '</b> mm' +
      '（公差 ' + r.params.tolerance + ' mm，关联半径 ' + r.params.maxRadius +
      ' mm，旋转 ' + r.params.rotation + '°，偏移 ' + r.params.offsetX + ' / ' + r.params.offsetY + ' mm）';
    qcStats.hidden = false;
    qcLegend.hidden = false;
  }

  function handleQcResult(r) {
    if (r.ok) {
      lastQc = r;
      qcErrors.hidden = true;
      qcPreview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
      renderQcStats(r);
      btnQcCsv.disabled = false;
      btnQcSvg.disabled = false;
    } else {
      lastQc = null;
      qcStats.hidden = true;
      qcLegend.hidden = true;
      qcPreview.innerHTML = '<p class="placeholder">质检未能完成：请根据左侧错误修正后重试</p>';
      renderQcErrors(r.errors || [{ message: '未知错误' }]);
      btnQcCsv.disabled = true;
      btnQcSvg.disabled = true;
    }
  }

  function runQc() {
    var base = activeBaseline();
    if (!base) {
      refreshBaselineBox();
      var tip = baselineSource === 'panel'
        ? '没有成功拼版的设计点基准，请先在「多标签拼版」完成一次成功拼版。'
        : '没有成功排版的设计点基准，请先在「排版模式」完成排版。';
      renderQcErrors([{ message: tip }]);
      return;
    }
    var payload = {
      design: base.dots,
      plateWidth: base.params.plateWidth,
      plateHeight: base.params.plateHeight,
      csv: qcCsv.value,
      offsetX: numVal(qcOffsetX),
      offsetY: numVal(qcOffsetY),
      rotation: numVal(qcRotation),
      tolerance: numVal(qcTolerance),
      maxRadius: numVal(qcMaxRadius)
    };
    fetch('/api/qc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(handleQcResult)
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.QC) {
          try {
            handleQcResult(QC.inspect(payload));
          } catch (e) {
            renderQcErrors([{ message: '质检计算失败：' + e.message }]);
          }
        } else {
          renderQcErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        }
      });
  }

  qcRun.addEventListener('click', runQc);

  /* ---------- 自动校准：一键估算平移（可选小角度刚体）并写回输入框 ---------- */

  function showCalibMsg(kind, text) {
    qcCalibMsg.className = 'calib-msg ' + kind;
    qcCalibMsg.textContent = text;
    qcCalibMsg.hidden = false;
  }

  function handleCalibResult(r) {
    if (r.ok) {
      // 写回估算值（程序化赋值，不会触发 input 事件），再立即重跑四类判定
      qcOffsetX.value = r.offsetX;
      qcOffsetY.value = r.offsetY;
      if (r.rigidMode) qcRotation.value = r.rotation;
      var detail = r.rigidMode
        ? '估算小角度刚体：旋转 = ' + r.rotation + '°（围绕板材中心 ' + r.centerX + ', ' +
          r.centerY + ' mm），X = ' + r.offsetX + ' mm，Y = ' + r.offsetY +
          ' mm（角度 ' + r.angleCount + ' 个、角度×平移候选 ' + r.candidateCount +
          ' 个，匹配 ' + r.matchedCount + ' 对，总残差 ' + r.totalResidual +
          ' mm）；角度与偏移已写回并自动重跑质检。'
        : '估算全局平移：X = ' + r.offsetX + ' mm，Y = ' + r.offsetY +
          ' mm（候选 ' + r.candidateCount + ' 个，匹配 ' + r.matchedCount +
          ' 对，总残差 ' + r.totalResidual + ' mm）；偏移已写回并自动重跑质检。';
      showCalibMsg('ok', detail);
      runQc();
    } else {
      // 无可用候选 / 参数非法：保留角度与偏移输入框原值，仅给出明确提示
      var msg = (r.errors && r.errors[0] && r.errors[0].message) || '自动校准失败。';
      showCalibMsg('warn', '未能估算校准参数，角度与偏移输入保持原值：' + msg);
    }
  }

  function runAutoCalibrate() {
    var base = activeBaseline();
    if (!base) {
      refreshBaselineBox();
      var tip = baselineSource === 'panel'
        ? '没有成功拼版的设计点基准，请先在「多标签拼版」完成一次成功拼版。'
        : '没有成功排版的设计点基准，请先在「排版模式」完成排版。';
      renderQcErrors([{ message: tip }]);
      return;
    }
    var payload = {
      design: base.dots,
      plateWidth: base.params.plateWidth,
      plateHeight: base.params.plateHeight,
      csv: qcCsv.value,
      maxOffsetX: numVal(qcMaxOffsetX),
      maxOffsetY: numVal(qcMaxOffsetY),
      maxRadius: numVal(qcMaxRadius)
    };
    // 最大旋转角填正数时启用「角度 × 平移」联合搜索；留空/0 时不传角度参数，
    // 走与旧版完全一致的纯平移估算（API 亦兼容不传角度的调用）
    var maxAngle = numVal(qcMaxAngle);
    var angleStep = numVal(qcAngleStep);
    if (maxAngle != null && maxAngle > 0) {
      payload.maxAngle = maxAngle;
      payload.angleStep = angleStep;
    }
    qcAutoCalibrate.disabled = true;
    fetch('/api/qc/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) { handleCalibResult(r); })
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.QC) {
          try {
            handleCalibResult(QC.estimateCalibration(payload));
          } catch (e) {
            showCalibMsg('warn', '自动校准计算失败：' + e.message);
          }
        } else {
          showCalibMsg('warn', '网络请求失败，请确认服务已启动；偏移输入保持原值。');
        }
      })
      .finally(function () { qcAutoCalibrate.disabled = false; });
  }

  qcAutoCalibrate.addEventListener('click', runAutoCalibrate);

  // 参数或 CSV 修改后防抖自动重跑（已有质检结果时），手动按钮始终可用；
  // 输入一旦被改动，清掉上一次自动校准的提示
  [qcCsv, qcOffsetX, qcOffsetY, qcRotation, qcTolerance, qcMaxRadius,
   qcMaxOffsetX, qcMaxOffsetY, qcMaxAngle, qcAngleStep].forEach(function (el) {
    el.addEventListener('input', function () {
      if (!qcCalibMsg.hidden) qcCalibMsg.hidden = true;
      if (!lastQc) return;
      clearTimeout(qcTimer);
      qcTimer = setTimeout(runQc, 300);
    });
  });

  btnQcCsv.addEventListener('click', function () {
    if (lastQc) download('embossing-qc-report.csv', 'text/csv;charset=utf-8', lastQc.csv);
  });
  btnQcSvg.addEventListener('click', function () {
    if (lastQc) download('embossing-qc-overlay.svg', 'image/svg+xml;charset=utf-8', lastQc.svg);
  });

  /* ================= 压印路径（单标签 + 拼版共用） ================= */

  // 两个页签各有一套压印路径控件；此工厂封装与“最近成功结果”绑定的全部行为
  function createPathTool(opts) {
    var startXEl = document.getElementById(opts.startXId);
    var startYEl = document.getElementById(opts.startYId);
    var genBtn = document.getElementById(opts.genId);
    var csvBtn = document.getElementById(opts.csvId);
    var errBox = document.getElementById(opts.errId);
    var statBox = document.getElementById(opts.statId);
    var previewWrap = document.getElementById(opts.wrapId);
    var previewBox = document.getElementById(opts.previewId);

    var timer = null;
    var lastPath = null; // 最近一次成功路径（用于下载 CSV）

    function renderErrors(errors) {
      errBox.innerHTML = '';
      var ul = document.createElement('ul');
      errors.forEach(function (e) {
        var li = document.createElement('li');
        li.textContent = e.message;
        ul.appendChild(li);
      });
      errBox.appendChild(ul);
      errBox.hidden = false;
    }

    function renderStats(r) {
      var s = r.stats;
      var labelInfo = s.labelCount > 0 ? '覆盖 <b>' + s.labelCount + '</b> 个标签、' : '';
      statBox.innerHTML =
        '共 <b>' + s.pointCount + '</b> 个凸点，' + labelInfo +
        '优化前空移 <b>' + s.nnTravelMm + '</b> mm → 优化后 <b>' + s.optTravelMm +
        '</b> mm（2-opt 执行 <b>' + s.roundsRun + '</b>/' + s.maxRounds + ' 轮）<br>' +
        '节省 <b class="saved">' + s.savedMm + '</b> mm，节省比例 <b class="saved">' +
        s.savedPercent + '%</b>';
      statBox.hidden = false;
    }

    // 重新排版/拼版后旧路径立即失效：清空预览与下载，等用户重新生成
    function invalidate(placeholder) {
      lastPath = null;
      clearTimeout(timer);
      csvBtn.disabled = true;
      statBox.hidden = true;
      errBox.hidden = true;
      previewWrap.hidden = true;
      previewBox.innerHTML = '<p class="placeholder">' + placeholder + '</p>';
    }

    function handleResult(r) {
      if (r.ok) {
        lastPath = r;
        errBox.hidden = true;
        previewWrap.hidden = false;
        previewBox.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
        renderStats(r);
        csvBtn.disabled = false;
      } else {
        lastPath = null;
        statBox.hidden = true;
        csvBtn.disabled = true;
        previewWrap.hidden = true;
        renderErrors(r.errors || [{ message: '未知错误' }]);
      }
    }

    function run() {
      var src = opts.source();
      if (!src || !src.dots || !src.dots.length) {
        handleResult({ ok: false, errors: [{ message: '请先完成一次成功的排版/拼版，再生成压印路径。' }] });
        return;
      }
      var sx = startXEl.value.trim();
      var sy = startYEl.value.trim();
      if (sx === '' || sy === '' || !isFinite(Number(sx)) || !isFinite(Number(sy))) {
        handleResult({ ok: false, errors: [{ message: '起点 X / Y 坐标必须填写为数字（mm）。' }] });
        return;
      }
      var payload = {
        dots: src.dots,
        startX: Number(sx),
        startY: Number(sy),
        plateWidth: src.plateWidth,
        plateHeight: src.plateHeight
      };
      fetch('/api/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) { return res.json(); })
        .then(handleResult)
        .catch(function () {
          // 服务不可用时回退到浏览器内置同构实现
          if (window.EmbossPath) {
            try {
              handleResult(EmbossPath.planPath(payload));
            } catch (e) {
              handleResult({ ok: false, errors: [{ message: '压印路径计算失败：' + e.message }] });
            }
          } else {
            handleResult({ ok: false, errors: [{ message: '网络请求失败，请确认服务已启动。' }] });
          }
        });
    }

    genBtn.addEventListener('click', run);
    csvBtn.addEventListener('click', function () {
      if (lastPath) download(opts.csvName, 'text/csv;charset=utf-8', lastPath.csv);
    });
    // 修改起点且已有路径结果时防抖重算；尚未生成过时不自动请求
    [startXEl, startYEl].forEach(function (el) {
      el.addEventListener('input', function () {
        if (!lastPath) return;
        clearTimeout(timer);
        timer = setTimeout(run, 300);
      });
    });

    return { invalidate: invalidate, run: run };
  }

  // 单标签排版页签：数据来源为最近一次成功排版
  var layoutPathTool = createPathTool({
    startXId: 'pathStartX', startYId: 'pathStartY',
    genId: 'pathGenerate', csvId: 'pathDownloadCsv',
    errId: 'pathErrors', statId: 'pathStats',
    wrapId: 'pathPreviewWrap', previewId: 'pathPreview',
    csvName: 'embossing-path.csv',
    source: function () {
      return lastResult ? {
        dots: lastResult.dots,
        plateWidth: lastResult.params.plateWidth,
        plateHeight: lastResult.params.plateHeight
      } : null;
    }
  });

  // 多标签拼版页签：数据来源为最近一次成功拼版（dots 含 label 元数据）
  var panelPathTool = createPathTool({
    startXId: 'panelPathStartX', startYId: 'panelPathStartY',
    genId: 'panelPathGenerate', csvId: 'panelPathDownloadCsv',
    errId: 'panelPathErrors', statId: 'panelPathStats',
    wrapId: 'panelPathPreviewWrap', previewId: 'panelPathPreview',
    csvName: 'embossing-panel-path.csv',
    source: function () {
      return lastPanel ? {
        dots: lastPanel.dots,
        plateWidth: lastPanel.params.plateWidth,
        plateHeight: lastPanel.params.plateHeight
      } : null;
    }
  });

  // 排版结果变化时使旧路径失效（成功 -> 等待重新生成；失败 -> 同样清空）
  function invalidateLayoutPath() {
    layoutPathTool.invalidate('排版参数已变化，请重新点击「生成压印路径」');
  }
  function invalidatePanelPath() {
    panelPathTool.invalidate('拼版参数已变化，请重新点击「生成压印路径」');
  }

  /* ================= 拼版裁切线 ================= */

  var cutMarginEl = document.getElementById('panelCutMargin');
  var cutToolRadiusEl = document.getElementById('panelCutToolRadius');
  var cutGenBtn = document.getElementById('panelCutGenerate');
  var cutMaxBtn = document.getElementById('panelCutMax');
  var cutCsvBtn = document.getElementById('panelCutDownloadCsv');
  var cutSvgBtn = document.getElementById('panelCutDownloadSvg');
  var cutErrorsBox = document.getElementById('panelCutErrors');
  var cutStatsBox = document.getElementById('panelCutStats');
  var cutPreviewWrap = document.getElementById('panelCutPreviewWrap');
  var cutPreviewBox = document.getElementById('panelCutPreview');

  var lastCut = null;   // 最近一次成功裁切线结果（用于下载）
  var cutProbe = null;  // 最近一次响应（成功或超限失败都可能带 maxMargin，供「取最大留边」）
  var cutTimer = null;

  function renderCutErrors(errors) {
    cutErrorsBox.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      if (e.binding) li.className = 'cut-binding';
      ul.appendChild(li);
    });
    cutErrorsBox.appendChild(ul);
    cutErrorsBox.hidden = false;
  }

  function renderCutStats(r) {
    var s = r.stats;
    var b = r.binding || {};
    var bindingText = b.kind === 'plate'
      ? '板边（标签 #' + b.label + ' 的' +
        ({ left: '左', right: '右', top: '上', bottom: '下' }[b.side] || b.side) + '板边）'
      : '标签对（#' + b.labelA + ' ↔ #' + b.labelB + '，' +
        (b.axis === 'x' ? '水平' : '竖直') + '分离轴）';
    cutStatsBox.innerHTML =
      '共 <b>' + s.labelCount + '</b> 条标签；输入最小留边 <b>' + s.minMargin +
      '</b> mm、刀具半径 <b>' + s.toolRadius + '</b> mm<br>' +
      '整版允许的最大统一留边 <b class="cut-maxmargin">' + s.maxMargin + '</b> mm' +
      '（最紧约束来自' + bindingText + '，' + s.bindingCount + ' 条约束同时贴线）；' +
      '当前余量 <b class="saved">' + s.slack + '</b> mm（板边约束 ' +
      s.plateConstraints + ' 条、标签对约束 ' + s.pairConstraints + ' 条）';
    cutStatsBox.hidden = false;
  }

  function handleCutResult(r) {
    cutProbe = r;
    if (r.ok) {
      lastCut = r;
      cutErrorsBox.hidden = true;
      cutPreviewWrap.hidden = false;
      cutPreviewBox.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
      renderCutStats(r);
      cutCsvBtn.disabled = false;
      cutSvgBtn.disabled = false;
      cutMaxBtn.disabled = !(r.maxMargin >= 0);
    } else {
      lastCut = null;
      cutStatsBox.hidden = true;
      cutCsvBtn.disabled = true;
      cutSvgBtn.disabled = true;
      cutPreviewWrap.hidden = true;
      // 参数非法时 maxMargin 可能为 null；超限失败时仍展示“最大留边”数值供用户参考
      cutMaxBtn.disabled = !(r.maxMargin >= 0);
      renderCutErrors(r.errors || [{ message: '未知错误' }]);
    }
  }

  function runCut() {
    if (!lastPanel || !lastPanel.ok || !lastPanel.labels || !lastPanel.labels.length) {
      handleCutResult({ ok: false, errors: [{ message: '请先完成一次成功的多标签拼版，再生成裁切线。' }] });
      return;
    }
    var mv = cutMarginEl.value.trim();
    var rv = cutToolRadiusEl.value.trim();
    if (mv === '' || !isFinite(Number(mv)) || Number(mv) < 0) {
      handleCutResult({ ok: false, errors: [{ message: '最小留边必须填写为不小于 0 的数字（mm）。' }] });
      return;
    }
    if (rv === '' || !isFinite(Number(rv)) || Number(rv) < 0) {
      handleCutResult({ ok: false, errors: [{ message: '刀具半径必须填写为不小于 0 的数字（mm）。' }] });
      return;
    }
    var payload = {
      labels: lastPanel.labels,
      dots: lastPanel.dots,
      plateWidth: lastPanel.params.plateWidth,
      plateHeight: lastPanel.params.plateHeight,
      minMargin: Number(mv),
      toolRadius: Number(rv)
    };
    fetch('/api/panel/cut', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.PanelCut) {
          try {
            return PanelCut.planCuts(payload);
          } catch (e) {
            return { ok: false, errors: [{ message: '裁切线计算失败：' + e.message }] };
          }
        }
        return { ok: false, errors: [{ message: '网络请求失败，请确认服务已启动。' }] };
      })
      .then(handleCutResult);
  }

  // 拼版结果变化时旧裁切线立即失效，等待用户重新生成（避免刀路与新拼版错位）
  function invalidatePanelCut() {
    lastCut = null;
    cutProbe = null;
    clearTimeout(cutTimer);
    cutCsvBtn.disabled = true;
    cutSvgBtn.disabled = true;
    cutMaxBtn.disabled = true;
    cutStatsBox.hidden = true;
    cutErrorsBox.hidden = true;
    cutPreviewWrap.hidden = true;
    cutPreviewBox.innerHTML = '<p class="placeholder">拼版参数已变化，请重新点击「生成裁切线」</p>';
  }

  cutGenBtn.addEventListener('click', runCut);
  cutMaxBtn.addEventListener('click', function () {
    // 取最近一次响应（成功或超限失败都带 maxMargin）中的最大统一留边，重算一次
    if (!cutProbe || cutProbe.maxMargin == null) {
      runCut(); // 尚未生成过时先用当前参数跑一次以取得 maxMargin
      return;
    }
    if (cutProbe.maxMargin >= 0) {
      cutMarginEl.value = cutProbe.maxMargin;
      runCut();
    }
  });
  cutCsvBtn.addEventListener('click', function () {
    if (lastCut) download('panel-cut-lines.csv', 'text/csv;charset=utf-8', lastCut.csv);
  });
  cutSvgBtn.addEventListener('click', function () {
    if (lastCut) download('panel-cut-lines.svg', 'image/svg+xml;charset=utf-8', lastCut.svg);
  });
  // 修改留边/刀具半径且已有裁切线结果时防抖重算
  [cutMarginEl, cutToolRadiusEl].forEach(function (el) {
    el.addEventListener('input', function () {
      if (!lastCut && cutErrorsBox.hidden) return;
      clearTimeout(cutTimer);
      cutTimer = setTimeout(runCut, 300);
    });
  });

  /* ================= 点阵解码模式 ================= */

  var decodeInput = document.getElementById('decodeInput');
  var decodeOutput = document.getElementById('decodeOutput');
  var decodeErrorsBox = document.getElementById('decodeErrors');
  var decodeStatsBox = document.getElementById('decodeStats');
  var decodeCellsBox = document.getElementById('decodeCells');
  var decodeCount = document.getElementById('decodeCount');
  var btnDecodeCopy = document.getElementById('decodeCopy');
  var btnDecodeClear = document.getElementById('decodeClear');
  var decodeCopyMsg = document.getElementById('decodeCopyMsg');

  var decodeResult = null; // 最近一次解码结果（复制 / 定位用）
  var decodeTimer = null;
  var decodeLoaded = false;

  var DECODE_KIND_LABEL = {
    'letter': '字母', 'digit': '数字', 'punct': '标点',
    'caps-prefix': '大写前缀', 'number-prefix': '数字前缀',
    'space': '空白', 'unknown': '未知'
  };

  // 把焦点与选区移到输入中第 position 个字符（UTF-16 偏移，与服务端定位一致）
  function locateInInput(position, length) {
    setMode('decode');
    decodeInput.focus();
    var end = position + (length || 1);
    try {
      decodeInput.setSelectionRange(position, end);
    } catch (e) { /* 个别旧浏览器不支持 setSelectionRange 时仅聚焦 */ }
  }

  function showDecodeCopyMsg(text) {
    decodeCopyMsg.textContent = text;
    decodeCopyMsg.hidden = false;
    clearTimeout(showDecodeCopyMsg._t);
    showDecodeCopyMsg._t = setTimeout(function () { decodeCopyMsg.hidden = true; }, 2500);
  }

  function escapeDecodeHtml(s) {
    return String(s).replace(/[<>&"]/g, function (c) {
      return c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;';
    });
  }

  function renderDecodeErrors(r) {
    decodeErrorsBox.innerHTML = '';
    if (!r.errors || !r.errors.length) {
      decodeErrorsBox.hidden = true;
      return;
    }
    var ul = document.createElement('ul');
    r.errors.forEach(function (e, i) {
      var li = document.createElement('li');
      var pos = e.position != null ? e.position : 0;
      var len = e.length || 1;
      li.textContent = e.message;
      li.dataset.position = String(pos);
      li.title = '点击定位到输入位置 ' + pos;
      li.addEventListener('click', function () { locateInInput(pos, len); });
      ul.appendChild(li);
    });
    decodeErrorsBox.appendChild(ul);
    decodeErrorsBox.hidden = false;
  }

  function renderDecodeStats(r) {
    var counts = {};
    r.cells.forEach(function (c) { counts[c.kind] = (counts[c.kind] || 0) + 1; });
    if (!r.cells.length) {
      decodeStatsBox.hidden = true;
      return;
    }
    decodeStatsBox.innerHTML =
      '共 <b>' + r.cells.length + '</b> 个单元：字母 <b>' + (counts.letter || 0) +
      '</b>（含大写 <b>' + r.cells.filter(function (c) { return c.uppercase; }).length +
      '</b>）、数字 <b>' + (counts.digit || 0) + '</b>、标点 <b>' + (counts.punct || 0) +
      '</b>、空白 <b>' + (counts.space || 0) + '</b>、前缀 <b>' +
      ((counts['caps-prefix'] || 0) + (counts['number-prefix'] || 0)) +
      '</b>；未知 / 悬空前缀 <b class="' + (r.errors.length ? 'decode-warn' : '') + '">' +
      r.errors.length + '</b> 个，未知字符均已原样保留';
    decodeStatsBox.hidden = false;
  }

  // 单元对照：每格显示盲文原字、点号与还原字符，错误格标红并可点击定位
  function renderDecodeCells(r) {
    decodeCellsBox.innerHTML = '';
    if (!r.cells.length) {
      decodeCellsBox.innerHTML = '<p class="placeholder">粘贴六点盲文后，此处按单元显示点号、类型与还原字符</p>';
      return;
    }
    r.cells.forEach(function (c) {
      var chip = document.createElement('span');
      chip.className = 'decode-cell' + (c.error ? ' is-error' : '') +
        (c.kind === 'caps-prefix' || c.kind === 'number-prefix' ? ' is-prefix' : '');
      var shown = c.kind === 'space'
        ? (c.braille === '⠀' ? '␠' : '␣')
        : (c.kind === 'unknown' ? c.char : c.braille);
      var label = c.kind === 'space' ? '空白' : DECODE_KIND_LABEL[c.kind] || c.kind;
      var decoded = c.kind === 'caps-prefix' || c.kind === 'number-prefix'
        ? '（前缀，不占还原字符）'
        : (c.kind === 'space' ? '→ 空白' : '→ “' + (c.char === '\n' ? '↵' : c.char) + '”');
      chip.innerHTML =
        '<span class="dc-glyph">' + escapeDecodeHtml(shown) + '</span>' +
        '<span class="dc-meta">' + label + '　点 ' + (c.dots.length ? c.dots.join('·') : '—') + '</span>' +
        '<span class="dc-out">' + escapeDecodeHtml(decoded) + '</span>';
      chip.title = '第 ' + (c.index + 1) + ' 个单元（输入位置 ' + c.position + '）' +
        (c.error ? '：' + (r.errors.find(function (e) { return e.index === c.index; }) || {}).message || '' : '') +
        '　点击在输入框定位';
      chip.addEventListener('click', function () { locateInInput(c.position, 1); });
      decodeCellsBox.appendChild(chip);
    });
  }

  function handleDecodeResult(r) {
    decodeResult = r;
    decodeOutput.value = r.decodedText;
    btnDecodeCopy.disabled = r.decodedText.length === 0;
    decodeCount.textContent = r.cells.length + ' 个单元 · ' + r.decodedText.length + ' 个还原字符';
    renderDecodeErrors(r);
    renderDecodeStats(r);
    renderDecodeCells(r);
  }

  function runDecode() {
    var text = decodeInput.value;
    fetch('/api/decode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    })
      .then(function (res) { return res.json(); })
      .then(handleDecodeResult)
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现（lib/braille.js 已在页面加载）
        if (window.Braille) {
          try {
            handleDecodeResult(Braille.decodeBraille(text));
          } catch (e) {
            renderDecodeErrors([{ message: '点阵解码计算失败：' + e.message }]);
          }
        } else {
          renderDecodeErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        }
      });
  }

  function scheduleDecode() {
    clearTimeout(decodeTimer);
    decodeTimer = setTimeout(runDecode, 200);
  }

  function ensureDecodeLoaded() {
    if (!decodeLoaded) {
      decodeLoaded = true;
      // 示例：与排版默认标签 EXIT Door 2 的盲文一致，便于与排版结果对照
      decodeInput.value = '⠠⠑⠠⠭⠠⠊⠠⠞⠀⠠⠙⠕⠕⠗⠀⠼⠃';
      runDecode();
    }
  }

  decodeInput.addEventListener('input', scheduleDecode);

  btnDecodeClear.addEventListener('click', function () {
    decodeInput.value = '';
    decodeResult = null;
    decodeOutput.value = '';
    decodeCount.textContent = '';
    decodeErrorsBox.hidden = true;
    decodeStatsBox.hidden = true;
    decodeCopyMsg.hidden = true;
    btnDecodeCopy.disabled = true;
    decodeCellsBox.innerHTML = '<p class="placeholder">粘贴六点盲文后，此处按单元显示点号、类型与还原字符</p>';
    decodeInput.focus();
  });

  btnDecodeCopy.addEventListener('click', function () {
    if (!decodeResult) return;
    var text = decodeResult.decodedText;
    function fallbackCopy() {
      decodeOutput.removeAttribute('readonly');
      decodeOutput.focus();
      decodeOutput.select();
      try { document.execCommand('copy'); } catch (e) {}
      decodeOutput.setAttribute('readonly', '');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showDecodeCopyMsg('已复制解码结果（' + text.length + ' 字符）到剪贴板。'); },
        function () { fallbackCopy(); showDecodeCopyMsg('已复制解码结果到剪贴板。'); }
      );
    } else {
      fallbackCopy();
      showDecodeCopyMsg('已复制解码结果到剪贴板。');
    }
  });

  /* ================= 启动 ================= */

  update(); // 首屏立即排版
})();
