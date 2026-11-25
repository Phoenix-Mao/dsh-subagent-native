import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyThreshold,
  countPaths,
  estimateDifficulty,
  hitsWord,
  levelIndex,
  levelOfScore,
} from '../lib/difficulty.js';

test('levelOfScore：档位边界', () => {
  assert.equal(levelOfScore(0), 'low');
  assert.equal(levelOfScore(9), 'low');
  assert.equal(levelOfScore(10), 'medium');
  assert.equal(levelOfScore(19), 'medium');
  assert.equal(levelOfScore(20), 'high');
  assert.equal(levelOfScore(34), 'high');
  assert.equal(levelOfScore(35), 'extreme');
  assert.equal(levelOfScore(999), 'extreme');
});

test('levelIndex：低 < 中 < 高 < 极高', () => {
  assert.ok(levelIndex('low') < levelIndex('medium'));
  assert.ok(levelIndex('medium') < levelIndex('high'));
  assert.ok(levelIndex('high') < levelIndex('extreme'));
});

test('countPaths：认出 Windows 路径、相对路径、反引号与中文标点', () => {
  assert.equal(countPaths('改 D:\\proj\\app\\Form1.cs 里的东西'), 1);
  assert.equal(countPaths('看 src/index.js 和 lib/rules.js'), 2);
  assert.equal(countPaths('没有路径'), 0);
  // 2026-11-19 修：反引号 / 中文标点后面的路径原先认不出
  assert.equal(countPaths('改一下 `lib/rules.js`、`lib/judge.js`'), 2);
  assert.equal(countPaths('先看：D:/proj/app/a.cs'), 1);
});

test('estimateDifficulty：否定句里的规模词不加分', () => {
  const plain = estimateDifficulty({ prompt: '不要重构，只把 Form1.cs 第 12 行改成 5000' });
  const positive = estimateDifficulty({ prompt: '重构 Form1.cs 里的通信层' });
  assert.ok(plain.score < positive.score, `否定 ${plain.score} 应低于肯定 ${positive.score}`);
  assert.equal(plain.level, 'low');
});

test('estimateDifficulty：「所有权」不算「所有」', () => {
  const result = estimateDifficulty({ prompt: 'Rust 的所有权是什么意思' });
  assert.equal(result.level, 'low');
  assert.ok(!result.signals.some((signal) => signal.includes('所有')), JSON.stringify(result.signals));
});

test('estimateDifficulty：不依赖作者本机的 ATE 路径（已移除硬编码加分）', () => {
  const back = estimateDifficulty({ prompt: '改一下', cwd: 'D:\\proj\\app' });
  const forward = estimateDifficulty({ prompt: '改一下', cwd: 'D:/proj/app' });
  const other = estimateDifficulty({ prompt: '改一下', cwd: 'C:\\work' });
  assert.equal(back.score, forward.score);
  assert.equal(back.score, other.score, '路径不应影响难度分');
  assert.ok(!back.signals.some((signal) => signal.includes('ATE')));
});

test('estimateDifficulty：短问答是 low', () => {
  const result = estimateDifficulty({ prompt: '这个函数干什么的', cwd: 'C:\\x' });
  assert.equal(result.level, 'low');
  assert.ok(result.score < 10);
});

test('estimateDifficulty：规模词 + 长提示 + 多路径会升档', () => {
  const prompt = [
    '把 D:\\proj\\app\\a.cs 和 D:\\proj\\app\\b.cs 以及 D:\\proj\\app\\c.cs 全部迁移到新接口，',
    '需要重构通信层，批量替换所有调用点，并逐个跑一遍回归测试，',
    '顺便分析一下为什么偶发超时，给出方案和权衡。',
    '这段描述再补一点长度，让它超过三百个字符，确保长度信号也被计入评分，',
    '否则单靠关键词可能还差一点分数。再多写一些：把每个模块的依赖关系整理出来，',
    '并检查所有异常分支。',
  ].join('');
  const result = estimateDifficulty({ prompt, cwd: 'D:\\proj\\app' });
  assert.ok(['high', 'extreme'].includes(result.level), `实际 ${result.level} 分=${result.score}`);
  assert.ok(result.signals.length >= 3);
});

test('estimateDifficulty：有失败证据会加分', () => {
  const base = estimateDifficulty({ prompt: '修一下这个报错' });
  const withFailures = estimateDifficulty({ prompt: '修一下这个报错', failures: 2 });
  assert.ok(withFailures.score > base.score);
});

test('hitsWord：排除已知误命中组合', () => {
  assert.equal(hitsWord('所有权', '所有'), false);
  assert.equal(hitsWord('所有文件都要改', '所有'), true);
  assert.equal(hitsWord('所有权，但所有文件都要改', '所有'), true);
});

test('applyThreshold：低于门槛自己干，达标放行', () => {
  const thresholds = { claude: 'medium', codex: 'low' };
  assert.deepEqual(
    applyThreshold({ route: 'claude', level: 'low', thresholds }),
    { route: 'self', gated: true, reason: '难度 low 低于 claude 的门槛 medium，主代理自己干' },
  );
  assert.equal(applyThreshold({ route: 'claude', level: 'medium', thresholds }).route, 'claude');
  assert.equal(applyThreshold({ route: 'claude', level: 'high', thresholds }).route, 'claude');
  assert.equal(applyThreshold({ route: 'codex', level: 'low', thresholds }).route, 'codex');
  // 平级：codex 不够也不会转给 claude
  assert.equal(applyThreshold({ route: 'codex', level: 'low', thresholds }).route, 'codex');
});

test('applyThreshold：self 与未知门槛直接放行', () => {
  assert.equal(applyThreshold({ route: 'self', level: 'low', thresholds: { claude: 'high' } }).gated, false);
  assert.equal(applyThreshold({ route: 'claude', level: 'low', thresholds: {} }).gated, false);
  assert.equal(applyThreshold({ route: 'claude', level: 'low', thresholds: { claude: 'bogus' } }).gated, false);
});
