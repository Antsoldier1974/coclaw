# Device Identity — 待优化项

> 背景：OpenClaw 3.12 引入 WS scope 权限机制（CVE GHSA-rqpp-rjj8-7wv8），无 device 身份的连接 scope 会被清空。
> 插件新增了 `src/device-identity.js`，在 `realtime-bridge.js` 连接 gateway 时附带 Ed25519 签名的 device 字段。

## TODO

### 1. 同步文件 I/O 改为异步

`loadOrCreateDeviceIdentity` 使用 `fs.existsSync` / `readFileSync` / `writeFileSync` / `generateKeyPairSync`，会阻塞 gateway 事件循环。

- 当前可接受：仅首次连接时执行一次（之后有内存缓存），耗时约 1-2ms，且与 OpenClaw 上游 `device-identity.ts` 的做法一致
- 优化方向：改为 `fs.promises.*` + `crypto.generateKeyPair`（异步版），需同步调整调用链——`__buildDeviceField` 和 `__sendGatewayConnectRequest` 都需改为 async，message handler 中的调用也需 await

### 2. connect.challenge 回调的 async 化

当前 `ws.addEventListener('message', (event) => { ... })` 中调用 `__sendGatewayConnectRequest` 是同步的。若上述 I/O 改为异步，此回调需变为 async，并确保并发 challenge 事件不会导致重复 connect 请求（需加锁或去重）。

### 3. device token 持久化（可选）

当前每次 gateway 重启后，插件都用 gateway auth token + device 签名完成认证。OpenClaw 支持在首次配对后返回 `deviceToken`，后续连接可用 `auth.deviceToken` 替代 shared token，减少对 shared token 的依赖。

- 需要在 hello-ok 响应中提取 `auth.deviceToken`
- 存储到 `~/.openclaw/coclaw/device-token.json`
- 重连时优先使用 deviceToken，失败时 fallback 到 shared token
