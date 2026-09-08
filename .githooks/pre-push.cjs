#!/usr/bin/env node
// .githooks/pre-push — gitleaks + path scanner
// Blocks push if secrets are detected or sensitive files are tracked.
const { execSync } = require('child_process');
const { existsSync } = require('fs');

let failed = false;

// 1. Gitleaks scan
if (existsSync('.gitleaks.toml') || true) {
  try {
    console.log('🔍 Running gitleaks scan...');
    execSync('gitleaks detect --source . --verbose --redact', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('✅ Gitleaks: no leaks found');
  } catch (err) {
    if (err.status === 1) {
      console.error('\n❌ Pre-push BLOCKED: gitleaks detected secrets!');
      failed = true;
    } else {
      // gitleaks not installed or other error — warn but don't block
      console.log('⚠️  Gitleaks not available, skipping scan');
    }
  }
}

// 2. Path scanner — check tracked files
try {
  console.log('🔍 Checking tracked files for sensitive patterns...');
  const tracked = execSync('git ls-files', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n')
    .filter(Boolean);

  const BLOCKED = [
    /\.env$/i,
    /\.env\./i,
    /\.key$/i,
    /\.pem$/i,
    /\.p12$/i,
    /\.pfx$/i,
    /\.jks$/i,
    /git-credentials$/i,
    /\.netrc$/i,
    /\.clinerules$/i,
  ];

  const found = tracked.filter((f) => BLOCKED.some((re) => re.test(f)));

  if (found.length > 0) {
    console.error('\n❌ Pre-push BLOCKED: sensitive files in git index:');
    found.forEach((f) => console.error(`   ${f}`));
    console.error('\nAdd them to .gitignore and run: git rm --cached <file>\n');
    failed = true;
  } else {
    console.log('✅ Path scan: no sensitive files tracked');
  }
} catch (err) {
  console.error('Path scan error:', err.message);
}

if (failed) {
  process.exit(1);
}

console.log('✅ Pre-push checks passed');
process.exit(0);
