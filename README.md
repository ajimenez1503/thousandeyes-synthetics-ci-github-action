# ThousandEyes Synthetic CI Action

Run ThousandEyes instant tests from GitHub Actions using the same [`thousandeyes synthetics run-tests` CLI](https://github.com/ajimenez1503/thousandeyes-cli) used by terminals, other CI systems, and Argo Rollouts.

The Action installs a pinned CLI release, passes your suite and overrides to it, and exposes the CLI outcome, reports, and a job summary. The CLI handles test creation, polling, completeness, assertions, and execution rules.

This is a preview in a personal account. It currently supports the CLI's `http-server` and `agent-to-server` instant tests. Cloud or Enterprise Agents perform the measurements. Private targets need an Enterprise Agent that can reach them.

## Use the Action

Check out your repository and store the ThousandEyes API token in a GitHub secret named `TE_TOKEN`:

```yaml
name: Synthetic checks
on: [workflow_dispatch]
permissions:
  contents: read
jobs:
  synthetics:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
      - name: Run synthetic checks
        id: synthetics
        uses: ajimenez1503/thousandeyes-synthetics-ci-github-action@main
        with:
          api-token: ${{ secrets.TE_TOKEN }}
          config-path: thousandeyes-ci.json
      - name: Save reports
        if: always()
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7
        with:
          name: thousandeyes-results
          path: |
            ${{ steps.synthetics.outputs.json-report }}
            ${{ steps.synthetics.outputs.junit-report }}
          if-no-files-found: warn
```

The `main` reference is for this preview. Pin the Action to a reviewed full commit SHA for a fixed implementation. A stable Action version tag and GitHub Marketplace listing are not published yet.

Copy [`examples/thousandeyes-ci.json`](examples/thousandeyes-ci.json), then replace the account group, agent IDs, target, and thresholds with your values. Each invocation creates new instant tests and consumes applicable ThousandEyes units. The Action does not modify scheduled tests.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `api-token` | Required | ThousandEyes API bearer token, supplied from a secret. |
| `config-path` | `thousandeyes-ci.json` | Suite JSON file, relative to the checked-out workspace or absolute. |
| `cli-version` | `0.0.2-next` | Exact release from `ajimenez1503/thousandeyes-cli`. Floating `latest` is rejected. |
| `cli-path` | Empty | Absolute path to an explicitly managed CLI executable; bypasses downloading. |
| `account-group-id` | Suite value | Override the suite account group. |
| `timeout` | Suite value | Override the suite deadline, for example `5m`. |
| `poll-interval` | Suite value | Override polling, for example `5s`. |
| `api-base-url` | `https://api.thousandeyes.com` | Override the API origin for a controlled environment. HTTPS is required except for loopback test servers. |

Linux, macOS, and Windows runners on x64 or arm64 have matching CLI assets. The runner must support Node24 JavaScript Actions and have network access to GitHub release assets and the configured ThousandEyes API. No Go or npm installation is needed by consumers.

Downloaded archives are checked against the release SHA-256 manifest before extraction. The default release also pins the manifest digest in the Action source. The initial prerelease contains the verified snapshot from CLI commit `14630a61551cc2fb3adbcfc52a2139ba2581aa34`, whose source tree matches merged `main` commit `5448e6e99e2a662756619a7f7a2cf1af81f1b5e9`.

## Outputs and failures

| Output | Meaning |
| --- | --- |
| `run-id` | CLI execution identity, when a valid report exists. |
| `exit-code` | Actual CLI exit code, when execution completed. Wrapper errors can fail the step before a CLI exit exists. |
| `json-report`, `junit-report` | Unique absolute report paths under the runner's temporary directory. A path is reserved before execution; a file exists only if the CLI produced it. |
| `passed`, `failed`, `skipped`, `timed-out`, `errors` | Counts of suite tests with each outcome, not agent counts. |
| `non-blocking-failed` | Subset of `failed` with the non-blocking rule. |

The job summary includes run timestamps and duration, the test overview, each test's sanitized target, and per-test agent tables with names and test/agent/round IDs, HTTP status and timings, network loss/RTT/jitter, failure messages, and approved ThousandEyes result links when the report provides them. Missing metadata and measurements are shown as `Not reported`. The summary uses the CLI report and does not read target credentials or native request payloads from the suite. Targets are displayed as text; HTTP user information, query strings, and fragments are removed.

The pinned [`0.0.2-next` CLI release](https://github.com/ajimenez1503/thousandeyes-cli/releases/tag/0.0.2-next) includes the optional version 1 `agentName` and `target` report fields. Older reports remain supported and show `Not reported` for unavailable metadata.

Detailed tables reserve rows for failed, timed-out, and errored agents across selected tests before displaying passing agents. Details are bounded to 20 tests, 20 agents per test, and 100 agent rows overall. Control characters and line separators are removed before token redaction, truncation, and HTML escaping so report values remain text. Omission notices point readers to the full JSON/JUnit artifacts. Completed run summaries do not change when the Action is updated; start a new run using the new Action commit to see the enhanced summary.

The Action preserves the CLI's exit decision. Blocking failures, timeouts, and execution errors fail the step. A non-blocking assertion failure stays visible in reports and counts while the CLI can still exit successfully. JUnit includes that failure, so an independent JUnit gate must account for the rule. Missing or unsupported JSON reports and missing, empty, or malformed JUnit reports fail the Action.

Use GitHub's `continue-on-error` on the Action step if your workflow intentionally records a failed check without failing its job. Use `if: always()` on report upload steps. Outputs remain available after CLI check failures when reports were produced.

The token is masked and passed through the child environment as `TE_TOKEN`. It is never a command argument. The Action does not forward raw child stdout or stderr, because these can contain configuration values or workflow-command text. It uses the CLI's sanitized reports for the summary. Configuration errors that occur before reports exist produce a failed step with a generic diagnostic; reproduce with the same CLI locally for further details.

## Development and validation

```bash
npm ci --ignore-scripts
npm test
npm run build
```

Commit `dist/` with source changes so consumers can run the Action directly. CI rebuilds it and checks for drift, then runs the bundled Action with the actual pinned CLI against a local mock API on Linux, macOS, and Windows. The mock uses fake tokens and does not create ThousandEyes tests or consume units.

Local process tests cover failure propagation, non-blocking results, input safety, masking boundaries, report integrity, global detail limits, rendered Markdown safety, and unique report paths. Installer tests cover platform assets and checksum failures. Native smoke tests also verify targets, agent names, and JUnit properties, including incomplete results. This Action's GitHub CI does not validate a live ThousandEyes account; the earlier CLI STG pilot is separate evidence.

The wrapper separation follows the [Datadog synthetics Action](https://github.com/DataDog/synthetics-ci-github-action). No Datadog execution code is included.

Licensed under Apache-2.0.
