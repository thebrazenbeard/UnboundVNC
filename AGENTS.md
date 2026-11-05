# UnboundVNC contributor and agent instructions

## Product contract

- Build a standard RFB/VNC-compatible remote-desktop product first. Other protocols may be added later behind distinct adapters.
- Aim for a familiar remote-desktop workflow: saved devices, direct hostname/IP connection, credentials, session display, input, scaling and disconnect. Do not copy competitors' branding or artwork.
- Windows host/viewer is the first deployment target; keep Linux and browser interoperability testable.
- No mandatory paid service, hosted relay, account or recurring infrastructure charge. Optional private networking may be configured by the user.

## Security and evidence

- Do not expose unauthenticated RFB or WebSocket proxies on public interfaces. Prototypes bind to loopback by default; network exposure requires deliberate configuration and review.
- Do not treat a network path, viewer setting or VNC password as authorization for unattended access. Host consent, identity, transport security and revocation need distinct enforcement.
- Never bundle, record, log or commit credentials, private keys, screen content or clipboard data.
- Browser-side view-only mode is not an authorization boundary. A host/gateway must enforce protected capabilities.
- Distinguish SOURCE_INSPECTION, TEST, BUILD, INSTALL and REAL_SYSTEM_PROBE. Passing unit tests cannot establish deployed Windows remote-control behavior.
- Keep tests isolated; never target a real workstation without explicit current authorization.

## Licensing and source provenance

- Original UnboundVNC material follows its repository license: free personal use, separate commercial rights. This is source-available, **not** an OSI open-source license.
- Third-party code retains independent licenses and rights. Preserve required notices and source-availability obligations; do not silently relicense dependencies.
- Prefer direct dependencies on maintained libraries to copying code. Any vendored or modified third-party file must record exact origin, version, copyright and license.

## Change discipline

- Read current repository state and applicable tests before changing code.
- Implement the smallest end-to-end useful behavior, then validate both success and failure paths.
- Preserve unrelated work and avoid shared ports, services and runtime state. Source changes do not authorize installation, deployment, publishing, credential changes or destructive cleanup.
