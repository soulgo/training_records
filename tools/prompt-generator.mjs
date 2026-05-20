import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'prompts', '_source');
const outputDir = path.join(rootDir, 'prompts');

export async function loadStructuredSource(name) {
  const raw = await readFile(path.join(sourceDir, `${name}.json`), 'utf8');
  return JSON.parse(raw);
}

export async function generateRecognitionPrompt() {
  const [shared, recognition] = await Promise.all([
    loadStructuredSource('shared-rules'),
    loadStructuredSource('recognition-rules'),
  ]);

  const sections = [
    recognition.role,
    '',
    renderSection(recognition.outputType),
    renderSection(recognition.dateRules),
    renderSection(shared.sharedDateRules),
    renderSection(recognition.measurement),
    renderSection(recognition.workout),
    renderSection(recognition.nutrition),
    renderSection(shared.confidenceAndWarnings),
    renderSection(shared.nullConventions),
  ];

  return sections.join('\n') + '\n';
}

export async function generateAnalysisPrompt() {
  const [shared, analysis] = await Promise.all([
    loadStructuredSource('shared-rules'),
    loadStructuredSource('analysis-rules'),
  ]);

  const sections = [
    analysis.role,
    '',
    renderSection(analysis.outputRequirements),
    renderTimeWindowPolicies(analysis.timeWindowPolicies),
    renderSection(analysis.adviceGuidelines),
    renderSection(shared.nullConventions),
  ];

  return sections.join('\n') + '\n';
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
