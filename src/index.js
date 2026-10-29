const { run, ActionError } = require('./action');

async function main() {
  const core = await import('@actions/core');
  try { await run(core); }
  catch (error) {
    core.setFailed(error instanceof ActionError ? error.message : 'The ThousandEyes Action could not complete.');
  }
}

main().catch(() => {
  // Toolkit initialization itself can fail before workflow annotations exist.
  process.stderr.write('The ThousandEyes Action could not initialize.\n');
  process.exitCode = 1;
});
