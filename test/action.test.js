'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const entry = path.resolve(root, process.env.ACTION_ENTRY || 'src/index.js');
const fakeToken = 'fake-action-api-token-never-a-real-secret';

function outputs(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].indexOf('<<');
    if (marker !== -1) {
      const key = lines[i].slice(0, marker);
      const delimiter = lines[i].slice(marker + 2);
      const parts = [];
      while (++i < lines.length && lines[i] !== delimiter) parts.push(lines[i]);
      values[key] = parts.join('\n');
    } else {
      const equal = lines[i].indexOf('=');
      if (equal !== -1) values[lines[i].slice(0, equal)] = lines[i].slice(equal + 1);
    }
  }
  return values;
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'te-action-process-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace with spaces');
  const runnerTemp = path.join(dir, 'runner temp');
  await fs.mkdir(workspace);
  await fs.mkdir(runnerTemp);
  await fs.copyFile(path.join(__dirname, 'fixtures/native-cli.js'), path.join(workspace, 'synthetics'));
  const configName = 'suite with spaces ; $(echo injected).json';
  const configPath = path.join(workspace, configName);
  await fs.writeFile(configPath, '{"version":1,"tests":[]}');
  let invocation = 0;
  return {
    workspace,
    configName,
    configPath,
    async run(overrides = {}) {
      invocation++;
      const outputPath = path.join(dir, `outputs-${invocation}`);
      const summaryPath = path.join(dir, `summary-${invocation}`);
      const capturePath = path.join(dir, `capture-${invocation}.json`);
      await fs.writeFile(outputPath, '');
      await fs.writeFile(summaryPath, '');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUT_') && !['TE_TOKEN', 'TE_BASE_URL'].includes(key)));
      Object.assign(env, {
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        'INPUT_API-TOKEN': fakeToken,
        'INPUT_CONFIG-PATH': configName,
        'INPUT_CLI-PATH': process.execPath,
        FIXTURE_CAPTURE_PATH: capturePath,
        ...overrides
      });
      const processResult = spawnSync(process.execPath, [entry], {
        cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true
      });
      assert.ifError(processResult.error);
      const read = async (file) => fs.readFile(file, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const captureText = await read(capturePath);
      return {
        ...processResult,
        outputs: outputs(await read(outputPath)),
        summary: await read(summaryPath),
        capture: captureText ? JSON.parse(captureText) : null,
        visibleLog: `${processResult.stdout}\n${processResult.stderr}`.split(/\r?\n/).filter((line) => !line.startsWith('::add-mask::')).join('\n')
      };
    }
  };
}

function assertNoRawChildLogs(result) {
  assert.ok(!result.visibleLog.includes(fakeToken), 'token appears outside the mask protocol');
  assert.ok(!result.visibleLog.includes('RAW_CHILD_STDOUT'));
  assert.ok(!result.visibleLog.includes('RAW_CHILD_STDERR'));
}

function summaryText(result) {
  return result.summary.replace(/<[^>]*>/g, ' ');
}

