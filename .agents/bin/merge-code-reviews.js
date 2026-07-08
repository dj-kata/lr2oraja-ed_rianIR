#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// 引数パース
const args = process.argv.slice(2);
let sessionId = '001';
let date = '';
let reviewDir = 'tmp/code-reviews';
let gateLevel = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' || args[i] === '-s') {
    sessionId = args[++i];
  } else if (args[i] === '--date' || args[i] === '-d') {
    date = args[++i];
  } else if (args[i] === '--dir') {
    reviewDir = args[++i];
  } else if (args[i] === '--gate' || args[i] === '-g') {
    gateLevel = parseInt(args[++i], 10);
  }
}

if (!date) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  date = `${yyyy}${mm}${dd}`;
}

const formattedDate = date.replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

const resolvedReviewDir = path.resolve(process.cwd(), reviewDir);
if (!fs.existsSync(resolvedReviewDir)) {
  console.error(`Error: Review directory does not exist: ${resolvedReviewDir}`);
  process.exit(1);
}

// ファイル検索
const files = fs.readdirSync(resolvedReviewDir);
const pattern = new RegExp(`^${sessionId}-phase.*-review_${date}.*\\.md$`);
const matchedFiles = files.filter(f => pattern.test(f)).sort();

if (matchedFiles.length === 0) {
  console.error(`Error: No review files found matching pattern: ${sessionId}-phase*-review_${date}*.md in ${resolvedReviewDir}`);
  process.exit(1);
}

console.log(`Found ${matchedFiles.length} review files.`);

class ReviewMetrics {
  constructor(meta) {
    this.isExcluded = (meta.na === true || meta.na === "true") || (meta.exclude === true || meta.exclude === "true");
    if (this.isExcluded) return;

    this.robustFatal = (meta.robustness && meta.robustness.fatal || []).length;
    this.robustMajor = (meta.robustness && meta.robustness.major || []).length;
    this.respFatal   = (meta.responsibility && meta.responsibility.fatal || []).length;
    this.respMajor   = (meta.responsibility && meta.responsibility.major || []).length;
    this.respMinor   = (meta.responsibility && meta.responsibility.minor || []).length;
    this.cogMajor    = (meta.cognitive && meta.cognitive.major || []).length;
    this.cogMinor    = (meta.cognitive && meta.cognitive.minor || []).length;
    this.riskFatal   = (meta.risk && meta.risk.fatal || []).length;
    this.riskMajor   = (meta.risk && meta.risk.major || []).length;
    this.roiMajor    = (meta.roi && meta.roi.major || []).length;

    this.archPenalties = meta.architecture_penalty || [];
    this.archPenaltyCount = this.archPenalties.length;

    this.bonusPatterns = !!(meta.bonus && meta.bonus.patterns);
    this.bonusEdgeCases = !!(meta.bonus && meta.bonus.edge_cases);
  }

  getTotalFatal() { return this.robustFatal + this.respFatal + this.riskFatal; }
  getTotalMajor() { return this.robustMajor + this.respMajor + this.cogMajor + this.riskMajor + this.roiMajor; }
  getTotalMinor() { return this.cogMinor + this.respMinor; }
}

const strictMultiplier = false;
const penaltyWeights = { Major: 5, Minor: 2 };
const archPenaltyWeight = 15;

function getCategorySubScores(metrics) {
  let robust = Math.max(0, 20 - (metrics.robustMajor * penaltyWeights.Major));
  let resp   = Math.max(0, 20 - (metrics.respMajor * penaltyWeights.Major) - (metrics.respMinor * penaltyWeights.Minor));
  let cog    = Math.max(0, 20 - (metrics.cogMajor * penaltyWeights.Major) - (metrics.cogMinor * penaltyWeights.Minor));
  let risk   = Math.max(0, 20 - (metrics.riskMajor * penaltyWeights.Major));
  let roi    = Math.max(0, 20 - (metrics.roiMajor * penaltyWeights.Major));

  if (metrics.robustFatal > 0) robust = 0;
  if (metrics.respFatal > 0) resp = 0;
  if (metrics.riskFatal > 0) risk = 0;

  return { robust, resp, cog, risk, roi };
}

