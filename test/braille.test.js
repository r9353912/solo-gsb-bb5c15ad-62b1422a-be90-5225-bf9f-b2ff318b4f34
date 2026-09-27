'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Braille = require('../lib/braille');

/* ---------- 一级盲文转换 ---------- */

test('小写字母直接转换，无前缀', () => {
  const { cells, errors } = Braille.textToCells('abc');
  assert.equal(errors.length, 0);
  assert.deepEqual(cells.map(c => c.dots), [[1], [1, 2], [1, 4]]);
  assert.deepEqual(cells.map(c => c.kind), ['letter', 'letter', 'letter']);
});

test('每个大写字母前加大写前缀（点6）', () => {
  const { cells } = Braille.textToCells('Ab');
  assert.equal(cells.length, 3);
  assert.deepEqual(cells[0].dots, [6]);
  assert.equal(cells[0].kind, 'caps-prefix');
  assert.deepEqual(cells[1].dots, [1]);   // a
  assert.deepEqual(cells[2].dots, [1, 2]); // b
});

test('连续数字段只加一个数字前缀，字母结束数字段', () => {
  const { cells } = Braille.textToCells('123a45');
  const kinds = cells.map(c => c.kind);
  assert.deepEqual(kinds, [
    'number-prefix', 'digit', 'digit', 'digit',
    'letter',
    'number-prefix', 'digit', 'digit'
  ]);
  // 数字 1,2,3 -> a,b,c 点位
  assert.deepEqual(cells[1].dots, [1]);
  assert.deepEqual(cells[2].dots, [1, 2]);
  assert.deepEqual(cells[3].dots, [1, 4]);
});

test('数字段中的小数点/逗号不中断数字模式', () => {
  const { cells } = Braille.textToCells('3.14');
  const kinds = cells.map(c => c.kind);
  assert.deepEqual(kinds, ['number-prefix', 'digit', 'punct', 'digit', 'digit']);
});

test('不支持的字符被报告并忽略', () => {
  const { cells, errors } = Braille.textToCells('a中b');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'unsupported-char');
  assert.equal(cells.filter(c => c.kind === 'letter').length, 2);
});

test('盲文 Unicode 码位正确', () => {
  assert.equal(Braille.dotsToUnicode([1]), '⠁');
  assert.equal(Braille.dotsToUnicode([3, 4, 5, 6]), '⠼');
  assert.equal(Braille.dotsToUnicode([6]), '⠠');
});

/* ---------- 排版与换行 ---------- */

const FIT_ALL = { plateWidth: 100, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10, margin: 5 };

test('正常排版：容量、坐标与 SVG', () => {
  const r = Braille.layout({ text: 'ab', ...FIT_ALL });
  assert.equal(r.ok, true);
  // 有效宽 90mm：cellsPerLine = floor((90-2.5)/6)+1 = 15；有效高 40mm：maxLines = floor((40-5)/10)+1 = 4
  assert.equal(r.cellsPerLine, 15);
  assert.equal(r.maxLines, 4);
  assert.equal(r.stats.totalLines, 1);
  // a 的点1 在 (5,5)；b 的点1 在 (5+6,5)，点2 在 (11,7.5)
  const d = r.dots;
  assert.deepEqual([d[0].x, d[0].y], [5, 5]);
  const bDot2 = d.find(x => x.cell === 2 && x.dot === 2);
  assert.deepEqual([bDot2.x, bDot2.y], [11, 7.5]);
  assert.match(r.svg, /^<\?xml/);
  assert.match(r.svg, /width="100mm"/);
  assert.match(r.svg, /<circle /);
});

test('整词换行：词不可拆分，空格占一个单元', () => {
  // 每行 4 个单元：ab(2) + 空格(1) + cd(2) = 5 > 4，故 cd 移到第二行
  const r = Braille.layout({ text: 'ab cd', plateWidth: 30.9, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10, margin: 5 });
  // cellsPerLine = floor((20.9-2.5)/6)+1 = 4
  assert.equal(r.cellsPerLine, 4);
  assert.equal(r.ok, true);
  assert.equal(r.stats.totalLines, 2);
  assert.equal(r.lines[0].map(c => c.char).join(''), 'ab');
  assert.equal(r.lines[1].map(c => c.char).join(''), 'cd');
});

