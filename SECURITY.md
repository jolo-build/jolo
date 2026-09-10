# Security policy

## Report a vulnerability

Do not put exploit details, credentials, owner tokens, or private conversation data in a public issue.

If the GitHub repository's Security tab offers **Report a vulnerability**, use that private reporting route. If it is unavailable, open an issue asking the maintainer for a private security contact, without disclosing vulnerability details. A dedicated reporting email has not yet been configured in this repository.

In a private report, include the affected Jolo version or commit, operating system, reproduction steps, expected boundary, and observed impact. Use a minimal reproduction with synthetic data where possible. There is no published response-time or supported-version commitment yet.

## Project boundaries

Jolo mediates its own tools and the operations exposed by hosted-agent transports. Hosted CLIs and commands run with the local user's privileges; Jolo does not provide OS containment of arbitrary same-user programs. Profiles isolate application state but currently share provider entries in the OS secret store.

Browser sessions and device credentials connect account identity and explicitly approved task access. They do not authorize local engine tools. Team permissions are checked by the Access service on each request. Task descriptions referenced in chat are sent to the selected coding agent.