function getCategoryRatio(score, hasFatal) {
  if (hasFatal) return 0.0;
  const rawRatio = score / 20.0;
  if (strictMultiplier) {
    return rawRatio;
  } else {
    return 0.5 + (0.5 * rawRatio);
  }
}

function getMultipliedScore(subScores, metrics) {
  const rRobust = getCategoryRatio(subScores.robust, metrics.robustFatal > 0);
  const rResp   = getCategoryRatio(subScores.resp, metrics.respFatal > 0);
  const rCog    = getCategoryRatio(subScores.cog, false);
  const rRisk   = getCategoryRatio(subScores.risk, metrics.riskFatal > 0);
  const rRoi    = getCategoryRatio(subScores.roi, false);

  let bonus = 0;
  if (metrics.bonusPatterns) bonus += 5;
  if (metrics.bonusEdgeCases) bonus += 5;

  const baseScore = 100.0 * rRobust * rResp * rCog * rRisk * rRoi;
  const totalScore = Math.round(Math.min(100, Math.max(0, baseScore + bonus)));

  return { totalScore, bonus };
}

function getIssueText(metrics) {
  const f = metrics.getTotalFatal();
  const m = metrics.getTotalMajor();
  const mi = metrics.getTotalMinor();

  let text = `**F**: ${f} <br> **M**: ${m} <br> **m**: ${mi}`;
  if (f > 0) {
    text += " <br> <span style='color:red; font-weight:bold;'>[RED CARD]</span>";
  }
  return text;
}

function getGateStatus(scoreValue, fatalCount) {
  if (fatalCount > 0) return "💀 FAIL";
  const passLine = gateLevel === 3 ? 90 : (gateLevel === 2 ? 80 : 60);
  if (scoreValue < passLine) return "🔴 REJECT";
  return "🟢 PASS";
}

function newScoreEvaluation(metrics) {
  const ev = {};
  if (!metrics || metrics.isExcluded) {
    ev.scoreValue = 0;
    ev.scoreText = "N/A";
    ev.issueText = "N/A (Excluded)";
    ev.status = "⚪ N/A";
    ev.isValid = false;
    return ev;
  }

  ev.isValid = true;
  const subScores = getCategorySubScores(metrics);
  ev.robustScore = subScores.robust;
  ev.respScore = subScores.resp;
  ev.cogScore = subScores.cog;
  ev.riskScore = subScores.risk;
  ev.roiScore = subScores.roi;

  const scoreResult = getMultipliedScore(subScores, metrics);
  ev.scoreValue = scoreResult.totalScore;
  ev.bonusScore = scoreResult.bonus;
  ev.scoreText = `${ev.scoreValue} / 100`;

  ev.issueText = getIssueText(metrics);
  ev.status = getGateStatus(ev.scoreValue, metrics.getTotalFatal());

  return ev;
}