function summaryLinks(result) {
  return [...result.summary.matchAll(/\bhref=(["'])(.*?)\1/g)]
    .map((match) => new URL(match[2].replaceAll('&amp;', '&')));
}

test('entrypoint executes the CLI safely and exposes durable report paths and test counts', async (t) => {
  const f = await fixture(t);
  const result = await f.run({
    'INPUT_ACCOUNT-GROUP-ID': '87757', 'INPUT_TIMEOUT': '2m',
    'INPUT_POLL-INTERVAL': '3s', 'INPUT_API-BASE-URL': 'https://api.stg.thousandeyes.com'
  });
  assert.equal(result.status, 0, result.visibleLog);
  assert.equal(result.capture.script, 'synthetics');
  // Windows may report an 8.3 path while the parent uses the long path.
  assert.equal(await fs.realpath(result.capture.cwd), await fs.realpath(f.workspace));
  assert.equal(result.capture.token, fakeToken);
  assert.equal(result.capture.apiBaseURL, 'https://api.stg.thousandeyes.com');
  assert.ok(!result.capture.args.includes(fakeToken));
  const value = (flag) => result.capture.args[result.capture.args.indexOf(flag) + 1];
  assert.equal(result.capture.args[0], 'run-tests');
  assert.equal(value('--config'), f.configPath);
  assert.equal(value('--account-group-id'), '87757');
  assert.equal(value('--timeout'), '2m');
  assert.equal(value('--poll-interval'), '3s');
  assert.equal(result.outputs['exit-code'], '0');
  assert.equal(result.outputs['run-id'], '0123456789abcdef01234567');
  assert.equal(result.outputs.passed, '2');
  assert.equal(result.outputs.failed, '0');
  assert.equal(result.outputs['non-blocking-failed'], '0');
  assert.equal(result.outputs.skipped, '0');
  assert.equal(result.outputs['timed-out'], '0');
  assert.equal(result.outputs.errors, '0');
  for (const name of ['json-report', 'junit-report']) {
    assert.ok(path.isAbsolute(result.outputs[name]));
    assert.ok((await fs.stat(result.outputs[name])).isFile());
  }
  assertNoRawChildLogs(result);
});

test('non-blocking failures remain visible while the CLI determines success', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'non-blocking' });
  assert.equal(result.status, 0, result.visibleLog);
  assert.equal(result.outputs.passed, '1');
  assert.equal(result.outputs.failed, '1');
  assert.equal(result.outputs['non-blocking-failed'], '1');
  assert.equal(result.outputs['exit-code'], '0');
});

test('nonzero CLI exits preserve reports, exit code, and test-level outcome counts', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'all-statuses', FIXTURE_EXIT_CODE: '7' });
  assert.equal(result.status, 7, result.visibleLog);
  assert.equal(result.outputs['exit-code'], '7');
  assert.equal(result.outputs.passed, '1');
  assert.equal(result.outputs.failed, '2');
  assert.equal(result.outputs['non-blocking-failed'], '1');
  assert.equal(result.outputs.skipped, '1');
  assert.equal(result.outputs['timed-out'], '1');
  assert.equal(result.outputs.errors, '1');
  assert.ok((await fs.stat(result.outputs['json-report'])).isFile());
  assert.ok(result.summary.length > 0);
  assertNoRawChildLogs(result);
});

test('report text cannot insert active HTML into the job summary', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'unsafe-name' });
  assert.equal(result.status, 0, result.visibleLog);
  assert.ok(!result.summary.includes('<script>'));
  assert.ok(!result.summary.includes('</script>'));
  assertNoRawChildLogs(result);
});

test('summary includes run timing, test identities, agent measurements, and approved result links', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'details' });
  assert.equal(result.status, 0, result.visibleLog);
  const text = summaryText(result);
  assert.match(text, /Agent measurements/);
  assert.match(text, /Duration:\s*1(?:\.0+)?\s*s\b/);
  assert.match(text, /Started:/);
  assert.match(text, /Finished:/);
  assert.ok(text.includes('2026-10-29T10:00:00'));
  assert.ok(text.includes('2026-10-29T10:00:01'));
  for (const value of ['1001', '1002', '1700000000']) assert.ok(text.includes(value));
  assert.match(text, /HTTP status:\s*401\b/);
  assert.match(text, /Response time:\s*156\s*ms\b/);
  assert.match(text, /Total time:\s*160\s*ms\b/);
  assert.match(text, /Response time:\s*0(?:\.0+)?\s*ms\b/);
  assert.match(text, /Packet loss:\s*0(?:\.0+)?\s*%/);
  assert.match(text, /Average RTT:\s*14\.07\s*ms\b/);
  assert.match(text, /Jitter:\s*0\.1(?:0)?\s*ms\b/);
  const links = summaryLinks(result);
  assert.equal(links.length, 3);
  assert.deepEqual(new Set(links.map((url) => url.hostname)), new Set([
    'app.thousandeyes.com', 'app.thousandeyes.eu', 'app.thousandeyes.gov'
  ]));
  for (const url of links) {
    assert.equal(url.protocol, 'https:');
    assert.equal(url.pathname, '/view/tests');
    assert.equal(url.hash, '');
    for (const [key, value] of url.searchParams) {
      assert.ok(['__a', 'testId', 'roundId', 'agentId'].includes(key));
      assert.match(value, /^\d+$/);
    }
  }
  assert.ok(!result.summary.includes('drop-query'));
  assert.ok(!result.summary.includes('drop-fragment'));
  assert.equal(result.outputs.passed, '2', 'summary details must not change test counts');
  assertNoRawChildLogs(result);
});

test('multiple agents count once per blocking or non-blocking suite test', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'multi-agent', FIXTURE_EXIT_CODE: '7' });
  assert.equal(result.status, 7, result.visibleLog);
  assert.equal(result.outputs.passed, '1');
  assert.equal(result.outputs.failed, '2');
  assert.equal(result.outputs['non-blocking-failed'], '1');
  assert.equal(result.outputs['exit-code'], '7');
  assertNoRawChildLogs(result);
});

