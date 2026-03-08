import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { main } from './cli.js';
import { saveHomedir, setHomedir, restoreHomedir } from './homedir-mock.helper.js';
import { createMockServer } from './mock-server.helper.js';
import { setRuntime } from './runtime.js';
import { getBindingsPath, readConfig } from './config.js';

test('standalone mode: bind then unbind should succeed', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-tunnel-standalone-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime(null);
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const mock = await createMockServer();

	try {
		const bindCode = await main(['bind', '12345678', '--server', mock.baseUrl]);
		assert.equal(bindCode, 0);

		const bindingsPath = getBindingsPath();
		const raw = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
		assert.equal(raw.default.botId, '9001');
		assert.equal(raw.default.token, 'mock-token-1');

		const unbindCode = await main(['unbind', '--server', mock.baseUrl]);
		assert.equal(unbindCode, 0);

		// bindings.json 应被删除
		const cfg = await readConfig();
		assert.equal(cfg.token, undefined);
	}
	finally {
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});