test('单词超长：报出原因且不输出排版结果（不裁切）', () => {
  const r = Braille.layout({ text: 'abcdefgh', plateWidth: 30.9, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10, margin: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.svg, null);
  assert.equal(r.dots.length, 0);
  const err = r.errors.find(e => e.type === 'word-too-long');
  assert.ok(err, '应有 word-too-long 错误');
  assert.match(err.message, /abcdefgh/);
  assert.match(err.message, /8 个盲文单元/);
});

test('总行数超容：报出原因且不裁切', () => {
  const r = Braille.layout({ text: 'a b c d e f', plateWidth: 30.9, plateHeight: 20, dotSpacing: 2.5, lineSpacing: 10, margin: 5 });
  // maxLines = floor((10-5)/10)+1 = 1，6 个单词各 1 单元 -> 需 3 行
  assert.equal(r.ok, false);
  const err = r.errors.find(e => e.type === 'too-many-lines');
  assert.ok(err, '应有 too-many-lines 错误');
  assert.match(err.message, /共需 3 行/);
  assert.equal(r.svg, null);
});

test('行距小于单元高度被拒绝', () => {
  const r = Braille.layout({ text: 'a', plateWidth: 100, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 4 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /行距/.test(e.message)));
});

test('非法参数被拒绝', () => {
  const r = Braille.layout({ text: 'a', plateWidth: -1, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('空文本：合法空排版', () => {
  const r = Braille.layout({ text: '   ', ...FIT_ALL });
  assert.equal(r.ok, true);
  assert.equal(r.stats.totalLines, 0);
  assert.equal(r.dots.length, 0);
});

/* ---------- 点阵解码（盲文 -> 文本） ---------- */

test('解码：小写字母、空白与标点直接还原', () => {
  const braille = Braille.textToCells('abc, hi!').cells.map(c => c.braille).join('');
  const r = Braille.decodeBraille(braille);
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, 'abc, hi!');
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.cells.filter(c => c.kind === 'letter').map(c => c.char), ['a', 'b', 'c', 'h', 'i']);
});

test('解码：大写前缀还原大写字母，前缀单元不占输出字符', () => {
  const braille = Braille.textToCells('AbC').cells.map(c => c.braille).join('');
  const r = Braille.decodeBraille(braille);
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, 'AbC');
  assert.deepEqual(r.cells.filter(c => c.kind === 'caps-prefix').length, 2);
  const letters = r.cells.filter(c => c.kind === 'letter');
  assert.deepEqual(letters.map(c => [c.char, c.uppercase]), [['A', true], ['b', false], ['C', true]]);
});

test('解码：连续数字段还原，段首数字前缀不占输出字符；k-z 字母结束数字段', () => {
  const braille = Braille.textToCells('123k45').cells.map(c => c.braille).join('');
  const r = Braille.decodeBraille(braille);
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, '123k45');
  assert.equal(r.cells.filter(c => c.kind === 'number-prefix').length, 2);
  assert.deepEqual(r.cells.filter(c => c.kind === 'digit').map(c => c.char), ['1', '2', '3', '4', '5']);
  assert.deepEqual(r.cells.filter(c => c.kind === 'letter').map(c => c.char), ['k']);
});

test('解码：一级盲文 a-j 字母与数字同点位，数字段后紧跟 a-j 按连续数字段还原（码表本身无字母符）', () => {
  // 正向编码对 '1b' 与 '12' 输出完全相同（⠼⠁⠃），反向按“连续数字段”约定还原为 12
  assert.equal(Braille.textToCells('1b').cells.map(c => c.braille).join(''),
    Braille.textToCells('12').cells.map(c => c.braille).join(''));
  const r = Braille.decodeBraille(Braille.textToCells('1b').cells.map(c => c.braille).join(''));
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, '12');
});