function getReviewTitleAndPhase(lines, filepath) {
  const excludePatterns = ["アーキテクチャ総評", "検証サマリー", "メタデータ", "評価プロセス", "総合スコア", "脆弱性と構造 of 改善", "脆弱性と構造の改善", "テスト戦略の改善"];
  let titleLine = null;
  for (const line of lines) {
    if (/^#{1,2}\s+(.+)/.test(line)) {
      const header = line.replace(/^#{1,2}\s*/, '');
      if (!excludePatterns.some(p => header.includes(p))) {
        titleLine = line;
        break;
      }
    }
  }

  const filename = path.basename(filepath);
  const phaseMatch = filename.match(/phase(\d+(?:-\d+)?)/i);
  let phaseName = phaseMatch ? `Phase ${phaseMatch[1]}` : "Unknown";
  let titleClean = "No Title";

  if (titleLine) {
    const rawTitle = titleLine.replace(/^#{1,2}\s*/, '').replace(/\s*-\s*レビュー結果\s*$/, '').replace(/\s*コードレビュー結果\s*$/, '');
    const phaseHeaderMatch = rawTitle.match(/【(Phase\s*[\d\-]+)】(.*)/);
    if (phaseHeaderMatch) {
      phaseName = phaseHeaderMatch[1].trim();
      titleClean = phaseHeaderMatch[2].trim().replace(/^\[(.*)\]$/, '$1');
    } else {
      titleClean = rawTitle.trim();
    }
  } else {
    const planFile = path.join(path.dirname(filepath), filename.replace('-review_', '-plan_'));
    if (fs.existsSync(planFile)) {
      try {
        const planLines = fs.readFileSync(planFile, 'utf8').split(/\r?\n/);
        const planTitleLine = planLines.find(l => /^#\s+(.+)/.test(l));
        const planTitleMatch = planTitleLine && planTitleLine.match(/【Phase\s*[\d\-]+】\s*\[?(.*?)\]?$/);
        if (planTitleMatch) titleClean = planTitleMatch[1].trim();
      } catch (e) {}
    }
    if (titleClean === "No Title") {
      titleClean = path.basename(filepath, '.md');
    }
  }

  titleClean = titleClean.replace(/^【Phase\s*[\d\-]+】\s*/, '').replace(/^\[(.*)\]$/, '$1');
  return { phase: phaseName, title: titleClean };
}

function getReviewTargetFiles(lines, fallbackFilename) {
  const filesList = [];
  let inFilesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const riskMatch = trimmed.match(/Source of Risk:\s*(.*)/i);
    if (riskMatch) {
      const cleaned = riskMatch[1].replace(/[`\*]/g, '').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
      if (cleaned) filesList.push(path.basename(cleaned.trim()));
      continue;
    }

    if (trimmed.startsWith('- **対象ファイル:**')) {
      inFilesSection = true;
      continue;
    }

    if (inFilesSection) {
      if (trimmed === '' || trimmed.startsWith('#')) {
        if (filesList.length > 0) break;
        else continue;
      }
      const itemMatch = trimmed.match(/^[\-\*]\s*(.*?)$/);
      if (itemMatch) {
        const cleaned = itemMatch[1].trim().replace(/[`\*]/g, '').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
        if (cleaned && !cleaned.includes("対象ファイル:")) {
          filesList.push(path.basename(cleaned.trim()));
        }
      }
    }
  }

  if (filesList.length > 0) {
    return [...new Set(filesList)];
  } else {
    return [fallbackFilename];
  }
}

function updateScorePlaceholders(content, ev) {
  if (!ev.isValid) return content;
  return content
    .replace(/{{TOTAL_SCORE}}/g, ev.scoreValue)
    .replace(/{{SCORE_1}}/g, ev.robustScore)
    .replace(/{{SCORE_2}}/g, ev.respScore)
    .replace(/{{SCORE_3}}/g, ev.cogScore)
    .replace(/{{SCORE_4}}/g, ev.riskScore)
    .replace(/{{SCORE_5}}/g, ev.roiScore)
    .replace(/{{SCORE_BONUS}}/g, ev.bonusScore);
}

function getReviewMetadataAndEvaluation(content, lines) {
  let jsonStr = null;
  let matchedValue = null;

  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
    matchedValue = jsonBlockMatch[0];
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          JSON.parse(trimmed);
          jsonStr = trimmed;
          matchedValue = trimmed;
          break;
        } catch (e) {}
      }
    }
  }

  if (!jsonStr) {
    return {
      metrics: null,
      evaluation: newScoreEvaluation(null),
      content: content.trim()
    };
  }

  try {
    const meta = JSON.parse(jsonStr);
    const metrics = new ReviewMetrics(meta);
    const evaluation = newScoreEvaluation(metrics);

    let contentWithoutJson = content.replace(/##\s+メタデータ（集計システム用）\s*[\r\n]*/g, '').replace(matchedValue, '');
    let contentCleaned = updateScorePlaceholders(contentWithoutJson, evaluation);

    return {
      metrics,
      evaluation,
      content: contentCleaned.trim()
    };
  } catch (err) {
    console.warn("Warning: Failed to parse JSON metadata or calculate score.");
    return {
      metrics: null,
      evaluation: newScoreEvaluation(null),
      content: content.trim()
    };
  }
}

