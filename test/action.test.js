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

test('entrypoint executes the CLI safely and exposes durable report paths and test counts', async (t) => {
  const f = await fixture(t);
  const result = await f.run({
    'INPUT_ACCOUNT-GROUP-ID': '87757', 'INPUT_TIMEOUT': '2m',
    'INPUT_POLL-INTERVAL': '3s', 'INPUT_API-BASE-URL': 'https://api.stg.thousandeyes.com'
  });
  assert.equal(result.status, 0, result.visibleLog);
  assert.equal(result.capture.script, 'synthetics');
  assert.equal(result.capture.cwd, await fs.realpath(f.workspace));
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
