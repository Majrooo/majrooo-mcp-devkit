#!/usr/bin/env node
// .githooks/pre-commit — path scanner
// Blocks commits that include sensitive files.
const { execSync } = require('child_process');

const BLOCKED_PATTERNS = [
  /\.env$/i,
  /\.env\./i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /git-credentials$/i,
  /\.netrc$/i,
];

try {
  const staged = execSync('git diff --cached --name-only --diff-filter=ACM', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n')
    .filter(Boolean);

  if (staged.length === 0) {
    process.exit(0);
  }

  const blocked = staged.filter((f) =>
    BLOCKED_PATTERNS.some((re) => re.test(f))
  );

  if (blocked.length > 0) {
    console.error('\n❌ Pre-commit BLOCKED: sensitive files detected:');
    blocked.forEach((f) => console.error(`   ${f}`));
    console.error('\nAdd them to .gitignore or unstage with: git reset HEAD <file>\n');
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  console.error('Pre-commit hook error:', err.message);
  process.exit(0); // Don't block on hook errors
}