function parseReviewReport(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split(/\r?\n/);

  const titleInfo = getReviewTitleAndPhase(lines, filepath);
  const filesList = getReviewTargetFiles(lines, path.basename(filepath));
  const metaInfo = getReviewMetadataAndEvaluation(content, lines);

  return {
    phase: titleInfo.phase,
    title: titleInfo.title,
    files: filesList.join('<br>'),
    content: metaInfo.content,
    metrics: metaInfo.metrics,
    evaluation: metaInfo.evaluation
  };
}

const reportsData = matchedFiles.map(file => {
  const filepath = path.join(resolvedReviewDir, file);
  return parseReviewReport(filepath);
}).filter(Boolean);

const validReports = reportsData.filter(r => r.evaluation.isValid);

let systemScoreStr = "N/A";
let totalArchPenaltyCount = 0;
let allArchPenalties = [];

if (validReports.length > 0) {
  const totalScore = validReports.reduce((sum, r) => sum + r.evaluation.scoreValue, 0);
  const averageScore = totalScore / validReports.length;

  for (const report of validReports) {
    totalArchPenaltyCount += report.metrics.archPenaltyCount;
    if (report.metrics.archPenalties.length > 0) {
      allArchPenalties.push(...report.metrics.archPenalties);
    }
  }

  const finalSystemScore = Math.max(0, Math.round(averageScore - (totalArchPenaltyCount * archPenaltyWeight)));
  systemScoreStr = `${finalSystemScore} / 100`;
}

const gateLineText = gateLevel === 2 ? "80点" : (gateLevel === 3 ? "90点" : "60点");

let systemScoreSection = "";
if (systemScoreStr !== "N/A") {
  systemScoreSection += `### **システム全体品質スコア: ${systemScoreStr}**\n\n`;
  if (totalArchPenaltyCount > 0) {
    systemScoreSection += `#### ⚠️ アーキテクチャ大局減点 (-${totalArchPenaltyCount * archPenaltyWeight}点)\n`;
    for (const penalty of allArchPenalties) {
      systemScoreSection += `- ${penalty}\n`;
    }
    systemScoreSection += `\n`;
  }
}

const tableRows = reportsData.map(report => {
  const ev = report.evaluation;
  if (ev.isValid === false && ev.scoreText === "N/A") {
    return `| **${report.phase}** | ${report.title} | *N/A* | ${ev.status} | *除外* | ${report.files} |`;
  } else {
    const scoreDisp = ev.scoreValue === 0 ? "**<span style='color:red;'>0 / 100</span>**" : `**${ev.scoreText}**`;
    return `| **${report.phase}** | ${report.title} | ${scoreDisp} | **${ev.status}** | ${ev.issueText} | ${report.files} |`;
  }
});

const detailsBlock = reportsData.map(report => {
  return `---\n\n${report.content}\n`;
});

const reportPath = path.join(resolvedReviewDir, `${sessionId}-integrated-review-report_${date}.md`);

const finalContent = `# 統合コードレビュー・オーケストレーションレポート (Session ${sessionId})

作成日: ${formattedDate}

## 1. 品質評価サマリー (Quality Assurance Summary)

> **適用中の品質ゲート**: Level ${gateLevel} (合格ライン: **${gateLineText}** 以上)
> **自動算定アルゴリズム**: JSONメタデータに基づき、レッドカード（致命的欠陥による即時失格）、各カテゴリの乗算評価、およびシステム全体のアーキテクチャペナルティを厳格に算定しています。

${systemScoreSection}
| フェーズ | コンポーネント層 / タイトル | スコア | 判定 (Gate ${gateLevel}) | 検出ファクト件数 | 対象ファイル |
| :--- | :--- | :---: | :---: | :--- | :--- |
${tableRows.join('\n')}

* ※ **F**: Fatal(致命的), **M**: Major(重大), **m**: minor(軽微)

<br>

## 2. フェーズ別 詳細インスペクション

${detailsBlock.join('\n')}
`;

fs.writeFileSync(reportPath, finalContent, 'utf8');
console.log(`✅ 統合完了: ${matchedFiles.length}件の子レポートをマージし、スコアを自動計算しました。 (Gate Level: ${gateLevel})`);
console.log(`出力先: ${reportPath}`);
