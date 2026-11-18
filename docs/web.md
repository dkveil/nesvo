# Website and workflow sharing

`apps/web` is the public site at https://nesvo.dev: the download page, the macOS install script and short-lived shared workflows. It is a server-rendered Next.js App Router application (TypeScript strict) that runs as a Cloudflare Worker through the OpenNext Cloudflare adapter and stores data in Cloudflare D1. It replaced the static page that used to live in `site/`.

## What it serves

| Path                                                        | What                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `/`                                                         | Download page, rendered per request                    |
| `/download/windows`, `/download/mac`, `/download/mac-intel` | `302` to the stable asset of the latest GitHub Release |
| `/releases`, `/github`                                      | `302` to the releases page and the repository          |
| `/install.sh`                                               | macOS install script                                   |
| `/w/<id>`                                                   | Shared workflow page                                   |
| `/api/shares`, `/api/shares/<id>`                           | Share API                                              |
| `/robots.txt`                                               | Disallows everything                                   |

## Not indexed

The site is not indexed for now. Every page renders `<meta name="robots" content="noindex, nofollow">`, every response from the Worker carries `X-Robots-Tag: noindex, nofollow` (from `next.config.ts`), static assets get the same header from `public/_headers`, `robots.txt` disallows all paths and there is no sitemap. Production responses also carry a Content Security Policy that allows only same-origin resources, plus HSTS, `nosniff` and a strict referrer policy; a shared workflow page sends no referrer at all.

## Download page

The page is deliberately small: the wordmark, one line about Nesvo, a primary download for the visitor's system, its version and size on one line and, on a Mac, the Terminal install command as one copyable line. Three quiet toggles open one panel at a time below: **Other platforms** (the remaining installers, Linux as not available yet and the Terminal command when the visitor is not on a Mac), **Checksums** (version, publish date, release notes, `SHA256SUMS.txt` and each installer's size and SHA-256) and **First launch** (what the unsigned builds ask on Windows and macOS). The panels are in the server-rendered HTML and hidden until opened.

The wordmark carries a static scanline texture and a short slice glitch, CSS only: it plays once after load and once per mouse hover, uses only `transform`, `clip-path` and `opacity` on absolutely positioned copies (no layout shift) and is removed entirely under `prefers-reduced-motion: reduce`.

The system is detected twice. The server reads User-Agent Client Hints (`Sec-CH-UA-Platform`, `Sec-CH-UA-Arch`, `Sec-CH-UA-Mobile`) and falls back to the User-Agent string; every response sends `Accept-CH` so supporting browsers include the architecture on later requests. After hydration the page asks `navigator.userAgentData.getHighEntropyValues` for the architecture and corrects the choice, which is how an Intel Mac on a Chromium browser gets the Intel disk image on the first visit. Browsers without Client Hints report every Mac as Intel, so a Mac with an unknown architecture gets the Apple silicon build with an "Intel Mac?" link under the button. Phones, tablets and Linux get no primary button; the platform list is shown directly instead.

Release data comes from the GitHub API (`/repos/<repo>/releases/latest`) and the release's `SHA256SUMS.txt`. The result is cached in D1 for ten minutes per repository, so the unauthenticated API limit is not a concern; when GitHub cannot be reached the last cached result is used. Three states are handled:

- **Published**: the download button, version, sizes and checksums.
- **No release yet** (the API answers 404): the download button stays visible but inactive, with the single line "The first build is on its way." and nothing else.
- **Unavailable** (no cache and GitHub fails): the download button still points at the latest release and one line says the release details cannot be loaded, with a link to all releases.

The download buttons always use the short `/download/*` paths, which redirect to the stable file names the release workflow publishes (`Nesvo-Windows-Setup.exe`, `Nesvo-macOS-arm64.dmg`, `Nesvo-macOS-x64.dmg`), so a new release needs no change to the site.

### macOS install script

On a Mac the page also offers `curl -fsSL https://nesvo.dev/install.sh | sh` as one copyable line; other systems find it under Other platforms. The script:

1. refuses anything but macOS and picks the disk image by processor, treating a shell running under Rosetta as Apple silicon;
2. stops when `/Applications` is not writable or Nesvo is running;
3. downloads the disk image and `SHA256SUMS.txt` from the latest release and compares the SHA-256 with `shasum -a 256`; on a mismatch nothing is installed;
4. mounts the image read-only, copies `Nesvo.app` to `/Applications` (replacing an older copy) and unmounts it;
5. prints the first-launch steps: Control-click Nesvo in Applications and choose Open, or System Settings › Privacy & Security › Open Anyway.

