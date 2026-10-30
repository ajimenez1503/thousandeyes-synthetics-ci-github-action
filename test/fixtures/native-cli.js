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
if (process.env.FIXTURE_CASE === 'details') {
  tests = [{
    ...check('detailed-http', 'passed'), testId: '1001',
    agents: [{
      agentId: '6', roundId: '1700000000', status: 'passed',
      metrics: { responseCode: 401, responseTime: 156, totalTime: 160 },
      url: 'https://app.thousandeyes.com/view/tests?__a=123456&testId=1001&roundId=1700000000&agentId=6&token=drop-query#drop-fragment'
    }, {
      agentId: '7', roundId: '1700000000', status: 'passed',
      metrics: { responseCode: 401, responseTime: 0, totalTime: 0 },
      url: 'https://app.thousandeyes.eu/view/tests?testId=1001&agentId=7'
    }]
  }, {
    ...check('detailed-network', 'passed'), type: 'agent-to-server', testId: '1002',
    agents: [{
      agentId: '6', roundId: '1700000000', status: 'passed',
      metrics: { loss: 0, avgLatency: 14.073301, jitter: 0.09514871 },
      url: 'https://app.thousandeyes.gov/view/tests?testId=1002&agentId=6'
    }]
  }];
}
if (process.env.FIXTURE_CASE === 'multi-agent') {
  tests = [check('healthy-agents', 'passed'), check('blocking-agents', 'failed'),
    check('optional-agents', 'failed', 'non-blocking')].map((test) => ({
    ...test, agents: ['6', '7', '8'].map((agentId) => ({ agentId, status: test.status }))
  }));
}
if (process.env.FIXTURE_CASE === 'multi-agent-non-blocking') {
  tests = [check('healthy-agents', 'passed'), check('optional-agents', 'failed', 'non-blocking')].map((test) => ({
    ...test, agents: ['6', '7', '8'].map((agentId) => ({ agentId, status: test.status }))
  }));
}
if (process.env.FIXTURE_CASE === 'partial-agents') {
  tests = [{
    ...check('partial-agent-timeout', 'timed-out'), testId: '1003',
    message: 'execution deadline exceeded before all required measurements arrived',
    agents: [{
      agentId: '6', roundId: '1700000000', status: 'passed',
      metrics: { responseCode: 200, responseTime: 15, totalTime: 20 }
    }, {
      agentId: '7', status: 'timed-out', message: 'waiting for assigned agent measurements'
    }]
  }];
}
if (process.env.FIXTURE_CASE === 'unsafe-details') {
  tests = [{
    ...check('<img src=x onerror="alert(1)"> ' + process.env.TE_TOKEN, 'failed'), testId: '1004',
    message: '<script>test-message</script> ' + process.env.TE_TOKEN,
    agents: [{
      agentId: '6', roundId: '1700000000', status: 'failed',
      message: '<script>agent-message</script> ' + process.env.TE_TOKEN,
      metrics: { responseCode: 503, responseTime: 20, unknown: 'DO_NOT_RENDER_UNKNOWN_METRIC' },
      url: 'https://external.invalid/private-link-marker?token=' + process.env.TE_TOKEN
    }]
  }];
}
if (process.env.FIXTURE_CASE === 'unsafe-links') {
  const urls = [
    'http://app.thousandeyes.com/view/tests?testId=1001',
    'https://app.thousandeyes.com:443/view/tests?testId=1001',
    'https://user:secret@app.thousandeyes.com/view/tests?testId=1001',
    'https://app.thousandeyes.com.evil.invalid/view/tests?testId=1001',
    'https://external.invalid/view/tests?testId=1001',
    'https://app.thousandeyes.com/%76iew/tests?testId=1001',
    'https://app.thousandeyes.com/other/../view/tests?testId=1001',
    '//app.thousandeyes.com/view/tests?testId=1001',
    'javascript:alert("unsafe-link-marker")'
  ];
  tests = [{
    ...check('unsafe-result-links', 'passed'),
    agents: urls.map((url, index) => ({ agentId: String(index + 1), status: 'passed', url }))
  }];
}
if (process.env.FIXTURE_CASE === 'malformed-details') {
  tests = [{
    ...check('malformed-agent-details', 'passed'), message: { hidden: process.env.TE_TOKEN },
    agents: [{
      agentId: '6', status: 'passed',
      metrics: { responseCode: '401', responseTime: null, totalTime: 'NaN', unknown: 'DO_NOT_RENDER_UNKNOWN_METRIC' },
      message: { hidden: process.env.TE_TOKEN }, url: { hidden: process.env.TE_TOKEN }
    }, null, {
      agentId: { hidden: process.env.TE_TOKEN }, roundId: [], status: {}, metrics: 'not-a-metric-map'
    }]
  }, { ...check('malformed-agent-list', 'passed'), agents: { hidden: process.env.TE_TOKEN } }, {
    ...check('partial-network-metrics', 'passed'), type: 'agent-to-server',
    agents: [{ agentId: '6', status: 'passed', metrics: { loss: 0, avgLatency: 'NaN' } }]
  }];
}
if (process.env.FIXTURE_CASE === 'bounded-details') {
  tests = Array.from({ length: 25 }, (_, index) => ({
    ...check(`bounded-check-${index} ` + 'n'.repeat(1000) + '_NAME_END', 'passed'),
    testId: String(2000 + index),
    agents: Array.from({ length: 25 }, (_, agentIndex) => ({
      agentId: String(agentIndex + 1), roundId: '1700000000', status: 'passed',
      message: `Agent-row-${index}-${agentIndex} ` + '<&'.repeat(500) + '_MESSAGE_END',
      metrics: { responseCode: 200, responseTime: 10, totalTime: 20 }
    }))
  }));
}
if (process.env.FIXTURE_CASE === 'failure-priority') {
  tests = Array.from({ length: 25 }, (_, index) => check(`priority-passed-${index}`, 'passed'));
  tests.push({
    ...check('late-blocking-problem', 'failed'), testId: '3001',
    message: 'A blocking test appeared after the passed tests',
    agents: [...Array.from({ length: 25 }, (_, index) => ({
      agentId: String(index + 1), status: 'passed', message: `priority-passed-agent-${index}`
    })), {
      agentId: '99', status: 'failed', message: 'Critical-agent-measurement-failure',
      metrics: { responseCode: 503 }
    }]
  });
}
if (process.env.FIXTURE_CASE === 'tiny-measurements') {
  tests = [{
    ...check('tiny-http', 'passed'),
    agents: [{
      agentId: '6', status: 'passed',
      metrics: { responseCode: 200, responseTime: 0.0001234, totalTime: 0.0045 }
    }]
  }, {
    ...check('tiny-network', 'passed'), type: 'agent-to-server',
    agents: [{
      agentId: '6', status: 'passed',
      metrics: { loss: 0.0001234, avgLatency: 0.0000001234, jitter: 0.0000000001234 }
    }]
  }];
}
const report = {
  version: 1,
  runId: '0123456789abcdef01234567',
  startedAt: '2026-10-29T10:00:00Z',
  finishedAt: '2026-10-29T10:00:01Z',
  tests
};
if (process.env.FIXTURE_CASE === 'malformed-details') {
  report.startedAt = { invalid: true };
  report.finishedAt = 'not-a-time';
}
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
