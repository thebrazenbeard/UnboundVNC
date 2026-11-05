# UnboundVNC

**Your machines. Your network. Your control.**

UnboundVNC is a Windows-first, standards-compatible remote desktop project.
The goal is the familiar ease of a personal VNC application—saved computers,
one-click connections, clear connection status, and a full-screen remote
desktop—with its own interface and no compulsory paid account or hosted relay.
Unlike a proprietary remote-desktop protocol, the initial implementation
targets **standard RFB/VNC interoperability** with existing compatible VNC
clients and servers. Additional protocol adapters may come later.

> **Early development:** A local RFB viewer/gateway and protocol test harness
> are the first implementation slice. There is not yet a qualified Windows
> host installer, public internet relay, unattended-access service, or
> RealVNC feature-parity release. Source presence does not prove an installed
> or secure remote-control runtime.

## Product principles

- **Familiar workflows, distinct design:** A device dashboard, add/pair or
  connect flow, live desktop canvas, scaling, full-screen controls, clear
  errors and local disconnect. No RealVNC code, artwork, trademarks, or visual
  identity is reused.
- **RFB first:** Connect to existing VNC servers; develop independently
  testable client and server behavior against [RFC 6143](https://www.rfc-editor.org/rfc/rfc6143.html).
- **Private by default:** Local connections and explicitly configured private
  networking first. No required vendor cloud, subscription, public listener,
  router port-forwarding, or mandatory relay.
- **Real authority:** Network reachability alone is not permission for input,
  unattended access, clipboard, files, recording, or process execution.
- **$0 operating baseline:** Build and local/private-network use must not
  require paid services. Electricity, bandwidth, and any voluntarily hosted
  infrastructure remain the operator's responsibility.

## Intended first-user workflow

1. Open UnboundVNC and see named, saved computers.
2. Add an existing VNC server by hostname or private IP address and its port.
3. Start a connection; provide credentials when the server requests them.
4. View and, when authorized, control the remote desktop. Switch between
   view-only, scaling and full-screen modes, then disconnect.
5. Later host releases will add consent-driven pairing and unattended access;
   those controls are not assumed to exist in today's viewer prototype.

## Code organization

Development is organized around independently testable components:

| Area | Responsibility |
| --- | --- |
| `apps/viewer/` | Device dashboard and browser-based RFB viewer |
| `apps/gateway/` | Local-only WebSocket-to-TCP RFB bridge and session admission |
| `tests/interop/` | Standard RFB protocol fixtures and compatibility checks |
| `docs/` | Product acceptance and security boundaries |

Each component should document its own development commands. Full host-to-host
acceptance requires actual Windows devices and must not be inferred from a
local browser or synthetic RFB test.

## Licensing

The original UnboundVNC material is **source-available proprietary software**
under the [UnboundVNC Personal and Commercial License](LICENSE): unlimited
genuine personal use is free; for-profit business use requires a separate
written [commercial license](COMMERCIAL_LICENSE.md). It is **not** an
OSI-approved open-source license. This is separate from the licenses granted
by our [third-party dependencies](THIRD_PARTY_NOTICES.md).

License wording is a working proposal for owner review before release. No
commercial fee or third-party use restriction has been invented here.

## Security and acceptance

Read the [security boundary](docs/SECURITY_BOUNDARIES.md) and
[initial release gates](docs/RELEASE_GATES.md) before exposing any remote
access interface. A browser that displays a VNC server does not yet qualify
secure unattended access or a remotely installed Windows host.
