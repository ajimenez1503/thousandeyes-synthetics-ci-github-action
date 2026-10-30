'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { installCLI, releaseAsset, checksumForAsset } = require('../src/install');

const VERSION = '1.2.3';
const ARCHIVE = Buffer.from('checksummed CLI archive');
const SHA256 = crypto.createHash('sha256').update(ARCHIVE).digest('hex');

async function harness(t, options = {}) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-action-installer-test-'));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  const platform = options.platform || 'linux';
  const arch = options.arch || 'x64';
  const version = options.version || VERSION;
  const asset = releaseAsset(version, platform, arch);
  const calls = { download: [], extract: [] };
  return {
    calls,
    options: {
      version,
      tempDirectory,
      platform,
      arch,
      download: async (url, destination) => {
        calls.download.push({ url, destination });
        const content = url.endsWith('checksums.txt')
          ? (options.manifest ?? `${SHA256}  ${asset.archiveName}\n`)
          : (options.archive ?? ARCHIVE);
        if (options.downloadError) throw new Error(options.downloadError);
        await fs.writeFile(destination, content);
        return destination;
      },
      extract: async (archive, destination, format) => {
        calls.extract.push({ archive, destination, format });
        if (options.extractError) throw new Error(options.extractError);
        await fs.mkdir(destination, { recursive: true });
        if (options.binary === 'missing') return destination;
        const binary = path.join(destination, asset.binaryName);
        if (options.binary === 'directory') await fs.mkdir(binary);
        else if (options.binary === 'symlink') {
          const other = path.join(destination, 'other');
          await fs.writeFile(other, 'other');
          await fs.symlink(other, binary);
        } else await fs.writeFile(binary, 'CLI executable', { mode: 0o600 });
        return destination;
      },
    },
  };
}

for (const [platform, arch, osName, archiveArch, extension, binaryName] of [
  ['linux', 'x64', 'Linux', 'x86_64', 'tar.gz', 'thousandeyes'],
  ['linux', 'arm64', 'Linux', 'arm64', 'tar.gz', 'thousandeyes'],
  ['darwin', 'x64', 'Darwin', 'x86_64', 'tar.gz', 'thousandeyes'],
  ['darwin', 'arm64', 'Darwin', 'arm64', 'tar.gz', 'thousandeyes'],
  ['win32', 'x64', 'Windows', 'x86_64', 'zip', 'thousandeyes.exe'],
  ['win32', 'arm64', 'Windows', 'arm64', 'zip', 'thousandeyes.exe'],
]) {
  test(`installs the exact checksummed ${platform}/${arch} release asset`, async (t) => {
    const h = await harness(t, { platform, arch });
    const executable = await installCLI(h.options);
    assert.equal(path.isAbsolute(executable), true);
    assert.equal(path.basename(executable), binaryName);
    const file = await fs.lstat(executable);
    assert.equal(file.isFile(), true);
    // Windows does not expose POSIX executable bits, even for emulated targets.
    if (platform !== 'win32' && process.platform !== 'win32') assert.notEqual(file.mode & 0o111, 0);
    assert.equal(h.calls.download.length, 2);
    assert.equal(h.calls.download[0].url,
      `https://github.com/ajimenez1503/thousandeyes-cli/releases/download/${VERSION}/thousandeyes_${VERSION}_checksums.txt`);
    assert.equal(h.calls.download[1].url,
      `https://github.com/ajimenez1503/thousandeyes-cli/releases/download/${VERSION}/thousandeyes_${VERSION}_${osName}_${archiveArch}.${extension}`);
    assert.equal(h.calls.extract[0].format, extension);
    assert.equal(h.calls.extract.length, 1);
  });
}

for (const version of ['', 'latest', 'v1.2.3', '1.2', '1.2.3+build', '../1.2.3', '1.2.3\n', '1.2.3;echo injected', '01.2.3', '1.2.3-01']) {
  test(`rejects an unpinned or malformed CLI version ${JSON.stringify(version)}`, async () => {
    let downloaded = false;
    await assert.rejects(installCLI({ version, tempDirectory: os.tmpdir(), download: async () => { downloaded = true; } }), /version/i);
    assert.equal(downloaded, false);
  });
}

test('rejects unsupported platform or architecture before download', async () => {
  for (const [platform, arch] of [['freebsd', 'x64'], ['linux', 'ia32']]) {
    await assert.rejects(installCLI({ version: VERSION, tempDirectory: os.tmpdir(), platform, arch }), /platform|architecture/i);
  }
});

