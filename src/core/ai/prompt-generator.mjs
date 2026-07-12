import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..', '..');
const sourceDir = path.join(rootDir, 'prompts', '_source');
const outputDir = path.join(rootDir, 'prompts');

export async function loadStructuredSource(name) {
  const raw = await readFile(path.join(sourceDir, `${name}.json`), 'utf8');
  return JSON.parse(raw);
}

export async function getStructuredSourceMetadata(name) {
  const source = await loadStructuredSource(name);
  return source.metadata ?? {};
}

export async function getRecognitionPromptMetadata() {
  const [sharedMetadata, recognitionMetadata, appProfilesMetadata] = await Promise.all([
    getStructuredSourceMetadata('shared-rules'),
    getStructuredSourceMetadata('recognition-rules'),
    getStructuredSourceMetadata('app-profiles'),
  ]);

  return {
    version: recognitionMetadata.version ?? sharedMetadata.version ?? '',
    schemaName: recognitionMetadata.schemaName ?? 'telegram_training_image',
    schemaVersion: recognitionMetadata.schemaVersion ?? 'v1',
    sourceVersions: {
      shared: sharedMetadata.version ?? null,
      recognition: recognitionMetadata.version ?? null,
      appProfiles: appProfilesMetadata.version ?? null,
    },
  };
}

export async function getAnalysisPromptMetadata() {
  const [sharedMetadata, analysisMetadata] = await Promise.all([
    getStructuredSourceMetadata('shared-rules'),
    getStructuredSourceMetadata('analysis-rules'),
  ]);

  return {
    version: analysisMetadata.version ?? sharedMetadata.version ?? '',
    sourceVersions: {
      shared: sharedMetadata.version ?? null,
      analysis: analysisMetadata.version ?? null,
    },
  };
}

export async function generateRecognitionPrompt() {
  const [shared, recognition, appProfiles] = await Promise.all([
    loadStructuredSource('shared-rules'),
    loadStructuredSource('recognition-rules'),
    loadStructuredSource('app-profiles'),
  ]);
  const metadata = buildRecognitionPromptMetadata(shared.metadata, recognition.metadata, appProfiles.metadata);

  const sections = [
    renderPromptMetadataHeader(metadata),
    recognition.role,
    '',
    renderSection(recognition.batchRules),
    renderSection(recognition.screenshotTypeRules),
    renderSection(recognition.adaptiveExtraction),
    renderAppProfilesMemory(appProfiles),
    renderSection(recognition.outputType),
    renderSection(recognition.dateRules),
    renderSection(shared.sharedDateRules),
    renderSection(recognition.measurement),
    renderSection(recognition.workout),
    renderSection(recognition.nutrition),
    renderSection(recognition.sleep),
    renderSection(shared.confidenceAndWarnings),
    renderSection(shared.nullConventions),
  ];

  return `${sections.join('\n').trimEnd()}\n`;
}

export async function generateAnalysisPrompt() {
  const [shared, analysis] = await Promise.all([
    loadStructuredSource('shared-rules'),
    loadStructuredSource('analysis-rules'),
  ]);
  const metadata = buildAnalysisPromptMetadata(shared.metadata, analysis.metadata);

  const sections = [
    renderPromptMetadataHeader(metadata),
    analysis.role,
    '',
    renderSection(analysis.outputRequirements),
    renderSection(analysis.intentGuidelines),
    renderTimeWindowPolicies(analysis.timeWindowPolicies),
    renderSection(analysis.dataReadingRules),
    renderSection(analysis.adviceGuidelines),
    renderSection(analysis.sourceNote),
    renderSection(shared.nullConventions),
  ];

  return `${sections.join('\n').trimEnd()}\n`;
}

export async function writePromptFiles() {
  await mkdir(outputDir, { recursive: true });

  const [recognition, analysis] = await Promise.all([
    generateRecognitionPrompt(),
    generateAnalysisPrompt(),
  ]);

  await Promise.all([
    writeFile(path.join(outputDir, 'telegram-training-image-recognition.md'), recognition, 'utf8'),
    writeFile(path.join(outputDir, 'training-analysis.md'), analysis, 'utf8'),
  ]);

  return {
    recognition: path.join(outputDir, 'telegram-training-image-recognition.md'),
    analysis: path.join(outputDir, 'training-analysis.md'),
    metadata: {
      recognition: await getRecognitionPromptMetadata(),
      analysis: await getAnalysisPromptMetadata(),
    },
  };
}

