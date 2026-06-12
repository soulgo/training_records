import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  generateRecognitionPrompt,
  generateAnalysisPrompt,
  getTimeWindowPolicies,
  loadStructuredSource,
  parsePromptMetadataHeader,
  stripPromptMetadataHeader,
} from '../tools/prompt-generator.mjs';

test('generateRecognitionPrompt includes all key constraints', async () => {
  const prompt = await generateRecognitionPrompt();

  assert.match(prompt, /^<!-- prompt-metadata /);
  assert.equal(parsePromptMetadataHeader(prompt).version, '2026-06-05');
  assert.equal(parsePromptMetadataHeader(prompt).schemaName, 'telegram_training_image');
  assert.equal(parsePromptMetadataHeader(prompt).schemaVersion, 'v1');
  assert.match(prompt, /只能输出符合 schema 的 JSON/);
  assert.match(prompt, /## 输出类型/);
  assert.match(prompt, /`imageType` 只能是：/);
  assert.match(prompt, /- `measurement`：/);
  assert.match(prompt, /- `workout`：/);
  assert.match(prompt, /- `nutrition`：/);
  assert.match(prompt, /- `unknown`：/);
  assert.match(prompt, /## 日期规则/);
  assert.match(prompt, /detectedDate.*只来自截图画面内可见的可靠日期/);
  assert.match(prompt, /系统相册、文件详情或分享预览页/);
  assert.match(prompt, /dateEvidence.*写明截图内日期来源/);
  assert.match(prompt, /## 体脂秤 measurement/);
  assert.match(prompt, /kg = 斤 \* 0\.5/);
  assert.match(prompt, /## 运动 workout/);
  assert.match(prompt, /records\.dailyWorkoutSummary/);
  assert.match(prompt, /## 饮食 nutrition/);
  assert.match(prompt, /records\.totalCalories/);
  assert.match(prompt, /## 睡眠 sleep/);
  assert.match(prompt, /records\.sleep/);
  assert.match(prompt, /sleepScore/);
  assert.match(prompt, /醒来时间的前一天归档/);
  assert.match(prompt, /## 置信度和警告/);
  assert.match(prompt, /confidence.*0 到 1/);
  assert.match(prompt, /低于 0\.75.*会被系统跳过/);
  assert.match(prompt, /## 空值约定/);
  assert.match(prompt, /对象用 `null`/);
  assert.match(prompt, /数组用 `\[\]`/);
});

test('generateAnalysisPrompt includes all key sections', async () => {
  const prompt = await generateAnalysisPrompt();

  assert.match(prompt, /^<!-- prompt-metadata /);
  assert.equal(parsePromptMetadataHeader(prompt).version, '2026-06-01');
  assert.match(prompt, /训练数据分析助手/);
  assert.match(prompt, /## 输出要求/);
  assert.match(prompt, /只能基于给到你的结构化证据说话/);
  assert.match(prompt, /先判定证据质量，再下结论，再给行动/);
  assert.match(prompt, /coverage\.recent7/);
  assert.match(prompt, /trainingLoad\.recent7/);
  assert.match(prompt, /bodyCompositionRisk/);
  assert.match(prompt, /recoverySignal/);
  assert.match(prompt, /按问题类型组织回复/);
  assert.match(prompt, /## 问题类型与回复结构/);
  assert.match(prompt, /`pain_discomfort`/);
  assert.match(prompt, /`symptom_triage`/);
  assert.match(prompt, /现状判断、可能训练诱因、今天怎么处理、何时就医/);
  assert.doesNotMatch(prompt, /固定包含 4 段/);
  assert.match(prompt, /增肌减腹/);
  assert.match(prompt, /## 回答时间窗策略/);
  assert.match(prompt, /`no_recent30`/);
  assert.match(prompt, /`recent7_supplement`/);
  assert.match(prompt, /`explicit_mixed`/);
  assert.match(prompt, /`near_term`/);
  assert.match(prompt, /`default_recent7`/);
  assert.match(prompt, /## 数据阅读规则/);
  assert.match(prompt, /先看 coverage/);
  assert.match(prompt, /## 建议口径/);
  assert.match(prompt, /每周 2 到 4 次力量训练/);
  assert.match(prompt, /高强度间歇每周 1 到 2 次以内/);
  assert.match(prompt, /## 科学依据维护说明/);
  assert.match(prompt, /CDC 成人活动建议/);
  assert.match(prompt, /ISSN 蛋白质立场声明/);
  assert.match(prompt, /## 建议口径/);
  assert.match(prompt, /力量训练.*每周 2 到 4 次/);
  assert.match(prompt, /蛋白质、蔬菜/);
  assert.match(prompt, /## 空值约定/);
});

test('getTimeWindowPolicies returns all five policy codes', () => {
  const policies = getTimeWindowPolicies();

  assert.deepEqual(Object.keys(policies).sort(), [
    'default_recent7',
    'explicit_mixed',
    'near_term',
    'no_recent30',
    'recent7_supplement',
  ]);
  assert.match(policies.no_recent30, /主结论只使用 recent7/);
  assert.match(policies.recent7_supplement, /不要替代30天主结论/);
  assert.match(policies.explicit_mixed, /每个数字都必须标注对应时间窗/);
  assert.match(policies.near_term, /最近7天负荷和最近5天细节为主/);
  assert.match(policies.default_recent7, /默认以最近7天/);
});

test('generated recognition prompt loads correctly from structured source', async () => {
  const recognition = await loadStructuredSource('recognition-rules');

  assert.equal(typeof recognition.role, 'string');
  assert.equal(recognition.outputType.title, '输出类型');
  assert.equal(recognition.dateRules.title, '日期规则');
  assert.equal(recognition.measurement.title, '体脂秤 measurement');
  assert.equal(recognition.workout.title, '运动 workout');
  assert.equal(recognition.nutrition.title, '饮食 nutrition');
  assert.equal(recognition.sleep.title, '睡眠 sleep');
  assert.ok(Array.isArray(recognition.outputType.rules));
  assert.ok(recognition.outputType.rules.length > 0);
  assert.ok(Array.isArray(recognition.sleep.rules));
  assert.ok(recognition.sleep.rules.length > 0);
});

test('generated analysis prompt loads correctly from structured source', async () => {
  const analysis = await loadStructuredSource('analysis-rules');

  assert.equal(typeof analysis.role, 'string');
  assert.equal(analysis.outputRequirements.title, '输出要求');
  assert.equal(analysis.intentGuidelines.title, '问题类型与回复结构');
  assert.equal(analysis.adviceGuidelines.title, '建议口径');
  assert.equal(typeof analysis.timeWindowPolicies.no_recent30, 'string');
  assert.ok(Array.isArray(analysis.outputRequirements.rules));
  assert.ok(analysis.outputRequirements.rules.length > 0);
});

test('shared rules load correctly', async () => {
  const shared = await loadStructuredSource('shared-rules');

  assert.equal(shared.nullConventions.title, '空值约定');
  assert.equal(shared.confidenceAndWarnings.title, '置信度和警告');
  assert.equal(shared.sharedDateRules.title, '日期规则（共享）');
  assert.ok(Array.isArray(shared.nullConventions.rules));
  assert.ok(shared.nullConventions.rules.length > 0);
});

test('loadStructuredSource throws for unknown source name', async () => {
  await assert.rejects(loadStructuredSource('nonexistent'));
});

test('generated prompts are deterministic', async () => {
  const [first, second] = await Promise.all([
    generateRecognitionPrompt(),
    generateRecognitionPrompt(),
  ]);

  assert.equal(first, second);
});

test('prompt metadata header can be parsed and stripped', () => {
  const header = '<!-- prompt-metadata {"version":"2026-05-24","schemaName":"telegram_training_image"} -->\nhello';

  assert.deepEqual(parsePromptMetadataHeader(header), {
    version: '2026-05-24',
    schemaName: 'telegram_training_image',
  });
  assert.equal(stripPromptMetadataHeader(header), 'hello');
});
