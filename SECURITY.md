# Security Policy

## Supported versions

Youtube Bilibili Digest is a small GitHub-only project. Security fixes are made on the latest code on `main` and, when releases are published, on the latest GitHub release. Older snapshots are not supported.

| Version | Supported |
|---|---|
| 17.x | Yes |
| < 17.0 | No |

## Report a vulnerability privately

Do **not** publish vulnerability details, exposed credentials, private video information, or transcript data through a public issue or pull request. This repository does not accept public security reports.

Use GitHub's private vulnerability reporting flow from this repository's **Security** tab when it is available. If the private reporting link is not visible, contact the repository owner **@StaffBao** through their GitHub profile (github.com/StaffBao) and ask for a private reporting channel, without including vulnerability details in the public message.

Include the following only in the private report:

- the affected version or commit;
- the minimum steps needed to reproduce the problem;
- the expected and observed behavior;
- the security and privacy impact; and
- a suggested fix, if you have one.

Remove real API keys, access tokens, private URLs, transcripts, notes, and personal information. Use redacted values and public test content.

There is no guaranteed response time and no bug-bounty program. Please allow a reasonable period for investigation and remediation before public disclosure.

## High-priority issues

Examples include:

- API keys or private content included in source, logs, screenshots, or release archives;
- requests to network origins outside the documented scope — that scope is the configured AI endpoint, the configured ASR endpoint, the Supadata API (`api.supadata.ai`) for YouTube captions, Bilibili's player and subtitle APIs (`/x/player/pagelist`, `/x/player/playurl`, `/x/player/wbi/v2`), and the platforms' own media CDNs (YouTube `googlevideo.com`, Bilibili `bilivideo` hosts) when ASR is enabled;
- script or HTML injection through transcript text, video metadata, service errors, or model output;
- access to browsing data outside the documented YouTube and Bilibili scope;
- unintended transmission of notes, transcripts, or credentials;
- a dependency or release-workflow compromise; and
- bypasses of local data deletion or AI endpoint configuration controls.

## User security guidance

- Install only from a GitHub source or release you trust.
- Review changes and the packaged file list before loading an update.
- Use dedicated, scoped API keys where possible and set provider spending limits.
- Do not reuse keys from production systems.
- Revoke keys immediately if a device, browser profile, archive, log, or screenshot exposes them.
- Remember that Chrome local extension storage is not an encrypted password vault.
- The extension uses your browser's own Bilibili login to fetch subtitles and, when you enable ASR, to resolve audio stream addresses. Treat your Bilibili account credentials as you normally would; the extension does not read or store your password.
- Exported files are written straight to your browser's default download folder with no save dialog. Plain-text transcript exports embed the video's full description — check them before sharing.

## No build or release automation

This repository ships no build step, no package manager, and no automated secret scanning: the files in the source tree are exactly what Chrome loads. Review the file list and the diff yourself before loading an update.

A `.gitignore` is included to keep local configuration (`config.js`, `.env`) and packaging artifacts (`*.pem`, `*.crx`, `*.zip`) out of commits, but it cannot undo a secret that has already been committed. If a key reaches a public branch, treat it as compromised and rotate it.

## Related documents

- [PRIVACY.html](PRIVACY.html) — what data the extension handles and where it goes
- [README.md](README.md) — installation, configuration, and the manual verification checklist