The script never removes the quarantine attribute and never changes Gatekeeper settings. `curl` does not mark its downloads the way a browser does, so the script adds the standard `com.apple.quarantine` attribute to the downloaded image and the installed app; otherwise macOS would skip its first-launch check for an unsigned app. It uses no `sudo`.

## Workflow sharing

Anyone with Nesvo can share a workflow without an account. A share is a bundle of the workflow file and its step files, kept for seven days. The bundle contract is `workflowShareBundleSchema` in `packages/contracts/src/workflow-share.ts`, imported by the site and the desktop app (`@nesvo/contracts/workflow-share`).

```json
{
  "version": 1,
  "name": "release",
  "description": "Optional, at most 400 characters",
  "workflow": {
    "fileName": "release.md",
    "content": "---\nname: release\n..."
  },
  "steps": [
    { "fileName": "lint.md", "content": "---\nname: lint\ntype: command\n..." }
  ],
  "createdWith": { "app": "nesvo", "version": "0.1.0" }
}
```

| Limit                         | Value                                                 |
| ----------------------------- | ----------------------------------------------------- |
| Request body                  | 256 KiB                                               |
| One file                      | 64 KiB (UTF-8), the same as a definition file on disk |
| All file contents together    | 192 KiB                                               |
| Steps                         | 32, unique file names                                 |
| File names                    | lowercase `name.md`, like step and workflow names     |
| New shares per client address | 10 per hour                                           |
| Lifetime                      | 7 days                                                |

Unknown fields are rejected. `workflowShareBundleByteLength` lets a client check the serialized size before uploading.

### API

`POST /api/shares` with `Content-Type: application/json` and the bundle as the body.

- `201` with `{ id, url, revokeToken, expiresAt }` (`workflowShareCreatedSchema`). `id` is 32 random URL-safe characters (24 bytes), `revokeToken` 43 (32 bytes), `expiresAt` an ISO timestamp. Only a SHA-256 hash of the revoke token is stored; the uploader keeps the token privately.
- `400 invalid_request` for malformed JSON or a bundle that fails the schema, with up to 20 `issues` (`path`, `message`).
- `413 payload_too_large`, `415 unsupported_media_type`.
- `422 secret_detected` when the secret scan matches. The response lists `secrets` as file name, line and kind (`private-key`, `access-token`, `credential-assignment`, `bearer-credential`, `url-credential`) and never echoes the value. The scan is `findWorkflowShareSecrets` in the contract, so the desktop can run the same check before uploading. References such as `$API_TOKEN` are not secrets.
- `429 rate_limited` with `Retry-After` in seconds.

`GET /api/shares/<id>` returns the bundle itself as JSON with `200` and its expiry in the `Nesvo-Share-Expires-At` header, `404 not_found` for an unknown or revoked share and `410 expired` once it has expired.

`DELETE /api/shares/<id>` with `Authorization: Bearer <revokeToken>` deletes the share: `204`, `401 unauthorized` without a token, `403 forbidden` for a wrong token, `404 not_found` for an unknown share.

Every error body matches `workflowShareErrorSchema`: `{ error, message, issues?, secrets? }`. API responses are `Cache-Control: no-store`. The rate limit counts every create attempt per client address (`CF-Connecting-IP`, stored only as a hash) in fixed one-hour windows.

### Share page and opening in Nesvo

`/w/<id>` uses the same minimal styling as the home page and shows the workflow name and description, the expiry, a warning that shared workflows run commands on your computer (kept prominent with a warning-coloured rule and title), and every step in the order of the workflow's `steps:` list with its type. Steps show their full file content (escaped, monospace) unless their frontmatter has exactly one `type` that is known not to run shell commands (`agent`, `human`, `wait-ci`, `probe`); only those steps and the workflow file are behind a disclosure. The page reads the frontmatter with a small line reader, so anything it cannot read unambiguously, such as a repeated, nested or unknown `type`, is treated as able to run commands. **Open in Nesvo** links to

```text
nesvo://import-workflow?share=<id>&origin=<site origin, URL-encoded>
```

built and parsed by `buildWorkflowShareDeepLink` and `parseWorkflowShareDeepLink` in the contract; the parser accepts only an HTTPS origin, or an HTTP loopback origin for local development. **Download Nesvo** is the fallback when the app is not installed. An expired share shows a short explanation; an unknown share returns 404 with the same layout.

