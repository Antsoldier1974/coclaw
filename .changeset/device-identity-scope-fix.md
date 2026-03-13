---
"@coclaw/openclaw-coclaw": patch
---

fix(plugin): add device identity to gateway WS connection for OpenClaw 3.12+ scope enforcement

OpenClaw 3.12 introduced a security fix (CVE GHSA-rqpp-rjj8-7wv8) that strips scopes from WS connections without device identity. This caused `nativeui.sessions.listAll` and `agent.identity.get` calls to fail with "missing scope" errors.

- Add `src/device-identity.js`: Ed25519 key pair generation, storage (`~/.openclaw/coclaw/device-identity.json`), and v3 auth payload signing
- Modify `realtime-bridge.js`: capture nonce from `connect.challenge`, build signed `device` field in connect params
- Device identity is auto-generated on first connection and cached for subsequent reconnects
- Backward compatible with OpenClaw >= 2026.2.19
