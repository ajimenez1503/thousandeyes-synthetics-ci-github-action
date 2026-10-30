'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const cases = [
    ['HEALTHY', 'success', ['passed', 'passed']],
    ['BLOCKING', 'failure', ['failed']],
    ['NON_BLOCKING', 'success', ['failed']],
    ['INCOMPLETE', 'failure', ['timed-out']]
  ];
  const paths = [];
  const runs = [];
  for (const [name, outcome, statuses] of cases) {
    assert.equal(process.env[`${name}_OUTCOME`], outcome, `${name} step outcome`);
    const reportPath = process.env[`${name}_REPORT`];
    assert.ok(reportPath, `${name} report path output`);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.version, 1);
    assert.match(report.runId, /^[a-f0-9]{24}$/);
    assert.deepEqual(report.tests.map((test) => test.status), statuses, `${name} test statuses`);
    assert.ok(report.tests.every((test) => test.agents.length === 2), `${name} covers both assigned agents`);
    if (name === 'NON_BLOCKING') assert.equal(report.tests[0].executionRule, 'non-blocking');
    const junitPath = process.env[`${name}_JUNIT`] || path.join(path.dirname(reportPath), 'results.xml');
    const xml = await fs.readFile(junitPath, 'utf8');
    assert.ok(xml.includes('<testsuite') && xml.includes('</testsuite>'), `${name} JUnit report`);
    if (name === 'HEALTHY') assert.ok(!/<(?:failure|error)\b/.test(xml));
    if (name === 'BLOCKING' || name === 'NON_BLOCKING') assert.ok(xml.includes('<failure'), `${name} assertion appears in JUnit`);
    if (name === 'INCOMPLETE') assert.ok(xml.includes('<error'), 'timeout appears as JUnit error');
    paths.push(reportPath);
    runs.push(report.runId);
  }
  assert.equal(new Set(paths).size, cases.length, 'Each invocation uses a distinct report path');
  assert.equal(new Set(runs).size, cases.length, 'Each invocation creates a distinct CLI run');
  console.log('Real CLI mock smoke passed: healthy, blocking failure, non-blocking failure, and incomplete measurements.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
