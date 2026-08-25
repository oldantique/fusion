---
name: Bug report
about: A lane fails, the UI misbehaves, or something does not do what the docs say
title: ''
labels: bug
assignees: ''
---

**What happened, and what you expected instead**

**How to reproduce it** — the question you asked (or the steps), which models were ticked, and
whether it happens every time.

**Which lane(s)** — claude / codex / kimi / grok / the synthesizer / not a lane.

**`npm run doctor`** (says which CLIs are installed and logged in, and whether the jail works):

```
paste the output
```

**`npm run check-updates`** (a CLI newer than the version the parsers were verified against is
the usual cause of a lane that broke on its own):

```
paste the output
```

**Versions** — the CLI versions from the run above, your Node version (`node --version`), your
OS/distro, and the Fusion commit (`git rev-parse --short HEAD`).

**Logs** — the lane's error badge text, and the server log around the failure
(`journalctl --user -u fusion` if you run it as a service). Please redact anything private: the
question text and answers may be in there.