test('解码：数字段中的小数点/逗号仍属同一数字段', () => {
  const braille = Braille.textToCells('3.14 1,000').cells.map(c => c.braille).join('');
  const r = Braille.decodeBraille(braille);
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, '3.14 1,000');
});

test('解码：换行与普通空白原样保留；盲文空白单元 U+2800 还原为空格', () => {
  const r = Braille.decodeBraille('⠁\n⠃\t⠀⠉');
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, 'a\nb\t c');
  const kinds = r.cells.map(c => c.kind);
  assert.deepEqual(kinds, ['letter', 'space', 'letter', 'space', 'space', 'letter']);
});

test('解码：正向往返一致（含 # 与数字前缀同点位的上下文消歧）', () => {
  ['EXIT Door 2', '1#2 a#2', 'A1 B2 C3', 'PUSH 3.14, OK!'].forEach(text => {
    const braille = Braille.textToCells(text).cells.map(c => c.braille).join('');
    const r = Braille.decodeBraille(braille);
    assert.equal(r.decodedText, text, '往返失败: ' + text);
  });
});

test('解码：非盲文字符逐个报错，给出位置、码点与原因且原样保留', () => {
  const r = Braille.decodeBraille('a中⠿b');
  assert.equal(r.ok, false);
  assert.equal(r.decodedText, 'a中⠿b'); // 未知字符原样保留，未静默丢弃
  assert.equal(r.errors.length, 4);
  assert.deepEqual(r.errors.map(e => e.type),
    ['unknown-char', 'unknown-char', 'unknown-pattern', 'unknown-char']);
  assert.equal(r.errors[0].position, 0);
  assert.equal(r.errors[0].codePoint, 'U+0061');
  assert.equal(r.errors[1].position, 1);
  assert.equal(r.errors[1].codePoint, 'U+4E2D');
  assert.equal(r.errors[2].position, 2);
  assert.equal(r.errors[2].codePoint, 'U+283F');
  assert.deepEqual(r.errors[2].dots, [1, 2, 3, 4, 5, 6]);
  assert.match(r.errors[2].message, /现有字符表/);
  assert.equal(r.errors[3].position, 3);
  assert.equal(r.errors[3].codePoint, 'U+0062');
  // 未知单元也保留在 cells 中并标记 error
  assert.equal(r.cells.filter(c => c.error).length, 4);
  assert.equal(r.cells[2].kind, 'unknown');
});

test('解码：悬空大写前缀逐个报错并原样保留，不影响后续解码', () => {
  const r = Braille.decodeBraille('⠠ ⠁⠠');
  assert.equal(r.ok, false);
  assert.equal(r.decodedText, '⠠ a⠠');
  const capErrs = r.errors.filter(e => e.type === 'dangling-caps-prefix');
  assert.equal(capErrs.length, 2);
  assert.equal(capErrs[0].codePoint, 'U+2820');
  assert.equal(capErrs[0].position, 0);
  assert.equal(capErrs[1].position, 3);
  assert.match(capErrs[0].message, /没有作用对象/);
  assert.match(capErrs[1].message, /输入结尾/);
  // 中间的字母 a 仍被正常解码
  assert.equal(r.decodedText.charAt(2), 'a');
});

test('解码：非字符串与超长输入明确报错', () => {
  const bad = Braille.decodeBraille(null);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].type, 'bad-input');
  assert.equal(bad.decodedText, '');
  const long = Braille.decodeBraille('⠁'.repeat(Braille.DECODE_MAX_LENGTH + 1));
  assert.equal(long.ok, false);
  assert.equal(long.errors[0].type, 'input-too-long');
});

test('解码：空字符串为合法空结果', () => {
  const r = Braille.decodeBraille('');
  assert.equal(r.ok, true);
  assert.equal(r.decodedText, '');
  assert.deepEqual(r.cells, []);
  assert.deepEqual(r.errors, []);
});
