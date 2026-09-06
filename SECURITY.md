# Security

umapilot is a **local-first tool with no server**. That single fact decides most
of what follows, so it is worth stating precisely before the checklist:

- No backend, no API, no database, no accounts, no sessions, no cookies.
- The planner runs entirely in the browser. Nothing is uploaded.
- The only sensitive input is the player's own `master.mdb`, read **read-only**
  from their own machine and never transmitted or committed.
- The published artifact is a static page. There is no server-side state to
  attack and no other user's data to reach.

Most web-app security advice assumes the opposite of all of that. Applying it
anyway produces ceremony that looks like diligence and protects nothing, while
hiding the few items that genuinely matter here. So this file records which
controls apply, which do not, and **why** — so the reasoning can be re-checked
when the architecture changes rather than re-litigated from scratch.

## Threat model

The realistic risks, in order:

1. **Leaking the player's game data or identity through the repo.** Their
   `master.mdb`, the dataset extracted from it, or their real email in commit
   metadata. This is the one that has actually needed attention.
2. **Damaging the player's game install.** The extractor touches
   `master.mdb`, which lives inside their Umamusume install.
3. **A malicious or compromised dependency** running with their filesystem
   access at build or extract time.
4. **Injection through game text.** Card, skill and song names come from
   `master.mdb` and contain markup (`<color=#ff911c>`). Rendered carelessly into
   the DOM, that is an injection sink whose source is a file we do not control.
5. **A malformed dataset or scan reading** crashing the planner or producing a
   confidently wrong recommendation.

Not in the model: attacks by one user against another (there are no other
users), privilege escalation (there are no privileges), and data exfiltration
from a server (there is no server).

## The checklist, item by item

| item | applies | how |
|---|---|---|
| Hide API keys | no | no APIs, no keys |
| Purge secrets from Git | **yes** | CI gate, below |
| Expose only the public DB key | no | no database |
| Enable row-level security | no | no database |
| Encrypt sensitive data | no | data never leaves the machine |
| Enforce server-side auth | no | no server |
| Lock record access | no | no records |
| Block field tampering | no | no server to tamper with |
| Secure session cookies | no | no sessions, no cookies |
| Hash passwords | no | no accounts |
| Rate limit login | no | no login |
| Add bot protection | no | nothing to abuse |
| Parameterize queries | **yes** | done — all 29 `execute()` calls bind parameters |
| Validate all input | **yes** | rules below |
| Escape user content | **yes** | rules below |
| Restrict file uploads | **yes** | rules below |
| Trim API responses | no | no API |
| Add security headers | **yes** | CSP on the published page |
| Force HTTPS | **yes** | hosting concern; GitHub Pages enforces it |
| Scan dependencies | **yes** | `npm audit` in CI |

Eight of twenty-two. The other fourteen are not "skipped" — they describe
machinery this project does not have.

## What is enforced

### Never commit game data or identity

`.gitignore` excludes `*.mdb` anywhere and `packages/data/generated/*.json`. CI
fails the build if either is ever tracked, so the guarantee does not depend on
anyone remembering to check.

Commits use GitHub's `noreply` address (`scripts/set-identity.sh`).

### The extractor is read-only

`master.mdb` is opened with a `file:...?mode=ro` URI. It cannot write to the
player's game files even by mistake.

### Parameterised SQL

Every query binds its parameters. No SQL is built by string interpolation, even
though the only input is a local file — a habit is worth more than a
case-by-case judgement.

### Dependency surface stays small

Three dev dependencies (`typescript`, `tsx`, `@types/node`) and **zero runtime
dependencies**. `npm audit` runs in CI. The cheapest supply-chain control is not
adding the package; a new runtime dependency should be argued for.

CI runs with `permissions: contents: read`, so a compromised action cannot write
to the repo.

## Rules for the M3 web UI

These are binding decisions made before the code exists, which is the only time
they are cheap.

1. **Never `innerHTML` game text.** Card, skill and song names come from
   `master.mdb` and contain markup. The extractor strips it, but the UI must use
   `textContent` regardless — defence in depth, because the extractor's stripper
   is a regex and the file is not ours.
2. **Content-Security-Policy on the published page**, at minimum
   `default-src 'self'; img-src 'self' data: blob:; connect-src 'none'`.
   `connect-src 'none'` is the load-bearing one: it makes "nothing is uploaded" a
   property the browser enforces, not a promise in a README.
3. **Validate the dataset at load.** It is JSON from disk, so treat it as
   untrusted: check `schemaVersion`, check the SHA-256 matches the manifest, and
   fail loudly rather than rendering `undefined`.
4. **Constrain what the scan accepts.** Images only, size-capped, decoded in a
   canvas — never `eval`'d, never fetched from a URL the page did not construct.
   Screen frames stay in the page; they are never sent anywhere.
5. **Clamp user targets.** Stat targets are integers within the run's caps;
   wishlist entries must resolve to known skill ids. Out-of-range input is a
   validation message, not a projection.
6. **A low-confidence screen reading is shown as unknown, never guessed.** This
   is a safety property as much as a correctness one: a confidently wrong
   recommendation is the failure mode that costs a 72-turn run.

## Reporting

It is a local planner with no server, so there is little to report against — but
if you find something, open an issue. Do not include your `master.mdb` or
anything extracted from it.
