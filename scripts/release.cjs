#!/usr/bin/env node
// scripts/release.cjs — Automated release script for majrooo-mcp-devkit
// Usage: node scripts/release.cjs <version> [--dry-run]
// Example: node scripts/release.cjs 0.1.0
//          node scripts/release.cjs 0.2.0 --dry-run

const { execSync } = require('child_process');
const { existsSync } = require('fs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = args.find((a) => !a.startsWith('--'));

if (!version) {
  console.error('Usage: node scripts/release.cjs <version> [--dry-run]');
  console.error('Example: node scripts/release.cjs 0.1.0');
  process.exit(1);
}

const tag = `v${version}`;
const repo = 'Majrooo/majrooo-mcp-devkit';

function run(cmd) {
  console.log(`\n> ${cmd}`);
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function runOrDie(cmd) {
  try {
    return run(cmd);
  } catch (err) {
    console.error(`\n❌ Failed: ${cmd}`);
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

// --- Pre-flight checks ---

console.log(`\n🚀 Release ${tag} (${dryRun ? 'DRY RUN' : 'LIVE'})`);
console.log('='.repeat(50));

// 1. Check working tree is clean
console.log('\n📋 Checking working tree...');
const status = run('git status --porcelain');
if (status) {
  console.error('❌ Working tree is not clean. Commit or stash changes first.');
  console.error(status);
  process.exit(1);
}
console.log('✅ Working tree is clean');

// 2. Check we are on main
console.log('\n📋 Checking branch...');
const branch = run('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') {
  console.error(`❌ Not on main branch (currently on: ${branch})`);
  process.exit(1);
}
console.log(`✅ On branch: ${branch}`);

// 3. Check tag doesn't exist yet
console.log('\n📋 Checking tag...');
try {
  run(`git rev-parse ${tag}`);
  console.error(`❌ Tag ${tag} already exists`);
  process.exit(1);
} catch {
  console.log(`✅ Tag ${tag} does not exist yet`);
}

// 4. Build
console.log('\n📋 Building...');
try {
  runOrDie('npm run build');
  console.log('✅ Build passed');
} catch {
  console.error('❌ Build failed');
  process.exit(1);
}

// 5. Tests
console.log('\n📋 Running tests...');
try {
  const testOutput = runOrDie('npm test');
  console.log('✅ Tests passed');
} catch {
  console.error('❌ Tests failed');
  process.exit(1);
}

// 6. Find previous tag for changelog
console.log('\n📋 Finding previous tag...');
let previousTag = null;
try {
  previousTag = run('git describe --tags --abbrev=0');
  console.log(`✅ Previous tag: ${previousTag}`);
} catch {
  console.log('ℹ️  No previous tag found — will include all commits');
}

// 7. Read release notes from CHANGELOG.md
console.log('\n' + String.fromCodePoint(0x1F4CB) + ' Reading CHANGELOG.md...');
const { readFileSync } = require('fs');
let changelogContent;
try {
  changelogContent = readFileSync('CHANGELOG.md', 'utf8');
} catch (_e) {
  console.error('\u274C CHANGELOG.md not found');
  process.exit(1);
}

// Find the section for this version: ## [X.Y.Z] - DATE
const versionPattern = new RegExp(
  '## \\[' + version.replace(/\./g, '\\.') + '\\].*?\\n([\\s\\S]*?)(?=\\n## \\[|$)'
);
const match = changelogContent.match(versionPattern);

if (!match) {
  console.error('\u274C Version ' + version + ' not found in CHANGELOG.md');
  process.exit(1);
}

const changelogBody = match[1].trim();
const releaseNotes = '# ' + tag + '\n\n' + changelogBody + '\n';

console.log(releaseNotes);

// --- Execute ---

if (dryRun) {
  console.log('\n' + '='.repeat(50));
  console.log('🔍 DRY RUN — nothing was pushed');
  console.log(`   Would create tag: ${tag}`);
  console.log(`   Would create release on: ${repo}`);
  process.exit(0);
}

// 8. Create tag
console.log('\n📋 Creating tag...');
runOrDie(`git tag -a ${tag} -m "Release ${tag}"`);
console.log(`✅ Tag ${tag} created`);

// 9. Push tag
console.log('\n📋 Pushing tag...');
runOrDie(`git push origin ${tag}`);
console.log(`✅ Tag ${tag} pushed`);

// 10. Create GitHub Release
console.log('\n📋 Creating GitHub Release...');
const releaseFile = '_release_notes.md';
require('fs').writeFileSync(releaseFile, releaseNotes, 'utf8');
try {
  runOrDie(`gh release create ${tag} --title "${tag}" --notes-file ${releaseFile}`);
  console.log(`✅ GitHub Release ${tag} created`);
} finally {
  if (existsSync(releaseFile)) require('fs').unlinkSync(releaseFile);
}

console.log('\n' + '='.repeat(50));
console.log(`🎉 Release ${tag} complete!`);
console.log(`   https://github.com/${repo}/releases/tag/${tag}`);
