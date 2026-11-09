# Security Policy

## Reporting a Vulnerability

Report a vulnerability privately through GitHub. Open the Security tab of this repository and choose "Report a vulnerability".

**Do not open a public issue for security vulnerabilities.**


## Supported Versions

| Version        | Supported |
| -------------- | --------- |
| latest release | Yes       |

## Verifying a release

Release images are signed with cosign. To check an image's signature:

```
cosign verify ghcr.io/<owner>/nerla-server:<tag> \
  --certificate-identity-regexp '^https://github\.com/Emmyme/nerla/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Each release's SBOM is attached to its image as an attestation. To read it:

```
docker buildx imagetools inspect ghcr.io/<owner>/nerla-server:<tag> --format '{{ json .SBOM }}'
```

## Security Measures

Nerla includes the following security measures:

- **Automated secret scanning** via TruffleHog on every push and PR
- **Static analysis** via Semgrep and CodeQL
- **Dependency auditing** via `yarn npm audit` on every push and PR, and Dependabot security updates
- **Container scanning** via Grype on every push and PR, and weekly
- **Strong password enforcement** on signup and password reset
- **JWT-based authentication** with secure token storage
- **Input validation** via Zod schemas on all API endpoints
- **SQL injection prevention** via parameterized queries (Drizzle ORM)
