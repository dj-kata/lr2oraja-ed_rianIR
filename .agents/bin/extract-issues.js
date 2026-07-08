#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// 引数パース
const args = process.argv.slice(2);
let reportPath = '';
let outputPath = '';
let includeFacts = false;
let force = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--include-facts') {
    includeFacts = true;
  } else if (args[i] === '--force') {
    force = true;
  } else if (!reportPath) {
    reportPath = args[i];
  } else if (!outputPath) {
    outputPath = args[i];
  }
}

// パス解決
const defaultDir = path.join(__dirname, '../../tmp/code-reviews');
if (!reportPath) {
  // 自動検出
  if (!fs.existsSync(defaultDir)) {
    console.error(`Error: Default directory not found at ${defaultDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(defaultDir);
  const matched = files
    .filter(f => f.includes('-integrated-review-report_') && f.endsWith('.md'))
    .map(f => ({ name: f, time: fs.statSync(path.join(defaultDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (matched.length === 0) {
    console.error('Error: No integrated review report found.');
    process.exit(1);
  }
  reportPath = path.join(defaultDir, matched[0].name);
} else {
  if (!fs.existsSync(reportPath)) {
    console.error(`Error: Input report file not found: ${reportPath}`);
    process.exit(1);
  }
}

if (!outputPath) {
  const dir = path.dirname(reportPath);
  const base = path.basename(reportPath, '.md');
  const prefix = base.replace(/-integrated-review-report.*/, '');
  outputPath = path.join(dir, `${prefix}-extracted_issues.md`);
}

console.log(`Input Report:  ${reportPath}`);
console.log(`Output Issues: ${outputPath}`);

// 処理本体
const lines = fs.readFileSync(reportPath, 'utf8').split(/\r?\n/);

function testIsIssue(facts, gateResult) {
  if (/\*\*F\*\*:\s*([1-9]\d*)/.test(facts)) return true;
  if (/\*\*M\*\*:\s*([1-9]\d*)/.test(facts)) return true;
  if (/\*\*m\*\*:\s*([1-9]\d*)/.test(facts)) return true;
  if (facts.includes('RED CARD') || facts.includes('FAIL')) return true;
  if (gateResult.includes('FAIL') || gateResult.includes('💀')) return true;
  return false;
}

// ターゲットフェーズの抽出
let inTable = false;
let tableHeaders = [];
let extractedRows = [];
let targetPhases = [];
let phaseMeta = {};

for (const line of lines) {
  if (inTable && line.trim() === '') {
    break;
  }
  if (!inTable && (/^\|\s*フェーズ\s*\|/.test(line) || /^\|\s*.*Gate 1/.test(line))) {
    inTable = true;
    tableHeaders.push(line);
    continue;
  }
  if (!inTable) continue;
  if (/^\|\s*:?---\s*:?/.test(line)) {
    tableHeaders.push(line);
    continue;
  }
  if (!line.startsWith('|')) continue;

  const columns = line.split('|');
  if (columns.length < 6) continue;

  const phaseName = columns[1].trim().replace(/\*\*|\*/g, '');
  const title = columns[2].trim();
  const score = columns[3].trim();
  const gateResult = columns[4].trim();
  const facts = columns[5].trim();

  if (testIsIssue(facts, gateResult)) {
    extractedRows.push(line);
    targetPhases.push(phaseName);
    phaseMeta[phaseName] = { title, score, gateResult, facts };
  }
}

// 詳細ブロックの抽出
let detailBlocks = {};
let currentPhase = null;
let currentSection = null;
let sectionBuffer = [];

function getSectionType(rawName) {
  if (rawName.includes('脆弱性') || rawName.includes('リファクタリング') || (rawName.includes('改善提案') && !rawName.includes('テスト戦略'))) {
    return 'Suggestions';
  }
  if (rawName.includes('評価プロセス') || rawName.includes('ファクト')) {
    return 'Facts';
  }
  return null;
}

for (const line of lines) {
  const phaseMatch = line.match(/^#\s*【(Phase\s*\d+-\d+)】/);
  if (phaseMatch) {
    if (currentPhase && currentSection) {
      detailBlocks[currentPhase][currentSection] = sectionBuffer.join('\n').trim();
    }
    currentPhase = phaseMatch[1];
    if (!detailBlocks[currentPhase]) {
      detailBlocks[currentPhase] = {};
    }
    currentSection = null;
    sectionBuffer = [];
    continue;
  }

  if (!currentPhase) continue;

  const sectionMatch = line.match(/^##\s*(.*)$/);
  if (sectionMatch) {
    if (currentSection) {
      detailBlocks[currentPhase][currentSection] = sectionBuffer.join('\n').trim();
    }
    currentSection = getSectionType(sectionMatch[1]);
    sectionBuffer = [];
    continue;
  }

  if (line.startsWith('---')) {
    if (currentSection) {
      detailBlocks[currentPhase][currentSection] = sectionBuffer.join('\n').trim();
    }
    currentPhase = null;
    currentSection = null;
    sectionBuffer = [];
    continue;
  }

  if (currentSection) {
    sectionBuffer.push(line);
  }
}
if (currentPhase && currentSection) {
  detailBlocks[currentPhase][currentSection] = sectionBuffer.join('\n').trim();
}

// レポート構築
let detailsText = '指摘事項（問題ありと判定されたフェーズ）はありませんでした。';
if (targetPhases.length > 0) {
  const details = targetPhases.map(phase => {
    const meta = phaseMeta[phase];
    const sugContent = (detailBlocks[phase] && detailBlocks[phase]['Suggestions']) || '具体的な改善提案はありません。';
    let factSection = '';
    if (includeFacts && detailBlocks[phase] && detailBlocks[phase]['Facts']) {
      factSection = `\n\n#### 📝 検出ファクト\n\n${detailBlocks[phase]['Facts']}\n`;
    }
    return `### 🔴 [${phase}] ${meta.title}\n\n- **スコア**: ${meta.score}\n- **判定**: ${meta.gateResult}\n- **件数サマリー**: ${meta.facts}\n\n#### 💡 改善提案\n\n${sugContent}${factSection}\n---\n`;
  });
  detailsText = details.join('\n');
}

const reportName = path.basename(reportPath);
const finalContent = `# 抽出された指摘・改善事項一覧\n\n元レポート: [${reportName}](${reportPath})\n\n## 1. 品質評価サマリー（問題ありフェーズのみ）\n\n${tableHeaders.join('\n')}\n${extractedRows.join('\n')}\n\n---\n\n## 2. 指摘・改善提案の詳細\n\n${detailsText}`;

fs.writeFileSync(outputPath, finalContent, 'utf8');
console.log('Extraction completed successfully.');
console.log(`Output path: ${outputPath}`);
console.log(`Extracted Issues Count: ${targetPhases.length}`);
