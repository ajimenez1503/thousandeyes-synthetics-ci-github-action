'use strict';

const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const capture = {
  args,
  script: path.basename(process.argv[1]),
  token: process.env.TE_TOKEN,
  apiBaseURL: process.env.TE_BASE_URL,
  cwd: process.cwd()
};
fs.writeFileSync(process.env.FIXTURE_CAPTURE_PATH, JSON.stringify(capture));

const agent = (status) => ({ agentId: '6', status });
const check = (name, status, executionRule = 'blocking') => ({
  name, type: 'http-server', executionRule, status, agents: [agent(status)]
});
let tests = [check('http-check', 'passed'), {
  ...check('network-check', 'passed'), type: 'agent-to-server'
}];
if (process.env.FIXTURE_CASE === 'non-blocking') {
  tests = [check('healthy', 'passed'), check('optional', 'failed', 'non-blocking')];
}
if (process.env.FIXTURE_CASE === 'all-statuses') {
  tests = [check('healthy', 'passed'), check('blocking failure', 'failed'),
    check('optional failure', 'failed', 'non-blocking'), check('ignored', 'skipped'),
    check('late', 'timed-out'), check('broken', 'error')];
}
if (process.env.FIXTURE_CASE === 'unsafe-name') {
  tests = [check('<script>alert("x")</script> | ::error:: forged', 'passed')];
}
const report = {
  version: 1,
  runId: '0123456789abcdef01234567',
  startedAt: '2026-10-29T10:00:00Z',
  finishedAt: '2026-10-29T10:00:01Z',
  tests
};
if (process.env.FIXTURE_BAD_REPORT === 'version') report.version = 2;
if (process.env.FIXTURE_BAD_REPORT === 'status') report.tests[0].status = 'unknown';
const jsonPath = value('--json-report');
const junitPath = value('--junit-report');
if (!process.env.FIXTURE_NO_REPORT) {
  fs.writeFileSync(jsonPath, process.env.FIXTURE_MALFORMED_REPORT ? '{broken' : JSON.stringify(report));
}
if (!process.env.FIXTURE_MISSING_JUNIT) {
  const invalidXML = {
    empty: '',
    malformed: '<testsuite><broken>',
    root: '<not-junit/>',
    'duplicate-suite': '<testsuite/><testsuite/>',
    'duplicate-suites': '<testsuites/><testsuites/>'
  };
  const xml = Object.hasOwn(invalidXML, process.env.FIXTURE_BAD_JUNIT)
    ? invalidXML[process.env.FIXTURE_BAD_JUNIT]
    : '<testsuite name="fixture" tests="1"><testcase name="fixture"/></testsuite>';
  fs.writeFileSync(junitPath, xml);
}
// Raw child streams must never become workflow commands or leak credentials.
console.log('::error::RAW_CHILD_STDOUT ' + process.env.TE_TOKEN);
console.error('RAW_CHILD_STDERR ' + process.env.TE_TOKEN);
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || '0');
