# Third-party license inventory

UnboundVNC combines original code with independently licensed software. The
UnboundVNC Personal and Commercial License applies **only** to Patrick Sims's
original material. It does not restrict the rights granted under third-party
licenses, including their commercial-use rights.

| Candidate component | Upstream | License | Intended role |
| --- | --- | --- | --- |
| noVNC (`@novnc/novnc`) | [novnc/noVNC](https://github.com/novnc/noVNC) | Primarily MPL-2.0 for core JavaScript; other included assets have separate terms | Browser RFB viewer |
| node-rfb2 (`rfb2`) | [sidorares/node-rfb2](https://github.com/sidorares/node-rfb2) | MIT | Optional RFB client/server protocol tests and future integration |
| websockify | [novnc/websockify](https://github.com/novnc/websockify) | LGPL-3.0 (COPYING; verify individual files for additional notices) | Potential WebSocket-to-TCP reference or separately deployed bridge |

This table identifies upstream candidates, **not proof that they are bundled**
in a given build. Before distributing binaries or source packages:

1. Generate a component inventory from the exact resolved dependencies.
2. Preserve required copyright notices and full license texts.
3. For MPL-covered noVNC files, comply with the source-availability terms for
   those files and any modifications to them.
4. Treat noVNC's HTML/CSS/fonts/images separately: upstream identifies BSD,
   SIL OFL, and CC BY-SA terms in addition to the MPL core.
5. Check whether any LGPL or GPL component is linked, modified, or shipped
   and satisfy the corresponding distribution obligations. Do not silently
   incorporate GPL/AGPL implementation code into the proprietary product.
6. Retain a manifest mapping component version, source commit, license,
   distribution mode, and provenance to the exact release.

Upstream license sources:

- [noVNC LICENSE.txt](https://github.com/novnc/noVNC/blob/master/LICENSE.txt)
- [node-rfb2 LICENSE](https://github.com/sidorares/node-rfb2/blob/master/LICENSE)
- [websockify COPYING](https://github.com/novnc/websockify/blob/master/COPYING)

This inventory is an engineering compliance aid, not a legal opinion or
statement that the current development build has passed a license audit.