test('multiple non-blocking failed agents preserve the successful CLI exit', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'multi-agent-non-blocking' });
  assert.equal(result.status, 0, result.visibleLog);
  assert.equal(result.outputs.passed, '1');
  assert.equal(result.outputs.failed, '1');
  assert.equal(result.outputs['non-blocking-failed'], '1');
  assert.equal(result.outputs['exit-code'], '0');
  assertNoRawChildLogs(result);
});

test('partial-agent timeout shows received measurements and missing-agent failure details', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'partial-agents', FIXTURE_EXIT_CODE: '1' });
  assert.equal(result.status, 1, result.visibleLog);
  assert.equal(result.outputs.passed, '0', 'a passed agent is not a passed suite test');
  assert.equal(result.outputs['timed-out'], '1');
  const text = summaryText(result);
  assert.match(text, /execution deadline exceeded before all required measurements arrived/);
  assert.match(text, /waiting for assigned agent measurements/);
  assert.match(text, /Response time:\s*15\s*ms/);
  assert.match(text, /Not reported/);
  assertNoRawChildLogs(result);
});

test('new summary details escape HTML, redact the API token, and ignore unknown metrics or links', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'unsafe-details', FIXTURE_EXIT_CODE: '1' });
  assert.equal(result.status, 1, result.visibleLog);
  assert.ok(!/<(?:script|img)\b/i.test(result.summary));
  assert.ok(result.summary.includes('&lt;script&gt;'));
  assert.ok(!result.summary.includes(fakeToken), 'summary must not contain the literal token');
  assert.ok(!result.summary.includes('DO_NOT_RENDER_UNKNOWN_METRIC'));
  assert.ok(!result.summary.includes('external.invalid'));
  assert.ok(!result.summary.includes('private-link-marker'));
  assert.match(summaryText(result), /HTTP status:\s*503\b/);
  assertNoRawChildLogs(result);
});

test('unapproved or ambiguous result URLs are omitted without echoing their text', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'unsafe-links' });
  assert.equal(result.status, 0, result.visibleLog);
  assert.equal(summaryLinks(result).length, 0);
  for (const value of ['http://', ':443/view', 'user:secret', 'evil.invalid', 'external.invalid', '%76iew', 'other/../view', 'javascript:', 'unsafe-link-marker']) {
    assert.ok(!result.summary.includes(value), value);
  }
  assertNoRawChildLogs(result);
});

test('malformed optional detail fields remain harmless and never become invented measurements', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'malformed-details' });
  assert.equal(result.status, 0, result.visibleLog);
  assert.equal(result.outputs.passed, '3');
  const text = summaryText(result);
  for (const label of ['HTTP status', 'Response time', 'Total time', 'Average RTT', 'Jitter']) {
    assert.match(text, new RegExp(`${label}:\\s*Not reported`), `${label} explicitly marks missing data`);
  }
  assert.match(text, /Packet loss:\s*0(?:\.0+)?\s*%/, 'reported zero remains visible beside missing network metrics');
  assert.ok(!/HTTP status:\s*401\b/.test(text), 'string-valued status is not a numeric measurement');
  assert.ok(!/Response time:\s*0(?:\.0+)?\s*ms\b/.test(text), 'missing time is not zero');
  assert.ok(!/Total time:\s*0(?:\.0+)?\s*ms\b/.test(text), 'NaN time is not zero');
  assert.ok(!result.summary.includes(fakeToken));
  assert.ok(!result.summary.includes('[object Object]'));
  assert.ok(!result.summary.includes('DO_NOT_RENDER_UNKNOWN_METRIC'));
  assertNoRawChildLogs(result);
});

test('large detailed summaries bound text, tests, per-test agents, and total agent rows', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'bounded-details' });
  assert.equal(result.status, 0, result.visibleLog);
  assert.equal(result.outputs.passed, '25', 'counts include all tests, regardless of displayed detail limits');
  const text = summaryText(result);
  assert.ok(Buffer.byteLength(result.summary, 'utf8') <= 512 * 1024);
  assert.match(text, /Showing\s+20\s+of\s+25/i);
  assert.ok(result.summary.includes('Agent-row-0-19'));
  assert.ok(!result.summary.includes('Agent-row-0-20'), 'show at most 20 agents per test');
  assert.ok(!result.summary.includes('Agent-row-5-0'), 'show at most 100 agent rows overall');
  const displayedRows = result.summary.match(/Agent-row-\d+-\d+/g) || [];
  assert.ok(displayedRows.length > 0 && displayedRows.length <= 100);
  assert.ok(!result.summary.includes('_NAME_END'), 'long names are truncated');
  assert.ok(!result.summary.includes('_MESSAGE_END'), 'long messages are truncated');
  assertNoRawChildLogs(result);
});

