#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let sessionId = '001';
let lang = 'csharp';
let phase = 'Unknown';
let filesStr = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' || args[i] === '-s') sessionId = args[++i];
  else if (args[i] === '--lang' || args[i] === '-l') lang = args[++i];
  else if (args[i] === '--phase' || args[i] === '-p') phase = args[++i];
  else if (args[i] === '--files' || args[i] === '-f') filesStr = args[++i];
}

const projectRoot = process.cwd();
const packageDir = path.join(__dirname, '..');
const tmpDir = path.resolve(projectRoot, 'tmp/code-reviews');

if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// 1. プロンプトのマージ処理
let outputMarkdown = [];
const corePath = path.join(packageDir, 'skills', 'code-review', 'SKILL.md');
if (fs.existsSync(corePath)) {
  const rawContent = fs.readFileSync(corePath, 'utf8');
  const cleanContent = rawContent.replace(/^---[\s\S]*?---\r?\n?/, '');
  outputMarkdown.push(cleanContent);
} else {
  console.error(`Error: Core prompt not found at ${corePath}`);
  process.exit(1);
}

const langPath = path.join(packageDir, 'specs', `lang-${lang}.prompt.md`);
if (fs.existsSync(langPath)) {
  outputMarkdown.push(fs.readFileSync(langPath, 'utf8'));
}

const projectSpecsDir = path.join(projectRoot, 'specs');
const projPattern = /proj-.*\.prompt\.md$/;
let matchedProjSpec = null;
if (fs.existsSync(projectSpecsDir)) {
  const files = fs.readdirSync(projectSpecsDir);
  for (const file of files) {
    if (projPattern.test(file)) {
      const projPath = path.join(projectSpecsDir, file);
      outputMarkdown.push(fs.readFileSync(projPath, 'utf8'));
      matchedProjSpec = path.relative(projectRoot, projPath);
    }
  }
}

// 結合プロンプトを物理ファイルとして出力
const promptFile = path.join(tmpDir, `${sessionId}-combined-system.prompt.md`);
fs.writeFileSync(promptFile, outputMarkdown.join('\n\n'), 'utf8');

// 2. アクティブ・コンテキスト (JSON) の出力
const targetFiles = filesStr ? filesStr.split(',').map(f => f.trim()) : [];
const now = new Date();
const timestamp = now.getFullYear() + 
  String(now.getMonth() + 1).padStart(2, '0') + 
  String(now.getDate()).padStart(2, '0') + '_' +
  String(now.getHours()).padStart(2, '0') +
  String(now.getMinutes()).padStart(2, '0') +
  String(now.getSeconds()).padStart(2, '0');

const contextData = {
  sessionId,
  timestamp,
  targetRepository: path.basename(projectRoot),
  targetFiles,
  appliedSpecs: {
    core: path.relative(projectRoot, corePath),
    language: fs.existsSync(langPath) ? path.relative(projectRoot, langPath) : null,
    project: matchedProjSpec
  },
  currentPhase: phase,
  status: "In-Progress"
};

const contextFile = path.join(tmpDir, `${sessionId}-active-context.json`);
fs.writeFileSync(contextFile, JSON.stringify(contextData, null, 2), 'utf8');

console.log(`Successfully generated dynamic contexts:`);
console.log(`- State JSON: ${contextFile}`);
console.log(`- Combined Prompt: ${promptFile}`);
