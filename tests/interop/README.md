# RFB interoperability fixture (tests only)

Run from the repository root with Node.js 22+:

```sh
node --test tests/interop/*.test.mjs
```

`rfb-fixture.mjs` is a synthetic **loopback-only** (`127.0.0.1`, ephemeral port) RFB 3.8 server. It validates protocol bytes rather than mocking a socket. The fixture supports the RFB greeting, SecurityType None, 2×2 true-colour 32-bpp ServerInit, one Raw framebuffer update, keyboard, pointer, cut text, and selected malformed-message boundaries. Tests close all client connections and the server.

**Never use this fixture as a deployed remote desktop server.** RFB SecurityType None is intentionally insecure. This fixture does not provide TLS, authentication, host capture/input injection, ZRLE/Hextile/Tight, a real desktop, or proof of interoperability against an external VNC implementation. Future gateway/client tests should consume the fixture rather than infer production security from its protocol behaviour.