test('bounded details prioritize a late failed test and its late failed agent', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'failure-priority', FIXTURE_EXIT_CODE: '1' });
  assert.equal(result.status, 1, result.visibleLog);
  assert.equal(result.outputs.passed, '25');
  assert.equal(result.outputs.failed, '1');
  const headings = [...result.summary.matchAll(/<h3>(.*?)<\/h3>/g)].map(match => match[1]);
  assert.equal(headings[0], 'late-blocking-problem', 'a failed test after 25 passes gets detailed first');
  assert.ok(result.summary.includes('Critical-agent-measurement-failure'), 'a failed agent after 25 passes remains visible');
  assertNoRawChildLogs(result);
});

test('small positive measurements retain their magnitude instead of rounding to zero', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ FIXTURE_CASE: 'tiny-measurements' });
  assert.equal(result.status, 0, result.visibleLog);
  const text = summaryText(result);
  for (const [label, expected, unit] of [
    ['Response time', 0.0001234, 'ms'],
    ['Total time', 0.0045, 'ms'],
    ['Packet loss', 0.0001234, '%'],
    ['Average RTT', 0.0000001234, 'ms'],
    ['Jitter', 0.0000000001234, 'ms']
  ]) {
    const match = text.match(new RegExp(`${label}:\\s*([0-9.eE+-]+)\\s*${unit}`));
    assert.ok(match, `${label} includes its numeric measurement and unit`);
    const displayed = Number(match[1]);
    assert.ok(displayed > 0, `${label} must not become zero`);
    assert.ok(Math.abs(displayed - expected) / expected < 0.01, `${label} retains the measured magnitude`);
  }
  assertNoRawChildLogs(result);
});

test('each invocation gets unique report paths and the API base ignores ambient TE_BASE_URL', async (t) => {
  const f = await fixture(t);
  const first = await f.run({ TE_BASE_URL: 'https://untrusted.invalid' });
  const second = await f.run();
  assert.equal(first.status, 0, first.visibleLog);
  assert.equal(second.status, 0, second.visibleLog);
  assert.equal(first.capture.apiBaseURL, 'https://api.thousandeyes.com');
  assert.notEqual(first.outputs['json-report'], second.outputs['json-report']);
  assert.notEqual(first.outputs['junit-report'], second.outputs['junit-report']);
});

for (const [name, override] of [
  ['missing API token', { 'INPUT_API-TOKEN': '' }],
  ['missing suite', { 'INPUT_CONFIG-PATH': 'does-not-exist.json' }],
  ['missing executable', { 'INPUT_CLI-PATH': path.join(os.tmpdir(), 'te-does-not-exist-41505') }],
  ['API base containing credentials', { 'INPUT_API-BASE-URL': 'https://user:password@example.invalid' }]
]) {
  test(`${name} fails before starting the CLI`, async (t) => {
    const f = await fixture(t);
    const result = await f.run(override);
    assert.notEqual(result.status, 0, result.visibleLog);
    assert.equal(result.capture, null);
    assert.ok(result.visibleLog.includes('::error::'), 'Action should emit an actionable failure annotation');
    assertNoRawChildLogs(result);
  });
}

for (const [name, override] of [
  ['missing JSON report', { FIXTURE_NO_REPORT: '1' }],
  ['malformed JSON report', { FIXTURE_MALFORMED_REPORT: '1' }],
  ['unsupported report version', { FIXTURE_BAD_REPORT: 'version' }],
  ['unrecognized report status', { FIXTURE_BAD_REPORT: 'status' }],
  ['missing JUnit report', { FIXTURE_MISSING_JUNIT: '1' }],
  ['empty JUnit report', { FIXTURE_BAD_JUNIT: 'empty' }],
  ['malformed JUnit XML', { FIXTURE_BAD_JUNIT: 'malformed' }],
  ['non-JUnit XML root', { FIXTURE_BAD_JUNIT: 'root' }],
  ['duplicate testsuite roots', { FIXTURE_BAD_JUNIT: 'duplicate-suite' }],
  ['duplicate testsuites roots', { FIXTURE_BAD_JUNIT: 'duplicate-suites' }]
]) {
  test(`${name} cannot turn a successful process into a passing Action`, async (t) => {
    const f = await fixture(t);
    const result = await f.run(override);
    assert.notEqual(result.status, 0, result.visibleLog);
    assert.ok(result.capture, 'CLI must have executed');
    assertNoRawChildLogs(result);
  });
}
