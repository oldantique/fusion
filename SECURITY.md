# Security

## What Fusion is, security-wise

One person, one machine. Fusion drives the vendor CLIs you are already logged into and keeps
the conversations locally. Every design decision below follows from that: it is a personal tool
you put on your own host (or your Tailscale network), not a service.

## Not safe to expose to the internet

- The only gate is a **shared password** and an HMAC-signed, expiring, httpOnly cookie
  (`src/server/auth.ts`). One password for everyone who has it; no accounts, no rate limit on
  login attempts, no lockout.
- **No TLS.** The default bind address is loopback; opening it to the LAN/Tailscale is an
  explicit opt-in in `.env`, and the cookie is deliberately not `secure` because of it.
- So: do not port-forward it, and do not put it on a shared host. Remote access belongs behind
  something that does identity and TLS for you — the operational rules are in
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md) ("Security posture"), and the sketch for letting other
  people in at all is thread #16 in [`docs/THREADS.md`](docs/THREADS.md).

## What the jail does and does not contain

Every CLI runs inside a bubblewrap mount namespace that exposes the OS read-only, that CLI's own
state directory, and an empty writable sandbox — nothing else of your filesystem
(`jailArgv` in `src/providers/process.ts`; each provider's `mounts` list in
`src/providers/index.ts` is the allowlist). `npm run canary` is the proof: it plants a secret
under your real HOME and fails if any lane can quote it.

**Networking is not namespaced** — the lanes need the vendors' APIs. The jail contains file
access, not the network and not your subscription: a lane still holds that CLI's OAuth token and
still spends your quota. The per-CLI tool blocks (no tools, deny rules, read-only sandbox) are a
second layer on top of the jail, not the containment itself.

Model output is untrusted input and is treated as such: prompts declare candidate and history
text untrusted, and everything rendered in the browser goes through DOMPurify — the only markup
allowed past it is KaTeX's own output and re-sanitised mermaid SVG (`render()` in `web/app.js`).

## What is on disk

- `data/` (gitignored) — the SQLite database: your questions, the fused answers, each model's raw
  answer, timings and errors. Plain files, no encryption; back it up and delete it like any other
  personal data.
- `.env` (gitignored) — the UI password and the cookie secret. Rotating the cookie secret logs
  every session out.
- Vendor credentials are **not** in this repo: each CLI keeps its own login under your home
  directory, and the jail mounts only that CLI's directory into that CLI's lane.

## Reporting a vulnerability

Please report privately, not as a public issue:

- GitHub → the repository's **Security** tab → *Report a vulnerability* (private advisory):
  <https://github.com/oldantique/fusion/security/advisories/new>
- or email: `TODO-maintainer-email`

Include the version or commit, what you did, and what you got. This is a personal project
maintained in someone's spare time: expect a reply in days, not hours, and no bounty.
