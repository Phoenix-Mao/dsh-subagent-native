/**
 * 读原生 CLI 配置里「实际生效」的模型与强度。
 *
 * provider 配置留空时，模型/强度由 CLI 自己的配置文件决定；历史记录要记生效值，
 * 否则日志里全是 null，事后没法判断这次跑的是哪个模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 极简 TOML 根级解析：只要 key = "value" 这种形式。 */
function parseRootStrings(text) {
  const root = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    root[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return root;
}

export function codexEffectiveConfig() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  const root = parseRootStrings(readText(file));
  return { model: root.model || null, effort: root.model_reasoning_effort || null, source: file };
}

export function claudeEffectiveConfig() {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  const text = readText(file);
  if (text == null) return { model: null, effort: null, source: file };
  try {
    const settings = JSON.parse(text);
    const model = settings?.model ?? settings?.env?.ANTHROPIC_MODEL ?? null;
    const effort = resolveEffort(settings, model);
    return { model, effort, source: file };
  } catch {
    return { model: null, effort: null, source: file };
  }
}

/** 强度键是真实模型名，settings.model 可能是别名（opus[1m] → claude-opus-5-5）。 */
function resolveEffort(settings, model) {
  const map = settings?.modelSettings ?? {};
  if (!model) return null;
  if (map[model]?.effortLevel) return map[model].effortLevel;
  const env = settings?.env ?? {};
  const family = String(model).replace(/\[.*\]$/, '').toLowerCase();
  const envName =
    family === 'opus'
      ? env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
      : family === 'sonnet'
        ? env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
        : family === 'haiku'
          ? env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
          : '';
  if (envName && map[envName]?.effortLevel) return map[envName].effortLevel;
  const byFamily = Object.keys(map).find((key) => family && key.toLowerCase().includes(family));
  if (byFamily) return map[byFamily]?.effortLevel ?? null;
  return null;
}