export function getTimeWindowPolicies() {
  // Returns the policy texts for injection into the analysis system prompt at runtime.
  // Used by training-analysis.mjs to resolve policy codes.
  return {
    no_recent30:
      '主结论只使用 recent7、measurementTrend7 和 latestDays。不要引用 recent30 或 measurementTrend30 作为结论；若必须提及，只能标注为长期背景。',
    recent7_supplement:
      'recent7 只能作为近期变化补充，不要替代30天主结论。',
    explicit_mixed:
      '可以对比 recent7 和 recent30，但每个数字都必须标注对应时间窗。',
    near_term:
      '以最近7天负荷和最近5天细节为主。recent30 只能作为长期趋势背景，不要主动展开。',
    default_recent7:
      '默认以最近7天给可执行建议。recent30 只能作为长期趋势背景；如引用必须明确说"30天背景"。',
  };
}

export function stripPromptMetadataHeader(content) {
  return String(content ?? '').replace(/^<!-- prompt-metadata .*? -->\r?\n/, '');
}

export function parsePromptMetadataHeader(content) {
  const match = String(content ?? '').match(/^<!-- prompt-metadata (.*?) -->\r?\n/);
  if (!match) {
    return {};
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}

function buildRecognitionPromptMetadata(sharedMetadata = {}, recognitionMetadata = {}, appProfilesMetadata = {}) {
  return {
    version: recognitionMetadata.version ?? sharedMetadata.version ?? '',
    schemaName: recognitionMetadata.schemaName ?? 'telegram_training_image',
    schemaVersion: recognitionMetadata.schemaVersion ?? 'v1',
    sourceVersions: {
      shared: sharedMetadata.version ?? null,
      recognition: recognitionMetadata.version ?? null,
      appProfiles: appProfilesMetadata.version ?? null,
    },
  };
}

function buildAnalysisPromptMetadata(sharedMetadata = {}, analysisMetadata = {}) {
  return {
    version: analysisMetadata.version ?? sharedMetadata.version ?? '',
    sourceVersions: {
      shared: sharedMetadata.version ?? null,
      analysis: analysisMetadata.version ?? null,
    },
  };
}

function renderSection(section) {
  if (!section) return '';
  const lines = [`## ${section.title}`];
  if (section.rules && section.rules.length > 0) {
    lines.push('');
    for (const rule of section.rules) {
      lines.push(rule);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderAppProfilesMemory(source) {
  if (!source?.profiles?.length) return '';

  const lines = [`## ${source.title ?? 'App Profile 记忆'}`, ''];
  for (const rule of source.rules ?? []) {
    lines.push(rule);
  }
  if ((source.rules ?? []).length > 0) {
    lines.push('');
  }

  for (const profile of source.profiles) {
    const aliases = (profile.appAliases ?? []).slice(0, 4);
    lines.push(`- ${profile.appName}${aliases.length > 0 ? `（别名：${aliases.join('、')}）` : ''}`);

    const pageTypes = Object.entries(profile.pageTypes ?? {})
      .map(([type, cues]) => `${type}: ${(cues ?? []).slice(0, 3).join('、')}`)
      .filter((line) => !line.endsWith(': '));
    if (pageTypes.length > 0) {
      lines.push(`  - 页面特征：${pageTypes.join('；')}`);
    }

    const fieldAliases = Object.entries(profile.fieldAliases ?? {})
      .flatMap(([target, aliasesForTarget]) =>
        (aliasesForTarget ?? []).slice(0, 3).map((alias) => `${alias} -> ${target}`),
      )
      .slice(0, 12);
    if (fieldAliases.length > 0) {
      lines.push(`  - 字段别名：${fieldAliases.join('；')}`);
    }

    const conversions = (profile.unitConversions ?? []).slice(0, 4);
    if (conversions.length > 0) {
      lines.push(`  - 单位换算：${conversions.join('；')}`);
    }

    const timePriority = (profile.timePriority ?? []).slice(0, 4);
    if (timePriority.length > 0) {
      lines.push(`  - 时间优先级：${timePriority.join(' > ')}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderPromptMetadataHeader(metadata) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return '';
  }

  return `<!-- prompt-metadata ${JSON.stringify(metadata)} -->\n`;
}

function renderTimeWindowPolicies(policies) {
  if (!policies) return '';

  const lines = ['## 回答时间窗策略（focus.p 代码对照）'];
  lines.push('');

  for (const [code, text] of Object.entries(policies)) {
    if (code.startsWith('_')) continue;
    lines.push(`- \`${code}\`：${text}`);
  }

  lines.push('');
  return lines.join('\n');
}

// CLI entry point
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  writePromptFiles()
    .then((result) => {
      process.stdout.write(`Generated ${result.recognition}\n`);
      process.stdout.write(`Generated ${result.analysis}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = 1;
    });
}
