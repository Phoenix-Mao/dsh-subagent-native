/**
 * subagent-native 的客户端半边：设置页「子代理」。
 *
 * 两个 tab：
 *   环境 — 模式 / 门槛 / 扇出 / 预算 / 两个通道的模型·强度·权限
 *   记录 — 调用历史 + 判定日志
 *
 * 数据来自 Host：
 *   GET  /api/subagent-native/history   汇总 + runs + decisions + config
 *   POST /api/subagent-native/config    白名单字段写回 profile patch
 *   POST /api/subagent-native/history/clear
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-subagent-native',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const DATA_URL = '/api/subagent-native/history';
    const CONFIG_URL = '/api/subagent-native/config';
    const CLEAR_URL = '/api/subagent-native/history/clear';

    const DIFFICULTY = ['low', 'medium', 'high', 'extreme'];
    const DIFFICULTY_TEXT = { low: '低', medium: '中', high: '高', extreme: '极高' };
    const CHANNEL_TEXT = { codex: 'codex cli', claude: 'claude cli' };
    const TRIGGER_TEXT = { model: '模型调用', framework: '框架兜底' };
    const STOP_TEXT = { completed: '完成', aborted: '中断', error: '失败', 'max-tokens': '超长', refusal: '拒绝', unknown: '未知' };
    const STOP_TONE = { completed: 'ok', aborted: 'warn', error: 'err', 'max-tokens': 'warn', refusal: 'warn', unknown: 'idle' };

    const CSS = `
.sne {
  --sne-fg: var(--dsw-alias-label-primary, light-dark(#1a1e26, #e9ebf0));
  --sne-fg2: var(--dsw-alias-label-secondary, light-dark(#3f4756, #b7bfcc));
  --sne-accent: var(--dsw-alias-brand-primary, light-dark(#2f5fe0, #7292ff));
  --sne-accent-soft: color-mix(in srgb, var(--sne-accent) 12%, transparent);
  --sne-panel: var(--dsw-alias-bg-layer-1, light-dark(#ffffff, #20242e));
  --sne-panel2: var(--dsw-alias-bg-layer-2, light-dark(#f5f6f9, #262b37));
  --sne-border: var(--dsw-alias-border-l1, light-dark(#dce0e8, #2e3440));
  --sne-border2: var(--dsw-alias-border-l2, light-dark(#c8ceda, #3a4250));
  --sne-ok: var(--dsw-alias-state-success-primary, light-dark(#0e8a55, #3ddc97));
  --sne-warn: var(--dsw-alias-state-warn-primary, light-dark(#b45309, #fbbf24));
  --sne-err: var(--dsw-alias-state-error-primary, light-dark(#d92d20, #ff7b72));
  --sne-idle: var(--dsw-alias-state-idle-primary, light-dark(#8b93a3, #6b7486));
  display: flex; flex-direction: column; gap: 16px;
  max-width: 920px; font-size: 12.5px; line-height: 1.55; color: var(--sne-fg);
}
.sne, .sne *, .sne *::before, .sne *::after { box-sizing: border-box; }
.sne-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.sne-title { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.01em; }
.sne-sub { margin: 3px 0 0; font-size: 12.5px; color: var(--sne-fg2); }
.sne-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--sne-border); }
.sne-tab { appearance: none; background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--sne-fg2); font: inherit; font-weight: 600; padding: 7px 12px; margin-bottom: -1px; cursor: pointer; }
.sne-tab:hover { color: var(--sne-fg); }
.sne-tab[data-active="true"] { color: var(--sne-fg); border-bottom-color: var(--sne-accent); font-weight: 650; }
.sne-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.sne-card { border: 1px solid var(--sne-border); border-radius: 12px; background: var(--sne-panel);
  padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.sne-cardhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sne-cardtitle { font-size: 13.5px; font-weight: 650; }
.sne-cardsub { font-size: 11.5px; color: var(--sne-fg2); margin-top: 1px; }
.sne-row { display: flex; align-items: center; gap: 8px; }
.sne-label { flex: 0 0 auto; width: 84px; color: var(--sne-fg2); font-size: 12px; }
.sne-input, .sne-select { flex: 1 1 auto; min-width: 0; height: 30px; padding: 0 9px;
  border: 1px solid var(--sne-border); border-radius: 8px; background: var(--sne-panel2);
  color: var(--sne-fg); font: inherit; font-size: 12.5px; outline: none; }
.sne-input:focus, .sne-select:focus { border-color: var(--sne-accent); }
.sne-select { cursor: pointer; }
.sne-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.sne-num { font-variant-numeric: tabular-nums; }
.sne-hint { font-size: 11.5px; color: var(--sne-fg2); }
.sne-btn { appearance: none; font: inherit; font-size: 12.5px; font-weight: 600; height: 30px; padding: 0 14px;
  border-radius: 8px; border: 1px solid var(--sne-border2); background: var(--sne-panel2);
  color: var(--sne-fg); cursor: pointer; }
.sne-btn:hover { border-color: var(--sne-accent); }
.sne-btn:disabled { opacity: .55; cursor: default; }
.sne-btn-primary { border-color: var(--sne-accent); background: var(--sne-accent-soft); font-weight: 650; }
.sne-btn-sm { height: 26px; padding: 0 10px; font-size: 12px; }
.sne-seg { display: inline-flex; border: 1px solid var(--sne-border); border-radius: 8px; overflow: hidden; background: var(--sne-panel2); }
.sne-segbtn { appearance: none; border: none; background: none; color: var(--sne-fg2); font: inherit;
  font-size: 12px; padding: 5px 10px; cursor: pointer; }
.sne-segbtn + .sne-segbtn { border-left: 1px solid var(--sne-border); }
.sne-segbtn[data-active="true"] { background: var(--sne-accent-soft); color: var(--sne-fg); font-weight: 650;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sne-accent) 55%, transparent); }
.sne-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
  padding: 1px 9px; border-radius: 999px; white-space: nowrap; background: var(--sne-panel2);
  border: 1px solid var(--sne-border); color: var(--sne-fg2); }
.sne-chip-ok { color: var(--sne-ok); border-color: color-mix(in srgb, var(--sne-ok) 35%, transparent); background: color-mix(in srgb, var(--sne-ok) 12%, transparent); }
.sne-chip-err { color: var(--sne-err); border-color: color-mix(in srgb, var(--sne-err) 35%, transparent); background: color-mix(in srgb, var(--sne-err) 11%, transparent); }
.sne-chip-warn { color: var(--sne-warn); border-color: color-mix(in srgb, var(--sne-warn) 35%, transparent); background: color-mix(in srgb, var(--sne-warn) 13%, transparent); }
.sne-summary { display: flex; gap: 18px; flex-wrap: wrap; font-size: 11.5px; color: var(--sne-fg2); }
.sne-summary b { color: var(--sne-fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.sne-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sne-table th { text-align: left; font-weight: 600; color: var(--sne-fg2); padding: 6px 8px;
  border-bottom: 1px solid var(--sne-border); font-size: 11.5px; white-space: nowrap; }
.sne-table td { padding: 6px 8px; border-bottom: 1px solid var(--sne-border); vertical-align: middle; }
.sne-table tr:last-child td { border-bottom: none; }
.sne-table tbody tr:hover { background: color-mix(in srgb, var(--sne-fg) 4%, transparent); }
.sne-empty { padding: 22px 8px; text-align: center; color: var(--sne-fg2); font-size: 12px; }
.sne-sep { height: 1px; background: var(--sne-border); }
.sne-foot { display: flex; align-items: center; gap: 12px; }
.sne-msg-ok { color: var(--sne-ok); font-size: 12px; }
.sne-msg-err { color: var(--sne-err); font-size: 12px; }
.sne-bar { height: 6px; border-radius: 999px; background: var(--sne-panel2); overflow: hidden; border: 1px solid var(--sne-border); }
.sne-bar > span { display: block; height: 100%; background: var(--sne-accent); }
.sne-bar-warn > span { background: var(--sne-warn); }
.sne-bar-err > span { background: var(--sne-err); }
`;

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    const fmtTime = (at) => {
      if (!at) return '—';
      const d = new Date(at);
      const pad = (v) => String(v).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const fmtDuration = (ms) => {
      const v = Number(ms) || 0;
      if (v <= 0) return '—';
      return v >= 60000 ? `${(v / 60000).toFixed(1)}m` : `${(v / 1000).toFixed(1)}s`;
    };
    const fmtUsd = (v) => (typeof v === 'number' ? `$${v.toFixed(4)}` : '—');
    const fmtTokens = (usage) => {
      if (!usage) return '—';
      const parts = [];
      if (usage.input) parts.push(`in ${usage.input}`);
      if (usage.cached) parts.push(`cache ${usage.cached}`);
      if (usage.cacheWrite) parts.push(`write ${usage.cacheWrite}`);
      if (usage.output) parts.push(`out ${usage.output}`);
      return parts.join(' · ') || '—';
    };

    function Field(props) {
      return h(
        'div',
        { className: 'sne-row' },
        h('span', { className: 'sne-label' }, props.label),
        props.children,
      );
    }

    function EnvTab(props) {
      const { config, draft, setDraft } = props;
      if (!draft) return null;
      const options = config.options ?? {};
      const usage = config.budget?.usage ?? 0;
      const barClass = `sne-bar${usage >= 1 ? ' sne-bar-err' : usage >= 0.8 ? ' sne-bar-warn' : ''}`;

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'sne-card' },
          h('div', { className: 'sne-cardtitle' }, '启用'),
          h(
            'div',
            { className: 'sne-hint' },
            '两项都关时插件不会注册通道：模型看不到子代理工具，框架也不会派发。这是新安装时的默认状态。',
          ),
          h(
            Field,
            { label: '允许模型调用' },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: draft.tools.enabled,
                onChange: (event) => setDraft({ ...draft, tools: { ...draft.tools, enabled: event.target.checked } }),
              }),
              draft.tools.enabled ? '已注册（模型可调用）' : '未注册（工具不可见）',
            ),
          ),
          h(
            Field,
            { label: '框架派发' },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: draft.auto.enabled,
                onChange: (event) => setDraft({ ...draft, auto: { ...draft.auto, enabled: event.target.checked } }),
              }),
              draft.auto.enabled ? '已启用（会按规则自动派发）' : '未启用',
            ),
          ),
        ),

        h(
          'div',
          { className: 'sne-card' },
          h('div', { className: 'sne-cardtitle' }, '触发'),
          h(
            Field,
            { label: '模式' },
            h(
              'div',
              { className: 'sne-seg' },
              (options.modes ?? ['observe', 'dispatch']).map((mode) =>
                h(
                  'button',
                  {
                    key: mode,
                    className: 'sne-segbtn',
                    'data-active': String(draft.auto.mode === mode),
                    onClick: () => setDraft({ ...draft, auto: { ...draft.auto, mode } }),
                  },
                  mode === 'observe' ? 'observe 只判定' : 'dispatch 真派发',
                ),
              ),
            ),
          ),
          h(
            Field,
            { label: '最低难度' },
            h(
              'div',
              { style: { display: 'flex', gap: 12, flex: '1 1 auto' } },
              ['claude', 'codex'].map((channel) =>
                h(
                  'label',
                  { key: channel, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                  h('span', { style: { color: 'var(--sne-fg2)' } }, channel),
                  h(
                    'select',
                    {
                      className: 'sne-select',
                      value: draft.auto.thresholds[channel],
                      onChange: (event) =>
                        setDraft({
                          ...draft,
                          auto: { ...draft.auto, thresholds: { ...draft.auto.thresholds, [channel]: event.target.value } },
                        }),
                    },
                    DIFFICULTY.map((level) => h('option', { key: level, value: level }, `${DIFFICULTY_TEXT[level]}（${level}）`)),
                  ),
                ),
              ),
            ),
          ),
          h(
            Field,
            { label: '最短提示' },
            h('input', {
              className: 'sne-input sne-num',
              type: 'number',
              min: 0,
              value: draft.auto.minPromptChars,
              onChange: (event) => setDraft({ ...draft, auto: { ...draft.auto, minPromptChars: Number(event.target.value) } }),
            }),
          ),
        ),

        h(
          'div',
          { className: 'sne-card' },
          h('div', { className: 'sne-cardtitle' }, '让出控制'),
          h(
            'div',
            { className: 'sne-hint' },
            '派发后用一行运行时提示明确要求主代理「不要自己再做同一件事」——这是「派出去=省钱」成立的前提。20 分钟后或收到结果自动失效。',
          ),
          h(
            Field,
            { label: '派发后让出' },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: draft.auto.yield,
                onChange: (event) => setDraft({ ...draft, auto: { ...draft.auto, yield: event.target.checked } }),
              }),
              '启用',
            ),
          ),
        ),

        h(
          'div',
          { className: 'sne-card' },
          h(
            'div',
            { className: 'sne-cardhead' },
            h('div', { className: 'sne-cardtitle' }, '并行扇出'),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: draft.team.enabled,
                onChange: (event) => setDraft({ ...draft, team: { ...draft.team, enabled: event.target.checked } }),
              }),
              '启用',
            ),
          ),
          h(
            'div',
            { className: 'sne-hint' },
            '提示里出现 ≥2 个文件路径时，拆成多份并行派发；每份只处理自己那几个文件。',
          ),
          h(
            Field,
            { label: '最多份数' },
            h('input', {
              className: 'sne-input sne-num',
              type: 'number',
              min: 1,
              max: 6,
              value: draft.team.maxParallel,
              onChange: (event) => setDraft({ ...draft, team: { ...draft.team, maxParallel: Number(event.target.value) } }),
            }),
          ),
        ),

        h(
          'div',
          { className: 'sne-card' },
          h(
            'div',
            { className: 'sne-cardhead' },
            h('div', { className: 'sne-cardtitle' }, '角色接力'),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: draft.relay.enabled,
                onChange: (event) => setDraft({ ...draft, relay: { ...draft.relay, enabled: event.target.checked } }),
              }),
              '启用',
            ),
          ),
          h(
            'div',
            { className: 'sne-hint' },
            '高难度任务让方案方先出「改动清单」，再由执行方照着做。两段串行，成本约等于两次调用；方案段静默，只有执行结果回注。',
          ),
          h(
            Field,
            { label: '难度门槛' },
            h(
              'select',
              {
                className: 'sne-select',
                value: draft.relay.minDifficulty,
                onChange: (event) => setDraft({ ...draft, relay: { ...draft.relay, minDifficulty: event.target.value } }),
              },
              DIFFICULTY.map((level) => h('option', { key: level, value: level }, `${DIFFICULTY_TEXT[level]}（${level}）`)),
            ),
          ),
          h(
            Field,
            { label: '方案 / 执行' },
            h(
              'div',
              { style: { display: 'flex', gap: 8, flex: '1 1 auto' } },
              ['planChannel', 'executeChannel'].map((key) =>
                h(
                  'select',
                  {
                    key,
                    className: 'sne-select',
                    value: draft.relay[key],
                    onChange: (event) => setDraft({ ...draft, relay: { ...draft.relay, [key]: event.target.value } }),
                  },
                  ['claude', 'codex'].map((channel) => h('option', { key: channel, value: channel }, channel)),
                ),
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'sne-card' },
          h(
            'div',
            { className: 'sne-cardhead' },
            h('div', { className: 'sne-cardtitle' }, '预算护栏'),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: draft.budget.enabled,
                onChange: (event) => setDraft({ ...draft, budget: { ...draft.budget, enabled: event.target.checked } }),
              }),
              '启用',
            ),
          ),
          h(
            'div',
            { className: 'sne-hint' },
            `今日已花 ${fmtUsd(config.budget?.spentToday ?? 0)}${config.budget?.dailyUsd ? ` / 上限 ${fmtUsd(config.budget.dailyUsd)}` : '（未设上限）'}。按估算成本计，超上限后不再发起新的派发（模型直接调用也会被拒绝）。`,
          ),
          h('div', { className: barClass }, h('span', { style: { width: `${Math.round(usage * 100)}%` } })),
          h(
            Field,
            { label: '日上限 $' },
            h('input', {
              className: 'sne-input sne-num',
              type: 'number',
              min: 0,
              step: 0.1,
              value: draft.budget.dailyUsd,
              onChange: (event) => setDraft({ ...draft, budget: { ...draft.budget, dailyUsd: Number(event.target.value) } }),
            }),
          ),
        ),

        h(
          'div',
          { className: 'sne-grid' },
          h(
            'div',
            { className: 'sne-card' },
            h('div', { className: 'sne-cardtitle' }, 'codex cli'),
            h('div', { className: 'sne-cardsub' }, 'Codex 通道 · 1 折'),
            config.cli?.codex && !config.cli.codex.found
              ? h(
                  'div',
                  { className: 'sne-hint', style: { color: 'var(--sne-warn)' } },
                  `⚠ 未找到 ${config.cli.codex.command}（${config.cli.codex.reason ?? '未知原因'}）。装好后重启 DSH，或在下面填绝对路径。`,
                )
              : null,
            h(
              Field,
              { label: 'CLI 路径' },
              h('input', {
                className: 'sne-input sne-mono',
                value: draft.codex.command ?? '',
                placeholder: '留空 = 用 PATH 里的 codex',
                spellCheck: false,
                onChange: (event) => setDraft({ ...draft, codex: { ...draft.codex, command: event.target.value } }),
              }),
            ),
            h(
              Field,
              { label: '模型' },
              h('input', {
                className: 'sne-input sne-mono',
                value: draft.codex.model,
                placeholder: '留空 = 用原生配置',
                spellCheck: false,
                onChange: (event) => setDraft({ ...draft, codex: { ...draft.codex, model: event.target.value } }),
              }),
            ),
            h(
              Field,
              { label: '强度' },
              h(
                'select',
                {
                  className: 'sne-select',
                  value: draft.codex.effort,
                  onChange: (event) => setDraft({ ...draft, codex: { ...draft.codex, effort: event.target.value } }),
                },
                (options.codexEfforts ?? ['']).map((level) => h('option', { key: level || 'native', value: level }, level || '（原生配置）')),
              ),
            ),
            h(
              Field,
              { label: '沙箱' },
              h(
                'select',
                {
                  className: 'sne-select',
                  value: draft.codex.sandbox,
                  onChange: (event) => setDraft({ ...draft, codex: { ...draft.codex, sandbox: event.target.value } }),
                },
                [
                  ['', '（原生配置）'],
                  ['read-only', 'read-only'],
                  ['workspace-write', 'workspace-write'],
                  ['danger-full-access', 'danger-full-access'],
                ].map(([value, label]) => h('option', { key: value || 'native', value }, label)),
              ),
            ),
            draft.codex.sandbox === 'workspace-write' || draft.codex.sandbox === 'danger-full-access'
              ? h('div', { className: 'sne-hint', style: { color: 'var(--sne-warn)' } }, '⚠ 可写：子代理会直接修改工作目录里的文件，且不经过 DSH 审批。')
              : null,
          ),
          h(
            'div',
            { className: 'sne-card' },
            h('div', { className: 'sne-cardtitle' }, 'claude cli'),
            h('div', { className: 'sne-cardsub' }, 'Claude Code 通道 · 4 折'),
            config.cli?.claude && !config.cli.claude.found
              ? h(
                  'div',
                  { className: 'sne-hint', style: { color: 'var(--sne-warn)' } },
                  `⚠ 未找到 ${config.cli.claude.command}（${config.cli.claude.reason ?? '未知原因'}）。装好后重启 DSH，或在下面填绝对路径。`,
                )
              : null,
            h(
              Field,
              { label: 'CLI 路径' },
              h('input', {
                className: 'sne-input sne-mono',
                value: draft.claude.command ?? '',
                placeholder: '留空 = 用 PATH 里的 claude',
                spellCheck: false,
                onChange: (event) => setDraft({ ...draft, claude: { ...draft.claude, command: event.target.value } }),
              }),
            ),
            h(
              Field,
              { label: '模型' },
              h('input', {
                className: 'sne-input sne-mono',
                value: draft.claude.model,
                placeholder: '留空 = 用原生配置',
                spellCheck: false,
                onChange: (event) => setDraft({ ...draft, claude: { ...draft.claude, model: event.target.value } }),
              }),
            ),
            h(
              Field,
              { label: '强度' },
              h(
                'select',
                {
                  className: 'sne-select',
                  value: draft.claude.effort,
                  onChange: (event) => setDraft({ ...draft, claude: { ...draft.claude, effort: event.target.value } }),
                },
                (options.claudeEfforts ?? ['']).map((level) => h('option', { key: level || 'native', value: level }, level || '（原生配置）')),
              ),
            ),
            h(
              Field,
              { label: '权限模式' },
              h(
                'select',
                {
                  className: 'sne-select',
                  value: draft.claude.permissionMode,
                  onChange: (event) => setDraft({ ...draft, claude: { ...draft.claude, permissionMode: event.target.value } }),
                },
                (options.claudePermissionModes ?? []).map((mode) => h('option', { key: mode, value: mode }, mode)),
              ),
            ),
            draft.claude.permissionMode === 'acceptEdits' || draft.claude.permissionMode === 'bypassPermissions'
              ? h('div', { className: 'sne-hint', style: { color: 'var(--sne-warn)' } }, '⚠ 可写：子代理会直接修改文件，且不经过 DSH 审批。')
              : null,
          ),
        ),
      );
    }

    function RecordsTab(props) {
      const { runs, decisions, summary, onClear, clearing } = props;
      const tbody = (runs ?? []).map((run) =>
        h(
          'tr',
          { key: run.id },
          h('td', { className: 'sne-mono sne-num' }, fmtTime(run.startedAt)),
          h('td', null, CHANNEL_TEXT[run.channel] ?? run.channel ?? '—'),
          h('td', { className: 'sne-mono' }, run.model || '—'),
          h(
            'td',
            null,
            run.relay === 'plan'
              ? '框架·方案'
              : run.relay === 'exec'
                ? '框架·执行'
                : TRIGGER_TEXT[run.trigger] ?? run.trigger ?? '—',
          ),          h('td', { className: 'sne-mono sne-num' }, run.fanout ? `${run.fanout.index}/${run.fanout.total}` : '—'),
          h('td', { className: 'sne-mono sne-num' }, fmtDuration(run.durationMs)),
          h('td', { className: 'sne-mono sne-num' }, fmtUsd(run.costEstimate?.usd)),
          h(
            'td',
            null,
            h('span', { className: `sne-chip sne-chip-${STOP_TONE[run.stopReason] ?? 'idle'}` }, STOP_TEXT[run.stopReason] ?? run.stopReason ?? '未知'),
          ),
        ),
      );

      const decisionRows = (decisions ?? []).map((item, index) =>
        h(
          'tr',
          { key: `${item.at}-${index}` },
          h('td', { className: 'sne-mono sne-num' }, fmtTime(item.at)),
          h('td', null, item.route ?? '—'),
          h('td', null, item.action ?? (item.mode === 'observe' ? '判定' : '—')),
          h('td', { className: 'sne-mono sne-num' }, item.difficulty?.level ?? '—'),
          h('td', { style: { color: 'var(--sne-fg2)' } }, item.reason ?? ''),
        ),
      );

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'sne-summary' },
          h('span', null, '今日 ', h('b', null, summary?.today ?? 0), ' 次'),
          h('span', null, '累计 ', h('b', null, summary?.total ?? 0), ' 次'),
          h('span', null, '估算成本 ', h('b', null, fmtUsd(summary?.estimatedCostUsd ?? 0))),
          h('span', null, '平均 ', h('b', null, fmtDuration(summary?.avgDurationMs ?? 0))),
          Object.entries(summary?.byTrigger ?? {}).map(([key, count]) =>
            h('span', { key }, `${TRIGGER_TEXT[key] ?? key} `, h('b', null, count), ' 次'),
          ),
          h('span', null, '未完成 ', h('b', null, summary?.failures ?? 0), ' 次'),
        ),

        h(
          'div',
          { className: 'sne-card', style: { padding: 0, overflow: 'hidden' } },
          h(
            'table',
            { className: 'sne-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['时间', '通道', '模型', '触发', '扇出', '耗时', '成本', '结果'].map((label) => h('th', { key: label }, label)),
              ),
            ),
            tbody.length > 0
              ? h('tbody', null, tbody)
              : h(
                  'tbody',
                  null,
                  h(
                    'tr',
                    null,
                    h('td', { colSpan: 8 }, h('div', { className: 'sne-empty' }, '还没有调用记录')),
                  ),
                ),
          ),
        ),

        h(
          'div',
          { className: 'sne-card', style: { padding: 0, overflow: 'hidden' } },
          h('div', { style: { padding: '10px 12px 0', fontSize: 12.5, fontWeight: 650 } }, '最近判定'),
          h(
            'table',
            { className: 'sne-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['时间', '路由', '动作', '难度', '理由'].map((label) => h('th', { key: label }, label)),
              ),
            ),
            decisionRows.length > 0
              ? h('tbody', null, decisionRows)
              : h(
                  'tbody',
                  null,
                  h(
                    'tr',
                    null,
                    h('td', { colSpan: 5 }, h('div', { className: 'sne-empty' }, '还没有判定记录')),
                  ),
                ),
          ),
        ),

        h(
          'div',
          { className: 'sne-foot' },
          h('button', { className: 'sne-btn sne-btn-sm', disabled: clearing, onClick: onClear }, clearing ? '清空中…' : '清空记录'),
          h('span', { className: 'sne-hint' }, '只清展示记录；预算账本（今日已花）不受影响。'),
        ),
      );
    }

    function Section() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [tab, setTab] = useState('env');
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState(null);
      const [clearing, setClearing] = useState(false);
      const seeded = useRef(false);

      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const next = await getJson(DATA_URL);
            if (!alive) return;
            setData(next);
            setError(null);
          } catch (cause) {
            if (alive) setError(String(cause?.message ?? cause));
          }
        };
        void load();
        const timer = setInterval(load, 5000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      useEffect(() => {
        if (!data?.config || seeded.current) return;
        seeded.current = true;
        const c = data.config;
        setDraft({
          auto: { ...c.auto, thresholds: { ...c.auto.thresholds } },
          tools: { enabled: c.tools?.enabled === true },
          team: { enabled: c.team.enabled, maxParallel: c.team.maxParallel },
          relay: {
            enabled: c.relay.enabled,
            minDifficulty: c.relay.minDifficulty,
            planChannel: c.relay.planChannel,
            executeChannel: c.relay.executeChannel,
          },
          budget: { enabled: c.budget.enabled, dailyUsd: c.budget.dailyUsd },
          codex: { command: c.codex.command ?? '', model: c.codex.model, effort: c.codex.effort, sandbox: c.codex.sandbox },
          claude: { command: c.claude.command ?? '', model: c.claude.model, effort: c.claude.effort, permissionMode: c.claude.permissionMode },
        });
      }, [data]);

      const save = useCallback(async () => {
        if (!draft) return;
        setSaving(true);
        setMessage(null);
        try {
          await postJson(CONFIG_URL, draft);          setMessage({ ok: true, text: '已保存并重载插件。' });
          seeded.current = false;
        } catch (cause) {
          setMessage({ ok: false, text: `保存失败：${cause?.message ?? cause}` });
        } finally {
          setSaving(false);
        }
      }, [draft]);

      const clear = useCallback(async () => {
        setClearing(true);
        try {
          await postJson(CLEAR_URL, {});
          setMessage({ ok: true, text: '记录已清空。' });
        } catch (cause) {
          setMessage({ ok: false, text: `清空失败：${cause?.message ?? cause}` });
        } finally {
          setClearing(false);
        }
      }, []);

      if (error && !data) {
        return h('div', { className: 'sne' }, h('p', { className: 'sne-sub' }, `读不到插件状态：${error}`));
      }
      if (!data) {
        return h('div', { className: 'sne' }, h('p', { className: 'sne-sub' }, '加载中…'));
      }

      const summary = data.summary ?? {};
      const budgetChip =
        data.budget && !data.budget.ok
          ? h('span', { className: 'sne-chip sne-chip-err' }, '预算触顶')
          : h('span', { className: 'sne-chip' }, `今日 ${fmtUsd(summary.estimatedCostUsd ?? 0)}`);

      return h(
        'div',
        { className: 'sne' },
        h(
          'div',
          { className: 'sne-head' },
          h(
            'div',
            null,
            h('h3', { className: 'sne-title' }, '子代理'),
            h('p', { className: 'sne-sub' }, '原生 codex / claude CLI 通道：触发策略、并行扇出、预算护栏与调用记录。'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, budgetChip),
        ),

        h(
          'div',
          { className: 'sne-tabs' },
          [
            ['env', '环境与阈值'],
            ['records', `调用记录${summary.today ? `（今日 ${summary.today}）` : ''}`],
          ].map(([key, label]) =>
            h('button', { key, className: 'sne-tab', 'data-active': String(tab === key), onClick: () => setTab(key) }, label),
          ),
        ),

        tab === 'env'
          ? h(
              React.Fragment,
              null,
              h(EnvTab, { config: data.config ?? {}, draft, setDraft }),
              h('div', { className: 'sne-sep' }),
              h(
                'div',
                { className: 'sne-foot' },
                h('button', { className: 'sne-btn sne-btn-primary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存并重载'),
                message
                  ? h('span', { className: message.ok ? 'sne-msg-ok' : 'sne-msg-err' }, message.text)
                  : h('span', { className: 'sne-hint' }, '写入 profile 的 cordis.patch.yml；保存后插件自动重载。'),
              ),
            )
          : h(RecordsTab, {
              runs: data.runs,
              decisions: data.decisions,
              summary,
              files: data.files,
              onClear: clear,
              clearing,
            }),
      );
    }

    function SectionIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M3 4.5h10M3 8h6M3 11.5h4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('circle', { cx: 12.5, cy: 11.5, r: 1.6, fill: 'currentColor' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const existing = document.getElementById('subagent-native-style');
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = 'subagent-native-style';
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => {
          style.remove();
        });

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'subagent-native', order: 27, label: '子代理' }, Section),
        );
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'subagent-native' }, SectionIcon),
        );
      },
    };
  },
});
