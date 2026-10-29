const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { installCLI } = require('./install');
const { XMLValidator, XMLParser } = require('fast-xml-parser');

const DEFAULT_VERSION = '0.0.1-next';
const DEFAULT_API = 'https://api.thousandeyes.com';

class ActionError extends Error {}

async function regularFile(filename, message) {
  try {
    const info = await fs.lstat(filename);
    if (info.isFile() && !info.isSymbolicLink()) return info;
  } catch {}
  throw new ActionError(message);
}

function apiBaseURL(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
        url.username || url.password || url.search || url.hash) throw new Error();
    return value;
  } catch {
    throw new ActionError('api-base-url must use HTTPS, or HTTP for a loopback test server, without credentials, query, or fragment.');
  }
}

function executeCLI(executable, args, options) {
  return new Promise((resolve, reject) => {
    // Reports are the integration contract. Raw child streams can contain
    // workflow-command text or configuration errors with sensitive values.
    const child = spawn(executable, args, { ...options, shell: false, stdio: 'ignore' });
    const forward = signal => { if (!child.killed) child.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    child.once('error', () => {
      cleanup();
      reject(new ActionError('Could not start the ThousandEyes CLI executable.'));
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
  });
}

async function readReport(filename) {
  const info = await regularFile(filename, 'The CLI did not produce a JSON report.');
  if (info.size > 8 * 1024 * 1024) throw new ActionError('The CLI JSON report exceeds the supported size.');
  let report;
  try { report = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { throw new ActionError('The CLI produced an invalid JSON report.'); }
  if (!report || report.version !== 1 || !/^[a-f0-9]{24}$/.test(report.runId) ||
      !Array.isArray(report.tests) || report.tests.length > 100) {
    throw new ActionError('The CLI produced an unsupported JSON report.');
  }
  const statuses = new Set(['passed', 'failed', 'skipped', 'timed-out', 'error']);
  const rules = new Set(['blocking', 'non-blocking', 'skipped']);
  for (const test of report.tests) {
    if (!test || typeof test.name !== 'string' || !statuses.has(test.status) ||
        !rules.has(test.executionRule) || !['http-server', 'agent-to-server'].includes(test.type)) {
      throw new ActionError('The CLI JSON report contains an unsupported test outcome.');
    }
  }
  return report;
}

async function validateJUnit(filename) {
  const info = await regularFile(filename, 'The CLI did not produce a JUnit report.');
  if (info.size === 0 || info.size > 8 * 1024 * 1024) throw new ActionError('The CLI produced an empty or oversized JUnit report.');
  try {
    const xml = await fs.readFile(filename, 'utf8');
    if (/<!DOCTYPE\b/.test(xml) || XMLValidator.validate(xml) !== true) throw new Error();
    const document = new XMLParser({ processEntities: false }).parse(xml);
    const roots = Object.keys(document).filter(key => !key.startsWith('?'));
    if (roots.length !== 1 || !['testsuite', 'testsuites'].includes(roots[0]) || Array.isArray(document[roots[0]])) throw new Error();
  } catch {
    throw new ActionError('The CLI produced an invalid JUnit XML report.');
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function writeSummary(core, report, exitCode, counts) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = report.tests.map(test => [escapeHTML(test.name), escapeHTML(test.type), escapeHTML(test.executionRule), escapeHTML(test.status)]);
  await core.summary
    .addHeading('ThousandEyes synthetic tests', 2)
    .addRaw(`CLI exit code: ${exitCode}\n\n`)
    .addRaw(`Run: <code>${report.runId}</code>\n\n`)
    .addRaw(`Passed: ${counts.passed}; failed: ${counts.failed}; non-blocking failures: ${counts['non-blocking-failed']}; skipped: ${counts.skipped}; timed out: ${counts['timed-out']}; errors: ${counts.errors}.\n\n`)
    .addTable([[{ data: 'Test', header: true }, { data: 'Type', header: true }, { data: 'Execution rule', header: true }, { data: 'Status', header: true }], ...rows])
    .write();
}

async function run(core) {
  const token = core.getInput('api-token');
  if (token) core.setSecret(token);
  if (!token) throw new ActionError('api-token is required; supply a GitHub secret.');
  const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const configPath = path.resolve(workspace, core.getInput('config-path') || 'thousandeyes-ci.json');
  await regularFile(configPath, 'config-path must reference an existing regular suite file.');
  const baseURL = apiBaseURL(core.getInput('api-base-url') || DEFAULT_API);
  const version = core.getInput('cli-version') || DEFAULT_VERSION;
  const overrides = ['account-group-id', 'timeout', 'poll-interval'].map(name => [name, core.getInput(name)]);
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'thousandeyes-synthetics-'));
  const jsonPath = path.join(root, 'results.json');
  const junitPath = path.join(root, 'results.xml');
  core.setOutput('json-report', jsonPath);
  core.setOutput('junit-report', junitPath);
  let executable = core.getInput('cli-path');
  if (executable) {
    if (!path.isAbsolute(executable)) throw new ActionError('cli-path must be an absolute executable path.');
    await regularFile(executable, 'cli-path must reference an existing regular executable file.');
  } else {
    try { executable = await installCLI({ version, tempDirectory: root }); }
    catch { throw new ActionError('Could not install the pinned ThousandEyes CLI release; check cli-version and release availability.'); }
  }
  const args = ['synthetics', 'run-tests', '--config', configPath, '--json-report', jsonPath, '--junit-report', junitPath, '--json'];
  for (const [name, value] of overrides) if (value) args.push(`--${name}`, value);
  const exitCode = await executeCLI(executable, args, {
    cwd: workspace,
    env: { ...process.env, TE_TOKEN: token, TE_BASE_URL: baseURL }
  });
  core.setOutput('exit-code', exitCode);
  const report = await readReport(jsonPath);
  await validateJUnit(junitPath);
  core.setOutput('run-id', report.runId);
  const counts = { passed: 0, failed: 0, 'non-blocking-failed': 0, skipped: 0, 'timed-out': 0, errors: 0 };
  for (const test of report.tests) {
    counts[test.status === 'error' ? 'errors' : test.status]++;
    if (test.status === 'failed' && test.executionRule === 'non-blocking') counts['non-blocking-failed']++;
  }
  for (const [name, count] of Object.entries(counts)) core.setOutput(name, count);
  await writeSummary(core, report, exitCode, counts);
  if (exitCode !== 0) {
    core.setFailed('ThousandEyes synthetic checks failed; inspect the JSON and JUnit reports.');
    process.exitCode = exitCode;
  }
}

module.exports = { run, ActionError };