### Expiry clean-up

A Cron Trigger (`17 * * * *`, hourly) runs the `scheduled` handler in `apps/web/worker.ts`, which deletes expired shares and finished rate limit windows. Until a row is deleted, an expired share already answers `410`.

## Storage

`apps/web/migrations` holds the D1 schema, applied with `wrangler d1 migrations apply`:

- `shares`: id, bundle JSON, revoke token hash, created and expiry time in milliseconds.
- `share_rate_limits`: hashed client address, window start, attempts.
- `release_cache`: last release state per repository.

## Configuration

| Variable                   | Default                  | Meaning                                                           |
| -------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `NESVO_RELEASE_REPO`       | `dkveil/nesvo`           | Repository whose latest GitHub Release the site offers            |
| `NESVO_RELEASE_API_ORIGIN` | `https://api.github.com` | GitHub API origin; a local stand-in can replace it in development |

Both are plain variables in `wrangler.jsonc`; `.dev.vars` overrides them locally (see `.dev.vars.example`). The site needs no secrets.

## Local development

```sh
bun install --frozen-lockfile
bun run --cwd apps/web dev
```

`dev` applies the D1 migrations to a local database under `apps/web/.wrangler` and starts `next dev` on port 3000; route handlers and pages reach the local D1 binding through the adapter's development integration. To run the real Worker locally, `bun run --cwd apps/web preview` builds it with OpenNext and serves it with `wrangler dev`; add `--test-scheduled` to `wrangler dev` and request `/__scheduled` to run the clean-up. Set `WRANGLER_SEND_METRICS=false` to keep Wrangler from sending usage metrics.

| Command                                   | What                                      |
| ----------------------------------------- | ----------------------------------------- |
| `bun run --cwd apps/web test`             | Route, page and script tests (`bun test`) |
| `bun run --cwd apps/web typecheck`        | Route types and `tsc`                     |
| `bun run --cwd apps/web build`            | `next build`                              |
| `bun run --cwd apps/web build:worker`     | OpenNext Worker bundle in `.open-next`    |
| `bun run --cwd apps/web db:migrate:local` | Apply migrations to the local D1          |

The tests run the route handlers against an in-memory SQLite database created from the same migrations, with the Cloudflare context replaced by that database.

## Deployment checklist

Nothing is deployed from CI, and the repository holds no Cloudflare token or account identifier. For the first deployment the owner:

1. Signs in with `bunx wrangler login` in `apps/web` (or creates an API token with Workers, D1 and DNS edit rights for a CI deployment later).
2. Creates the database: `bunx wrangler d1 create nesvo-web`, and copies the printed `database_id` into `d1_databases[0].database_id` in `apps/web/wrangler.jsonc`, replacing the all-zero placeholder. The id is not a secret; keep it local or commit it, as preferred.
3. Applies the schema: `bunx wrangler d1 migrations apply DB --remote`.
4. Builds and deploys the Worker: `bun run --cwd apps/web build:worker`, then `bunx opennextjs-cloudflare deploy` in `apps/web`. Alternatively, connect the repository in Workers Builds with `apps/web` as the root directory, `bun run build:worker` as the build command and `bunx opennextjs-cloudflare deploy` as the deploy command; run the remote migration step whenever `migrations/` changes.
5. Moves the domain: remove `nesvo.dev` from the existing Pages project (Custom domains), then deploy again so the `routes` entry with `custom_domain: true` attaches `nesvo.dev` to the `nesvo-web` Worker. Delete the Pages project afterwards, since it builds from `site/`, which no longer exists.
6. Checks the Cron Trigger under the Worker's Settings › Triggers (`17 * * * *`), which `wrangler.jsonc` declares.
7. Verifies: `/` answers with `X-Robots-Tag: noindex, nofollow`, `/robots.txt` disallows all, a test `POST /api/shares` returns a link, `GET` returns the bundle, `DELETE` with the revoke token returns `204`, and `/install.sh` is served as a shell script.

## Continuous integration

The foundation checks cover the site through the root scripts: `typecheck` includes `@nesvo/web`, `lint` and `format:check` include `apps/web`, `test` runs the web tests after the host tests, and `build` runs `next build` for `apps/web`. The workflow also builds the OpenNext Worker bundle so adapter problems show up before a deployment.
