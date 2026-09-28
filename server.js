/*
 * 盲文标签排版台 —— Express 服务端
 * 提供静态页面与 API：
 *   POST /api/layout         单标签排版
 *   POST /api/decode         点阵解码（六点盲文 Unicode -> 英文/大小写前缀/连续数字段）
 *   POST /api/panel          多标签拼版（逐条复用单标签盲文转换 + 二维行级装箱）
 *   POST /api/qc             压印质检
 *   POST /api/qc/calibrate   质检自动校准
 *   POST /api/path           压印路径（最近邻 + 2-opt，输出逐点作业顺序 / CSV / 叠加 SVG）
 *   POST /api/panel/cut      拼版裁切线（包络 -> 成品边 -> 刀心线；最大统一留边校验 / CSV / 叠加 SVG）
 */
'use strict';

const path = require('path');
const express = require('express');
const Braille = require('./lib/braille');
const QC = require('./lib/qc');
const Panel = require('./lib/panel');
const EmbossPath = require('./lib/path');
const PanelCut = require('./lib/cut');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 浏览器端直接复用同一套核心库（排版/拼版/质检），保证前后端逻辑一致
app.use('/lib', express.static(path.join(__dirname, 'lib')));

// 排版接口：输入标签文本与板材/点距/行距等参数，返回排版结果或放不下原因
app.post('/api/layout', (req, res) => {
  const body = req.body || {};
  const result = Braille.layout({
    text: body.text,
    plateWidth: body.plateWidth,
    plateHeight: body.plateHeight,
    dotSpacing: body.dotSpacing,
    lineSpacing: body.lineSpacing,
    margin: body.margin,
    cellGap: body.cellGap,
    dotDiameter: body.dotDiameter
  });
  res.json(result);
});

// 点阵解码接口：粘贴六点盲文 Unicode 字符串，按现有字符表反向还原英文、
// 大写前缀与连续数字段，保留空白和标点；未知字符逐个返回位置/码点/原因，
// decodedText 中原样保留未知字符，绝不静默丢弃
app.post('/api/decode', (req, res) => {
  const body = req.body || {};
  const result = Braille.decodeBraille(body.text);
  res.json(result);
});

// 多标签拼版接口：labels 为字符串（每行一条）或字符串数组，
// 共享板材/点距/行距/边距/标签间距；任一标签放不下时返回逐条原因且不输出部分版面
app.post('/api/panel', (req, res) => {
  const body = req.body || {};
  const result = Panel.packLabels({
    labels: body.labels,
    plateWidth: body.plateWidth,
    plateHeight: body.plateHeight,
    dotSpacing: body.dotSpacing,
    lineSpacing: body.lineSpacing,
    margin: body.margin,
    labelGap: body.labelGap,
    cellGap: body.cellGap,
    dotDiameter: body.dotDiameter
  });
  res.json(result);
});

// 压印质检接口：以成功排版的设计点为基准，对实测凸点 CSV 做小角度刚体校准/偏移/匹配/判定
app.post('/api/qc', (req, res) => {
  const body = req.body || {};
  const result = QC.inspect({
    design: body.design,
    csv: body.csv,
    offsetX: body.offsetX,
    offsetY: body.offsetY,
    rotation: body.rotation,
    tolerance: body.tolerance,
    maxRadius: body.maxRadius,
    plateWidth: body.plateWidth,
    plateHeight: body.plateHeight
  });
  res.json(result);
});

// 自动校准：粘贴无序实测点 + X/Y 最大校准量，一键估算全局平移；
// 另可选传 maxAngle/angleStep（度）启用小角度刚体校准（角度 × 平移联合搜索）。
// 不传角度参数时完全兼容旧的纯平移调用。
app.post('/api/qc/calibrate', (req, res) => {
  const body = req.body || {};
  const result = QC.estimateCalibration({
    design: body.design,
    csv: body.csv,
    maxOffsetX: body.maxOffsetX,
    maxOffsetY: body.maxOffsetY,
    maxRadius: body.maxRadius,
    maxAngle: body.maxAngle,
    angleStep: body.angleStep,
    plateWidth: body.plateWidth,
    plateHeight: body.plateHeight
  });
  res.json(result);
});

// 健康检查（容器编排用）
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'braille-label-studio', time: new Date().toISOString() });
});

// 压印路径接口：以最近一次成功排版/拼版的 dots 为输入，从用户指定起点出发，
// 最近邻生成初始路线后执行最多 20 轮 2-opt，返回逐点作业顺序、优化前后空移统计、
// 叠加 SVG（带 step 序号与方向箭头）与可下载 CSV；点数超 2000 或参数非法时只报错
app.post('/api/path', (req, res) => {
  const body = req.body || {};
  const result = EmbossPath.planPath({
    dots: body.dots,
    startX: body.startX,
    startY: body.startY,
    plateWidth: body.plateWidth,
    plateHeight: body.plateHeight
  });
  res.json(result);
});

// 拼版裁切线接口：复用成功拼版每条标签的全局凸点/编号与板材尺寸，
// 输入最小留边与刀具半径，按“凸点包络 -> 外扩留边成品边 -> 外扩刀具半径刀心线”
// 计算各标签矩形（旋转标签同样按全局坐标）；同时给出整版允许的最大统一留边，
// 输入留边超限时逐条指出限制它的板边/标签对，不输出部分刀路；
// 可行时返回叠加 SVG（含标签编号与四角毫米坐标）与可下载 CSV
app.post('/api/panel/cut', (req, res) => {
  const body = req.body || {};
  const result = PanelCut.planCuts({
    labels: body.labels,
    dots: body.dots,
    plateWidth: body.plateWidth,
    plateHeight: body.plateHeight,
    minMargin: body.minMargin,
    toolRadius: body.toolRadius
  });
  res.json(result);
});

// 未匹配 API 返回 404 JSON
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, errors: [{ type: 'not-found', message: '接口不存在' }] });
});

// 统一错误处理（含 JSON 解析失败）
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, errors: [{ type: 'bad-json', message: '请求体不是合法 JSON' }] });
  }
  console.error(err);
  res.status(500).json({ ok: false, errors: [{ type: 'server', message: '服务器内部错误' }] });
});

// 仅在直接运行（node server.js）时监听端口；被测试 require 时只导出 app
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`盲文标签排版台已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
