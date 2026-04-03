#!/usr/bin/env node

/**
 * LUXXPOOL v0.8.1 — Run All Tests
 * Executes Emulation A+B, C, and D (full pool lifecycle)
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('═══════════════════════════════════════════════════════');
console.log(' LUXXPOOL v0.8.1 — FULL TEST SUITE');
console.log('═══════════════════════════════════════════════════════\n');

const tests = [
  { name: 'Emulation A+B (Mining Pipeline + Fleet)', file: 'emulation.js' },
  { name: 'Emulation C (Address · Security · Redis · VarDiff)', file: 'emulation-c.js' },
  { name: 'Emulation D (Full Pool Lifecycle · 40 Fleet L9s)', file: 'emulation-d.js' },
];

let totalPassed = 0;
let totalFailed = 0;
let allPassed = true;

for (const t of tests) {
  console.log(`\n▶ Running: ${t.name}`);
  console.log('─'.repeat(50));
  try {
    const output = execSync(`node ${path.join(__dirname, t.file)}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = output.match(/(\d+) passed, (\d+) failed/);
    if (match) {
      totalPassed += parseInt(match[1]);
      totalFailed += parseInt(match[2]);
      if (parseInt(match[2]) > 0) allPassed = false;
    }
    console.log(`  ✅ ${t.name}: ${match ? match[1] : '?'} passed`);
  } catch (err) {
    allPassed = false;
    const output = err.stdout || '';
    const match = output.match(/(\d+) passed, (\d+) failed/);
    if (match) {
      totalPassed += parseInt(match[1]);
      totalFailed += parseInt(match[2]);
    }
    console.log(`  ❌ ${t.name}: FAILED`);
  }
}

console.log('\n═══════════════════════════════════════════════════════');
console.log(` TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
console.log('═══════════════════════════════════════════════════════');
if (allPassed) {
  console.log('\n✅ ALL TEST SUITES PASSED');
} else {
  console.log('\n❌ SOME TESTS FAILED');
  process.exit(1);
}