test('does not extract an archive whose checksum differs', async (t) => {
  const h = await harness(t, { archive: 'tampered archive' });
  await assert.rejects(installCLI(h.options), /checksum/i);
  assert.equal(h.calls.extract.length, 0);
});

for (const manifest of [
  'not a checksum\n',
  `${'a'.repeat(64)}  another-archive.tar.gz\n`,
  `${SHA256}  thousandeyes_${VERSION}_Linux_x86_64.tar.gz\n${SHA256}  thousandeyes_${VERSION}_Linux_x86_64.tar.gz\n`,
  `${SHA256}  thousandeyes_${VERSION}_Linux_x86_64.tar.gz.extra\n`,
  `${SHA256}  thousandeyes_${VERSION}_Linux_x86_64.tar.gz\nmalformed other entry\n`,
]) {
  test('rejects malformed, missing, duplicate, or nonexact checksum entries before extraction', async (t) => {
    const h = await harness(t, { manifest });
    await assert.rejects(installCLI(h.options), /checksum/i);
    assert.equal(h.calls.extract.length, 0);
  });
}

test('accepts CRLF manifests and a binary marker without weakening exact filename matching', () => {
  const name = `thousandeyes_${VERSION}_Linux_x86_64.tar.gz`;
  assert.equal(checksumForAsset(`${SHA256.toUpperCase()} *${name}\r\n`, name), SHA256);
});

for (const binary of ['missing', 'directory', 'symlink']) {
  test(`rejects a ${binary} executable`, async (t) => {
    const h = await harness(t, { binary });
    await assert.rejects(installCLI(h.options), /regular executable/i);
  });
}

test('hides network and extraction error contents', async (t) => {
  const sensitive = 'Authorization Bearer fake-secret https://private.example.invalid/path';
  for (const failure of [{ downloadError: sensitive }, { extractError: sensitive }]) {
    const h = await harness(t, failure);
    await assert.rejects(installCLI(h.options), (error) => {
      assert.equal(error.message.includes('fake-secret'), false);
      assert.equal(error.message.includes('private.example.invalid'), false);
      return true;
    });
  }
});

test('does not change PATH while installing', async (t) => {
  const initialPath = process.env.PATH;
  const h = await harness(t);
  await installCLI(h.options);
  assert.equal(process.env.PATH, initialPath);
});


for (const version of ['0.0.1-next', '0.0.2-next']) {
  test(`rejects a changed pinned ${version} manifest before downloading the archive`, async (t) => {
    const h = await harness(t, { version });
    await assert.rejects(installCLI(h.options), /pinned.*manifest.*checksum/i);
    assert.equal(h.calls.download.length, 1);
    assert.equal(h.calls.extract.length, 0);
  });
}

test('accepts a reviewed pinned manifest before checking the selected archive bytes', async (t) => {
  const manifest = [
    '32d0de8c604c23507c63a1cec30289025073a556d2660c81bbbaa22dc68c8f20  thousandeyes_0.0.1-next_Darwin_arm64.tar.gz',
    '549bb9e19795927e9c76baf8624de94190235f57de015326777e74cbad5b795c  thousandeyes_0.0.1-next_Darwin_x86_64.tar.gz',
    'd61301935889be661dee1c80dfbc0c8c3c5e813a31b02a8760668aa548e5a1ac  thousandeyes_0.0.1-next_Linux_arm64.tar.gz',
    '80222ea7a3f04b7da2fafbc26bd1656f488a0aff993d616788024371562bbdbd  thousandeyes_0.0.1-next_Linux_x86_64.tar.gz',
    '63cae6ccf482334bd4971b6aaed62535413b041e0613a29450b6b9f83966e701  thousandeyes_0.0.1-next_Windows_arm64.zip',
    '9177280cde422f740447e142cd1b1afe2bc110915fa9f5e5762c1f89c2480161  thousandeyes_0.0.1-next_Windows_x86_64.zip',
    '',
  ].join('\n');
  const h = await harness(t, { version: '0.0.1-next', manifest });
  await assert.rejects(installCLI(h.options), /archive checksum did not match/i);
  assert.equal(h.calls.download.length, 2);
  assert.equal(h.calls.extract.length, 0);
});
