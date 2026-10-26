# Contributing

Notes for working on `medusa-plugin-print-trail` in this repository. They cover files that are in the repository but not in the package, so this file isn't in the package either.

External pull requests aren't accepted yet. Issues are welcome.

## Development

Use Node 22 (`.nvmrc`), 22.22.0 or later: the dev dependencies are Medusa 2.22.1, which needs it. Node 25 breaks Medusa. Run `nvm use` if the shell's default is different.

| Script | What it does |
|---|---|
| `npm run build` | `medusa plugin:build`: compiles the plugin and its admin extensions to `.medusa/server`. |
| `npm run dev` | `medusa plugin:develop`: watch mode, publishing into a local store through yalc. |
| `npm run lint` | `medusa lint`. |
| `npm run typecheck` | `tsc --noEmit` for the server, the admin and the staging checklist. |
| `npm run check:package` | `scripts/check-package.mjs`, run after a build. It checks what `npm pack` would ship: every `exports` target present, the README, changelog and `LICENSE` included, no tests, mock, integration tests or `CONTRIBUTING.md`, no comments in the compiled server code or its declaration files (triple-slash directives included), no declaration file naming a package that isn't a peer dependency or a dependency (Node's own modules are allowed), or a path into `node_modules` or an absolute path, no binary file in the server code, and no internal reference in any packed file's name or text (text is decided by content, not extension). The terms are below. |
| `npm run check:repo` | `scripts/check-repo.mjs`: the same terms over the name and text of every tracked file as the index holds it (`git ls-files --stage`, so staged changes are checked and unstaged ones aren't; binary files are listed, not scanned). |
| `npm run test:unit` | Jest unit tests (`src/**/__tests__/*.unit.spec.ts`). |
| `npm run test:integration:modules` | Module integration tests against a local Postgres. |
| `npm run test:integration:http` | Builds, then runs the HTTP harness. |
| `npm run test:staging` | The manual staging smoke test. |
| `npm run checklist:staging` | The staging end-to-end checklist against a real store (below). |
| `npm run mock` | The bundled mock Print Trail API on `127.0.0.1:$PORT` (default `4010`), token `$PT_TOKEN` (default `dev-token`), channel `$PT_CHANNEL_ID` (default `test-channel`), webhook secret `$PT_WEBHOOK_SECRET` (default `mock-secret`, returned by `POST /webhooks`). `PT_LEGACY=1` makes it behave like the Print Trail API before 2026-10-19: no secret from registering, no `confirmedAt`, no typed duplicate-create 409. |

### Internal-reference checks

`check:package` and `check:repo` share `scripts/deny-terms.mjs`. It holds the generic patterns (the section sign, numbered plans, home-directory paths, and any email address outside the domains reserved for examples and tests) and a short list of text that is allowed although a term matches it (this repository's slug and the package's former npm name, the licensor's name, Print Trail's staging API host, and a dependency's deprecation notice in the lockfile). The identifying terms are in the maintainers' term list, which isn't in this repository. Its format: one JavaScript regular expression per line, matched case-insensitively unless the line starts with `cs:`; blank lines and lines starting with `#` are skipped. Its last line that isn't blank is `# end of term list`, so a list cut short is noticed. The scripts read it from, in order:

1. `PT_DENY_TERMS`, the list's contents (CI passes the repository secret of that name; an empty value counts as unset);
2. `PT_DENY_TERMS_FILE`, the path of a file holding it;
3. the file named by the git config key `printTrail.denyTermsFile`, a path relative to the repository root (`git config printTrail.denyTermsFile <path>` in a checkout that has the list).

Without any of them, or with a list that has no terms, doesn't end with `# end of term list` or has an expression that doesn't compile, both checks fail with the reason (exit code 2) rather than run on the generic patterns alone. A term from the list is reported by its line number in the list (`private term 12`), never by its pattern, and an expression that doesn't compile by its line number only, since CI logs can be public. GitHub gives no secrets to workflows run from forks or by Dependabot, so both checks fail on those pull requests. That is accepted while external pull requests aren't.

npm runs the `prepublishOnly` script (a build) before publishing the folder. Publishing a packed tarball, as the release does, runs no scripts. `npx medusa plugin:db:generate` generates the module's migrations. It takes no module name.

### Tests

```bash
npm run test:unit
DB_HOST=localhost DB_USERNAME=<pg user> DB_PASSWORD=<pg password> npm run test:integration:modules
DB_HOST=localhost DB_USERNAME=<pg user> DB_PASSWORD=<pg password> npm run test:integration:http
```

- **The HTTP harness** boots a real Medusa app from `integration-tests/http/app` with the plugin loaded from its build, against the bundled mock on `127.0.0.1:4310`. It loads `.medusa/server`, so `test:integration:http` runs `npm run build` first. Each spec file boots its own app in the one Jest process, and not all of an app's memory is given back when it shuts down, so the script raises Node's heap limit to 4 GB. A test that waits for the SKU check queue (`settleSkuChecks`) fails if the queue hasn't drained within 15 seconds.
- **`DB_HOST=localhost`, not `127.0.0.1`, for the test runner.** Medusa's test runner turns on SSL whenever the database URL doesn't contain `localhost`, and a plain local Postgres refuses SSL. The mock is the other way round: use `127.0.0.1` for it, because `localhost` can resolve to another process.
- **`REDIS_URL`** (for example `redis://localhost:6379`) switches the harness to Redis locking and turns on the concurrent-send test. Without it, that test is skipped. Each spec file's app takes its locks under its own Redis namespace, so a lock an app held when it shut down doesn't hold up the next file.
- **`npm run test:staging`** runs a smoke test against Print Trail staging by hand. It needs `PT_STAGING_BASE_URL`, `PT_STAGING_CHANNEL_ID`, `PT_STAGING_API_TOKEN` and `PT_STAGING_SKUS` (comma-separated SKUs the staging channel can order), and refuses any host that isn't `https` under `consilstaging.com`, or is a `printtrail.com` host. With none of the variables set it is skipped. Its orders are numbered `CI-<run id>-<attempt>-<n>` (locally `CI-local<timestamp>-<n>`) and cancelled at the end.

No test, script or CI job reaches Print Trail production.

### The package's exports

`exports` in `package.json` lists each public entry point: `/config`, `/workflows`, `/modules/printTrail`, `/providers/print-trail`, `/stock`, `/shipping-options` and `/admin` (Medusa's admin bundler resolves it under both `require` and `import`), plus `/.medusa/server/src/modules/printTrail`, the path Medusa loads the module from when a store lists the plugin. Each entry point except `/admin` and the module's path has a `types` condition, listed first, naming its declaration file (`declaration: true` in `tsconfig.json`). There is no pattern, so nothing else under `.medusa/server` can be imported, and a file that isn't an entry point can change in any release. `src/stock.ts` and `src/shipping-options.ts` re-export what a store may use from `src/lib`. `src/__tests__/public-api.unit.spec.ts` checks the list.

`scripts/install-test.sh <tgz> <medusa version>` installs a packed tarball with that version of Medusa into a new temporary project, as a store would (no `--legacy-peer-deps`), and runs `scripts/check-exports.cjs` there. It checks that every entry point resolves and loads, that `/admin` resolves under `require` and `import`, that Medusa's own plugin resolution finds the module and the admin build, and that a deep import of an internal file fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Then it type-checks `scripts/consumer-fixture/consumer.ts`, a store's own code using each entry point, with TypeScript 5.9.3, `--strict` and `moduleResolution` `node16` and `bundler`: with `skipLibCheck` it must compile (its `@ts-expect-error` lines fail if a type has become `any`), `deep-import.ts` must give TS2307, and without `skipLibCheck` no error may be in the package's declarations (Medusa's own have some, which are counted). The project is removed afterwards.

```bash
npm run build && npm pack
scripts/install-test.sh medusa-plugin-print-trail-<version>.tgz 2.22.1
```

### Staging checklist

`npm run checklist:staging` checks a real Medusa store with the plugin installed, scenario by scenario, against Print Trail staging. It drives the store through its admin and store APIs, reads Print Trail through the plugin's own client, and reports each check as pass, fail, skipped or manual. It lives in `scripts/staging-checklist/` and isn't part of the package.

1. Copy `.env.checklist.template` to `.env.checklist` (git ignores it) and fill it in: the store's URL, an admin login and a publishable key; the stores the checklist must never reach (`CHECKLIST_FORBIDDEN_STORE_URLS`, required; empty for none); the Print Trail staging URL, channel and token the store's plugin uses; and the SKUs to order. Each SKU must resolve to a variant whose product is in a Print Trail shipping profile.
2. Run it:

```bash
npm run checklist:staging -- --list                 # the scenarios
npm run checklist:staging                           # staging; prompts when a person is needed
npm run checklist:staging -- --non-interactive      # staging; steps that need a person are "manual"
npm run checklist:staging -- --only send,dispatch   # some scenarios (or --skip)
npm run checklist:staging -- --mock                 # the bundled mock, unattended
npm run checklist:staging -- --include preorder-release   # also the opt-in release scenario
npm run checklist:staging -- --cleanup <run id>     # cancel what an earlier run left behind
```

It ends with a table and writes a JSON report to `scripts/staging-checklist/reports/` (git ignores it). It exits 1 if any check failed, or if the cleanup left anything open. Skipped and manual checks don't fail the run. With `--non-interactive` against staging, a scenario that needs a person is recorded as manual before it places any order.

**The server and the worker must share their settings.** When the store runs as a separate server and worker, both need the same `PRINT_TRAIL_*` environment. The checklist talks to the server, but the worker sends the orders. After the first order, the script looks that order up at Print Trail, and stops the run if Print Trail doesn't know it.

**Safety.** The script refuses a Print Trail host that isn't `https` under `consilstaging.com` (the staging smoke test's guard), and with `--mock` anything but `http://127.0.0.1:<port>`. It refuses any store listed in `CHECKLIST_FORBIDDEN_STORE_URLS` (comma-separated URLs, such as a store in daily use on this machine), however its address is written. The variable is required: while it is unset the script refuses to run, so a misspelt name can't leave a store unguarded. Set it empty (`CHECKLIST_FORBIDDEN_STORE_URLS=`) to forbid none. The run prints the list it guards against, or `none`, before it starts. A local host is a localhost name, a loopback or unspecified address, one of this machine's own addresses or its host name, or a name that resolves to any of those. A listed URL on a local host, however that host is written, forbids its port on every local host. Any other listed URL forbids its host on its port, by name or by the addresses it resolves to. On a forbidden port a host that doesn't resolve is refused too, and an entry that isn't an `http` or `https` URL stops the run. Before placing an order it checks that the store's plugin uses the same Print Trail URL and channel, and isn't pointed at production. It never prints tokens, passwords, the admin session, the webhook secret or the customer email. Orders use the email `checklist+<run id>@example.com` (or `CHECKLIST_CUSTOMER_EMAIL`), the name "Checklist <run id>" and the cart metadata `print_trail_checklist: <run id>`.

**Cleanup.** Each order is written to `reports/<run id>.state.json` as it is placed. At the end, and on Ctrl-C, SIGTERM or SIGHUP, the script cancels every order of the run, including any it finds by the cart metadata. Medusa refuses to cancel an order with fulfilments, so for those it cancels any undispatched Print Trail order directly. It never does so while the plugin's own cancel is still being requested, and it waits for an accepted (202) cancel to finish. Dispatched orders are left as they are, and any fulfilment of theirs still open is listed in the notes. Anything left open fails the run. `--cleanup <run id>` repeats the cleanup from the state file later, cancelling directly at Print Trail if the store is down. The `unmatched-sku` scenario changes the stocked variant's `print_trail_sku` for a minute and writes it back (an empty string when there was none, which the plugin reads as no override).

**`preorder-release` is opt-in** (`--include preorder-release`). Releasing makes the pre-order product active at Print Trail for good, so later runs have no pre-order SKU to test with.

**Steps that need a person.** Against staging, someone does in the Print Trail app what a warehouse would: dispatch an order (all of it, or one fulfilment), change an order's status, cancel it there, or release a pre-order product. The script says what to do and polls Print Trail and the store until it shows, for up to `CHECKLIST_HUMAN_TIMEOUT` seconds (type `s` and Enter to skip the step). It also asks whether the emails arrived, and asks you to restart the store for the crash test. Webhooks must reach the store, so it needs a public `https` backend URL.

With `--mock`, the script starts the bundled mock itself at `PT_STAGING_BASE_URL` (the store's `PRINT_TRAIL_BASE_URL`, so stop any mock already on that port) and does those steps through it, so the run needs nobody. Set `CHECKLIST_MOCK_WEBHOOK_SECRET` to the store's `PRINT_TRAIL_WEBHOOK_SECRET`. A fresh mock knows only the configured SKUs, so mock mode re-runs the stock sync and re-checks stale variants before it starts (it saves those variants). It registers the store's local webhook URL with the admin's confirmation.

| Scenario | Checks | Needs a person on staging |
|---|---|---|
| `connection` | Test connection; the webhook is registered; the secret's `source` on the settings view is `print-trail` (required from API 1.1.0), or it is configured | |
| `api-version` | the `Print-Trail-Api-Version` header, and the settings page shows it (skipped until the plugin and Print Trail have it) | |
| `stock` | the configured SKUs are matched; Medusa's stock equals Print Trail's (mock: after a stock webhook; staging: as of the last stock sync) | |
| `unmatched-sku` | an unknown `print_trail_sku` is flagged and listed, and clears when restored | |
| `send` | sent and confirmed; linked to the Print Trail order; the lines match; `confirmedAt` (API 1.1.0) | |
| `webhook` | a status change at Print Trail reaches the plugin's row | change the status |
| `dispatch` | one Medusa fulfilment and shipment per parcel, with Print Trail's tracking; auto-complete; the shipment email | dispatch; check the inbox |
| `two-parcel` | the same per parcel, with the order open after the first (needs `PT_SECOND_SKU` from another supplier location) | dispatch twice |
| `cancel` | a Medusa cancel reaches Print Trail: the plugin's cancel ends `cancelled` or `awaiting` (202), never refused, too late, failed or not sent | |
| `cancel-too-late` | dispatched before Medusa hears, then cancelled: attention, timeline note, one admin email per address | dispatch; check the inbox |
| `amend` | an order edit changes Print Trail's lines | |
| `refund` | a partial refund is noted on the timeline and Print Trail is unchanged | |
| `resend` | Resend of a confirmed order is refused; "Resend as new" after a Print Trail cancel sends `-2` | cancel at Print Trail |
| `crash` | mock: a draft saved before a failing confirm is confirmed by Resend, with no duplicate; staging: an order placed across a restart is sent once | restart the store |
| `preorder-unlimited`, `preorder-limited`, `preorder-mixed`, `preorder-release` | pre-orders (API 1.3.0, or `preOrderLimit` on stock levels): purchasable at 0, confirmed, waiting without attention, the remaining allowance, a mixed order shipping its in-stock part, release (opt-in) | dispatch; release |

On staging, `cancel-too-late` races the dispatch webhook: the script cancels the moment Print Trail shows the dispatch. If the webhook wins, Medusa refuses the cancel and the scenario is skipped. The `webhook` check can also pass through the reconcile job, if it runs first.

### CI

- `.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. Its `test` job runs lint, typecheck, the repository check, unit tests, build, package check, then the module and HTTP integration tests, with Postgres 16 and Redis 7 services. Its `install-test` job builds and packs the plugin and runs `scripts/install-test.sh` with Medusa 2.22.1. Neither has Print Trail credentials. The two checks read the maintainers' term list from the `PT_DENY_TERMS` repository secret (Settings, Secrets and variables, Actions), which `release.yml` uses too.
- `.github/workflows/staging.yml` runs the staging smoke test. It is manual only (`workflow_dispatch` with a `confirm` input) and reads its credentials from the `staging` environment's secrets. Set up that environment with the four `PRINT_TRAIL_STAGING_*` secrets (`BASE_URL`, `CHANNEL_ID`, `API_TOKEN`, `SKUS`), and restrict its deployment branches to `main`, so a workflow file changed on another branch can't read them.

### Troubleshooting

- **The store talks to the wrong mock.** Point the store at the bundled mock with `PRINT_TRAIL_BASE_URL=http://127.0.0.1:<port>`, not `localhost`. The mock binds `127.0.0.1`, and `localhost` can resolve to another process on the same port.
- **The mock doesn't start under pm2.** The mock (`dev/mock-print-trail.ts`) is in the repository, not the package. It starts only when `argv[1]` is its own file, so pm2 must run `node` directly from a checkout:

  ```js
  // ecosystem.config.js
  module.exports = {
    apps: [
      {
        name: "print-trail-mock",
        script: "node",
        args: "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON dev/mock-print-trail.ts",
        interpreter: "none",
        env: { PORT: "4010", PT_TOKEN: "dev-token" },
      },
    ],
  }
  ```

## Releasing

A pushed tag `v<version>` runs `.github/workflows/release.yml`, which has two jobs:

- **`release`** runs lint, typecheck, the repository check, the unit tests, the build and the package check; checks that the tag, `package.json`'s `version` and a `## [<version>]` section of `CHANGELOG.md` agree; runs `npm pack`; runs `scripts/install-test.sh` on the tarball with Medusa 2.17.2 and with 2.22.1; uploads the tarball as the run's `package` artifact; and creates a GitHub Release with the tarball attached and that changelog section as its notes, marked as a prerelease when the version has a `-`. It can write releases (`contents: write`) but can't request an OIDC token.
- **`publish`** runs after `release` succeeds, only when the repository variable `NPM_PUBLISH` is `true`, in the `npm` environment. It downloads the `package` artifact and publishes that tarball to npm (below). Its only permission is `id-token: write`, no other job has it, and it doesn't check out the repository or run any project script, so none of the dependencies `npm ci` installs runs where the token can be requested. The split keeps the token away from dependency code. It doesn't check the tarball independently: `release` builds it with those dependencies installed.

Until `NPM_PUBLISH` is set, `publish` is skipped and a tag only makes the GitHub Release.

### Releasing to npm

These steps follow npm's docs (<https://docs.npmjs.com/trusted-publishers> and the `npm trust` command) and GitHub's, as of 2026-10-25. The package is published under the npm organisation `print-trail`. Its first public version is 1.0.0, and no earlier version was published to npm. `repository.url` in `package.json` must name this repository, since npm matches it against the repository the workflow runs in.

1. **Publish the first version by hand.** A trusted publisher can only be added to a package that already exists on npm (the `npm trust` docs say so), so a member of the npm organisation `print-trail` publishes the first version by hand, from their own account with two-factor authentication. Push its tag first: the release workflow tests the tarball and attaches it to the version's GitHub Release. Then publish that file:

   ```bash
   publish_release() {
     local v="$1" repo=consilience/medusa-plugin-print-trail
     local f="medusa-plugin-print-trail-$v.tgz" digest
     shift
     gh release download "v$v" -R "$repo" -p "$f" --clobber || return
     digest="$(gh release view "v$v" -R "$repo" --json assets --jq ".assets[] | select(.name == \"$f\") | .digest")" || return
     if [ "sha256:$(shasum -a 256 "$f" | cut -d' ' -f1)" != "$digest" ]; then
       echo "$f doesn't match the release's digest ($digest), so it isn't published" >&2
       return 1
     fi
     echo "sha256 matches the release"
     npm publish "./$f" "$@"
   }
   npm whoami
   publish_release <version>
   ```

   Check that `npm whoami` names your own account, a member of `print-trail`. `publish_release` downloads the tarball from the version's GitHub Release and stops, publishing nothing, if the download fails or the file's sha256 doesn't match the release's digest for it. Anything after the version goes to `npm publish`, so a prerelease (a version with a `-`) is `publish_release <version> --tag next`. npm asks for a one-time password (or add `--otp <code>`). Publishing a tarball runs no lifecycle scripts, so what goes up is what the workflow tested. npm 11 refuses a prerelease without `--tag`; npm 10, Node 22's own, would make it `latest`.

   Then give the organisation's `developers` team read-write access to the package, so it doesn't rest on one account:

   ```bash
   npm access grant read-write print-trail:developers medusa-plugin-print-trail
   ```

2. **Set up the `npm` environment on GitHub.** In the repository's Settings, under Environments, create `npm`. Under Deployment branches and tags, choose Selected branches and tags and add a rule with Ref type Tag and the pattern `v*`, so only a `v*` tag can run the `publish` job. A required reviewer (with Prevent self-review) makes each publish wait for an approval; a public repository has them on any GitHub plan. Then limit who can create `v*` tags with a tag ruleset (Settings, Rulesets, New ruleset, New tag ruleset): target `v*`, turn on Restrict creations, give bypass to whoever releases, and make it Active.

3. **Add the trusted publisher.** On npmjs.com, in the package's **Settings**, add a trusted publisher for GitHub Actions:
   - Organization or user: `consilience`
   - Repository: `medusa-plugin-print-trail`
   - Workflow filename: `release.yml` (the file name only, not its path)
   - Environment name: `npm`, the `publish` job's environment. A publish then has to come from a job in that environment, which only a `v*` tag can run.
   - Allowed actions: tick `npm publish`. `npm stage publish` is always allowed, and a configuration created after Sep 03, 2026 allows only that by default, so without the tick npm refuses the workflow's `npm publish`.

   Or with the CLI (npm 11.15.0 or later, logged in as an owner, with two-factor authentication on the account):

   ```bash
   npm trust github medusa-plugin-print-trail --file release.yml --repository consilience/medusa-plugin-print-trail --environment npm --allow-publish
   ```

   Every field is case-sensitive, and npm doesn't check them on save. A mistake shows only when the workflow publishes, as `ENEEDAUTH` ("Unable to authenticate"): check the fields, that `repository.url` matches the repository, and that the `publish` job has `id-token: write` and runs in `npm`.

   Stage-only is stricter: leave `npm publish` unticked and have the workflow run `npm stage publish`, and each release then waits until a maintainer approves it with two-factor authentication (`npm stage approve`, or on npmjs.com). The workflow doesn't do that.

4. **Publish through it within 2 days.** A new trusted publisher configuration expires unless its first successful publish happens within 2 days. An expired one has to be deleted and added again, and then that one has 2 days. So add it only when the next version is ready to tag.

5. **Turn on the workflow's publish.** Set the repository variable `NPM_PUBLISH` to `true` (Settings, Secrets and variables, Actions, Variables; or `gh variable set NPM_PUBLISH --body true`), then push the next tag. It has to be a repository variable, not one of the `npm` environment's: the job's `if:` is evaluated before the job starts, and GitHub makes an environment's variables available only on the runner after it has. The `publish` job runs once `release` has created the GitHub Release: a version with a `-` goes out under the `next` dist-tag, any other under `latest`. It reads the version from the tarball's own `package.json`. It installs npm 11.21.0 and fails unless it then has npm 11.5.1 or later, which trusted publishing needs. Trusted publishing also needs Node 22.14.0 or later, and the job sets up the latest Node 22 (`.nvmrc`'s major; it has no checkout to read `.nvmrc` from).

6. **Provenance.** With trusted publishing, npm generates provenance automatically when publishing from a public repository, as this one is. Nothing in the workflow asks for it.

7. **Then disallow tokens.** Once a version has gone out through the workflow, open the package's **Settings**, then **Publishing access**, choose **Require two-factor authentication and disallow tokens** and press **Update Package Settings**. Access tokens can then no longer publish. The trusted publisher keeps working, since it doesn't use a token, and publishing by hand still works with two-factor authentication.

**README images.** The README's screenshots are relative links (`media/…`, not in the package). They resolve on GitHub, and on npm through `repository`. After the first publish, check them on the npm page and in Medusa's integrations directory, and switch them to absolute URLs if the directory doesn't resolve them.

**If npm refuses in the workflow,** only the `publish` job fails; the GitHub Release is already made. Fix the cause, then use **Re-run failed jobs** on the run. That runs `publish` again with the same `package` artifact (artifacts are kept for 90 days by default) and doesn't repeat `release`, which would fail at `gh release create`. Or publish the release's tarball by hand, as in step 1.
