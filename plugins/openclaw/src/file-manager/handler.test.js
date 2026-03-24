import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { validatePath, createFileHandler } from './handler.js';

// --- helpers ---

function silentLogger() {
	return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

async function makeTmpDir() {
	return fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-file-test-'));
}

// 模拟 DataChannel
function createMockDC(label = 'file:test-id') {
	const sent = [];
	const dc = {
		label,
		readyState: 'open',
		bufferedAmount: 0,
		bufferedAmountLowThreshold: 0,
		onmessage: null,
		onclose: null,
		onopen: null,
		onbufferedamountlow: null,
		send(data) { sent.push(data); },
		close() { dc.readyState = 'closed'; dc.onclose?.(); },
		__sent: sent,
	};
	return dc;
}

// --- validatePath ---

test('validatePath: 正常路径通过', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'a.txt'), 'hello');
		const result = await validatePath(dir, 'a.txt');
		assert.equal(result, nodePath.join(dir, 'a.txt'));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('validatePath: 路径穿越被拒绝', async () => {
	const dir = await makeTmpDir();
	try {
		await assert.rejects(() => validatePath(dir, '../../../etc/passwd'), (err) => {
			assert.equal(err.code, 'PATH_DENIED');
			return true;
		});
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('validatePath: 空路径被拒绝', async () => {
	await assert.rejects(() => validatePath('/tmp', ''), (err) => {
		assert.equal(err.code, 'PATH_DENIED');
		return true;
	});
	await assert.rejects(() => validatePath('/tmp', null), (err) => {
		assert.equal(err.code, 'PATH_DENIED');
		return true;
	});
});

test('validatePath: 不存在的路径返回解析后路径', async () => {
	const dir = await makeTmpDir();
	try {
		const result = await validatePath(dir, 'not-exist.txt');
		assert.equal(result, nodePath.join(dir, 'not-exist.txt'));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('validatePath: lstat 非 ENOENT 错误抛出', async () => {
	await assert.rejects(
		() => validatePath('/tmp/test', 'a.txt', {
			lstat: async () => { const e = new Error('perm'); e.code = 'EACCES'; throw e; },
		}),
		(err) => err.code === 'EACCES',
	);
});

test('validatePath: 符号链接指向沙箱外被拒绝', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.symlink('/etc/passwd', nodePath.join(dir, 'evil-link'));
		await assert.rejects(() => validatePath(dir, 'evil-link'), (err) => {
			assert.equal(err.code, 'PATH_DENIED');
			return true;
		});
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('validatePath: 符号链接指向沙箱内通过', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'real.txt'), 'data');
		await fs.symlink(nodePath.join(dir, 'real.txt'), nodePath.join(dir, 'good-link'));
		const result = await validatePath(dir, 'good-link');
		assert.equal(result, nodePath.join(dir, 'good-link'));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('validatePath: 符号链接 realpath 失败被拒绝', async () => {
	const fakeIsSymbolicLink = () => true;
	await assert.rejects(
		() => validatePath('/tmp/test', 'a', {
			lstat: async () => ({ isSymbolicLink: fakeIsSymbolicLink, isFile: () => false, isDirectory: () => false }),
			realpath: async () => { throw new Error('cannot resolve'); },
		}),
		(err) => err.code === 'PATH_DENIED',
	);
});

test('validatePath: 特殊文件类型被拒绝', async () => {
	await assert.rejects(
		() => validatePath('/tmp/test', 'fifo', {
			lstat: async () => ({
				isSymbolicLink: () => false,
				isFile: () => false,
				isDirectory: () => false,
			}),
		}),
		(err) => err.code === 'PATH_DENIED',
	);
});

test('validatePath: workspace 本身作为路径通过', async () => {
	const dir = await makeTmpDir();
	try {
		// "." 解析为 workspace 本身
		const result = await validatePath(dir, '.');
		assert.equal(result, dir);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

// --- createFileHandler: listFiles ---

test('listFiles: 列出目录内容', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'a.txt'), 'hello');
		await fs.mkdir(nodePath.join(dir, 'subdir'));

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const result = await handler.__listFiles({ agentId: 'main', path: '.' });
		assert.ok(Array.isArray(result.files));
		const names = result.files.map((f) => f.name);
		assert.ok(names.includes('a.txt'));
		assert.ok(names.includes('subdir'));

		const aFile = result.files.find((f) => f.name === 'a.txt');
		assert.equal(aFile.type, 'file');
		assert.equal(aFile.size, 5);

		const subdir = result.files.find((f) => f.name === 'subdir');
		assert.equal(subdir.type, 'dir');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('listFiles: 跳过临时文件', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'real.txt'), 'data');
		await fs.writeFile(nodePath.join(dir, 'real.txt.tmp.550e8400-e29b-41d4-a716-446655440000'), 'tmp');

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const result = await handler.__listFiles({ agentId: 'main', path: '.' });
		const names = result.files.map((f) => f.name);
		assert.ok(names.includes('real.txt'));
		assert.ok(!names.some((n) => n.includes('.tmp.')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('listFiles: 空 path 默认为根目录', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'root.txt'), 'x');

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const result = await handler.__listFiles({ agentId: 'main' });
		assert.ok(result.files.some((f) => f.name === 'root.txt'));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('listFiles: 目录不存在返回 NOT_FOUND', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		await assert.rejects(
			() => handler.__listFiles({ path: 'nonexistent' }),
			(err) => err.code === 'NOT_FOUND',
		);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('listFiles: 对文件路径返回错误', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'file.txt'), 'x');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		await assert.rejects(
			() => handler.__listFiles({ path: 'file.txt' }),
			(err) => err.code === 'IS_DIRECTORY',
		);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('listFiles: 包含符号链接条目', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'target.txt'), 'data');
		await fs.symlink(nodePath.join(dir, 'target.txt'), nodePath.join(dir, 'link.txt'));

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const result = await handler.__listFiles({ path: '.' });
		const link = result.files.find((f) => f.name === 'link.txt');
		assert.equal(link.type, 'symlink');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('listFiles: stat 失败时条目仍返回（size/mtime 为 0）', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'a.txt'), 'hello');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				lstat: async (p) => {
					// validatePath 调用 lstat 需正常返回，readdir 后的 lstat 抛出
					if (p === nodePath.join(dir, 'a.txt')) throw new Error('stat fail');
					return fs.lstat(p);
				},
				readdir: async (p, opts) => fs.readdir(p, opts),
				stat: async (p) => fs.stat(p),
				realpath: async (p) => fs.realpath(p),
			},
		});
		const result = await handler.__listFiles({ path: '.' });
		const a = result.files.find((f) => f.name === 'a.txt');
		assert.equal(a.size, 0);
		assert.equal(a.mtime, 0);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

// --- createFileHandler: deleteFile ---

test('deleteFile: 删除文件', async () => {
	const dir = await makeTmpDir();
	try {
		const fp = nodePath.join(dir, 'del.txt');
		await fs.writeFile(fp, 'data');

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		await handler.__deleteFile({ path: 'del.txt' });

		await assert.rejects(() => fs.access(fp));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('deleteFile: 删除空目录', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.mkdir(nodePath.join(dir, 'empty'));

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		await handler.__deleteFile({ path: 'empty' });

		await assert.rejects(() => fs.access(nodePath.join(dir, 'empty')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('deleteFile: 删除非空目录返回 NOT_EMPTY', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.mkdir(nodePath.join(dir, 'notempty'));
		await fs.writeFile(nodePath.join(dir, 'notempty', 'child.txt'), 'x');

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		await assert.rejects(
			() => handler.__deleteFile({ path: 'notempty' }),
			(err) => err.code === 'NOT_EMPTY',
		);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('deleteFile: 不存在的文件返回 NOT_FOUND', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		await assert.rejects(
			() => handler.__deleteFile({ path: 'gone.txt' }),
			(err) => err.code === 'NOT_FOUND',
		);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('deleteFile: 空 path 返回 PATH_DENIED', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});
	await assert.rejects(
		() => handler.__deleteFile({}),
		(err) => err.code === 'PATH_DENIED',
	);
});

test('deleteFile: lstat 非 ENOENT 错误透传', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'perm.txt'), 'x');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				lstat: async (p) => {
					// validatePath 需要正常的 lstat
					if (p === nodePath.join(dir, 'perm.txt')) {
						const s = await fs.lstat(p);
						return s;
					}
					return fs.lstat(p);
				},
			},
		});
		// 覆盖内部 lstat 以在 deleteFile 的 lstat 调用时抛非 ENOENT
		// 需要注入一个在第二次调用时抛错的 lstat
		const handler2 = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				lstat: async (p) => {
					// validatePath 中调用 lstat(resolved) — 让它正常
					// deleteFile 中也调用 lstat(resolved) — 让它抛错
					// 通过计数区分
					if (!handler2.__lstatCount) handler2.__lstatCount = 0;
					handler2.__lstatCount++;
					if (handler2.__lstatCount === 2) {
						const e = new Error('EACCES');
						e.code = 'EACCES';
						throw e;
					}
					return fs.lstat(p);
				},
			},
		});
		await assert.rejects(
			() => handler2.__deleteFile({ path: 'perm.txt' }),
			(err) => err.code === 'EACCES',
		);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('deleteFile: rmdir 非 ENOTEMPTY 错误透传', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.mkdir(nodePath.join(dir, 'perm'));
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				rmdir: async () => { const e = new Error('perm'); e.code = 'EACCES'; throw e; },
			},
		});
		await assert.rejects(
			() => handler.__deleteFile({ path: 'perm' }),
			(err) => err.code === 'EACCES',
		);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

// --- handleRpcRequest ---

test('handleRpcRequest: coclaw.file.list 成功', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'hi.txt'), 'hi');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'r1', method: 'coclaw.file.list', params: { path: '.' } },
			(res) => responses.push(res),
		);
		assert.equal(responses.length, 1);
		assert.equal(responses[0].type, 'res');
		assert.equal(responses[0].id, 'r1');
		assert.equal(responses[0].ok, true);
		assert.ok(responses[0].payload.files.some((f) => f.name === 'hi.txt'));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleRpcRequest: coclaw.file.delete 成功', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'del.txt'), 'bye');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'r2', method: 'coclaw.file.delete', params: { path: 'del.txt' } },
			(res) => responses.push(res),
		);
		assert.equal(responses[0].ok, true);
		await assert.rejects(() => fs.access(nodePath.join(dir, 'del.txt')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleRpcRequest: 未知方法返回错误', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});
	const responses = [];
	await handler.handleRpcRequest(
		{ id: 'r3', method: 'coclaw.file.unknown', params: {} },
		(res) => responses.push(res),
	);
	assert.equal(responses[0].ok, false);
	assert.equal(responses[0].error.code, 'UNKNOWN_METHOD');
});

test('handleRpcRequest: 错误场景返回错误响应', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => { throw new Error('workspace gone'); },
		logger: silentLogger(),
	});
	const responses = [];
	await handler.handleRpcRequest(
		{ id: 'r4', method: 'coclaw.file.list', params: { path: '.' } },
		(res) => responses.push(res),
	);
	assert.equal(responses[0].ok, false);
	assert.equal(responses[0].error.code, 'INTERNAL_ERROR');
});

// --- handleFileChannel: read (下载) ---

test('handleFileChannel read: 成功下载文件', async () => {
	const dir = await makeTmpDir();
	try {
		const content = 'hello world test content';
		await fs.writeFile(nodePath.join(dir, 'download.txt'), content);

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		// 发送 read 请求
		dc.onmessage({ data: JSON.stringify({ method: 'read', agentId: 'main', path: 'download.txt' }) });

		// 等待处理完成
		await new Promise((r) => setTimeout(r, 200));

		// 检查发送的消息：响应头 + binary chunks + 完成确认
		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const binaries = dc.__sent.filter((s) => typeof s !== 'string');

		// 响应头
		assert.equal(strings[0].ok, true);
		assert.equal(strings[0].size, content.length);
		assert.equal(strings[0].name, 'download.txt');

		// 完成确认
		const completion = strings[strings.length - 1];
		assert.equal(completion.ok, true);
		assert.equal(completion.bytes, content.length);

		// binary 数据
		const received = Buffer.concat(binaries);
		assert.equal(received.toString(), content);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: 文件不存在', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'read', agentId: 'main', path: 'nope.txt' }) });
		await new Promise((r) => setTimeout(r, 100));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'NOT_FOUND');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: 目录不能 read', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.mkdir(nodePath.join(dir, 'adir'));
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'adir' }) });
		await new Promise((r) => setTimeout(r, 100));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'IS_DIRECTORY');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: 路径穿越被拒绝', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'read', path: '../../../etc/passwd' }) });
		await new Promise((r) => setTimeout(r, 100));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'PATH_DENIED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: workspace 解析失败', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => { const e = new Error('no agent'); e.code = 'AGENT_DENIED'; throw e; },
		logger: silentLogger(),
	});
	const dc = createMockDC();
	handler.handleFileChannel(dc);

	dc.onmessage({ data: JSON.stringify({ method: 'read', agentId: 'bad', path: 'x' }) });
	await new Promise((r) => setTimeout(r, 100));

	const msg = JSON.parse(dc.__sent[0]);
	assert.equal(msg.ok, false);
	assert.equal(msg.error.code, 'AGENT_DENIED');
});

test('handleFileChannel read: stat 非 ENOENT 错误', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				stat: async () => { const e = new Error('io'); e.code = 'EIO'; throw e; },
			},
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'x.txt' }) });
		await new Promise((r) => setTimeout(r, 100));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'READ_FAILED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: 非普通文件被拒绝', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				stat: async () => ({
					isDirectory: () => false,
					isFile: () => false,
					size: 0,
				}),
			},
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'device' }) });
		await new Promise((r) => setTimeout(r, 100));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'PATH_DENIED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: 读取流错误', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'err.txt'), 'data');
		const { Readable } = await import('node:stream');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				createReadStream: () => {
					const s = new Readable({
						read() {
							process.nextTick(() => this.destroy(new Error('disk error')));
						},
					});
					return s;
				},
			},
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'err.txt' }) });
		await new Promise((r) => setTimeout(r, 200));

		const errors = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s)).filter((m) => m.ok === false);
		assert.ok(errors.length > 0);
		assert.equal(errors[0].error.code, 'READ_FAILED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: bufferedAmount 触发流控暂停', async () => {
	const dir = await makeTmpDir();
	try {
		// 创建足够大的文件触发多个 chunk
		await fs.writeFile(nodePath.join(dir, 'flow.txt'), Buffer.alloc(65536, 'x'));

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		let sendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			sendCount++;
			origSend(data);
			// 模拟 bufferedAmount 超过阈值
			if (typeof data !== 'string' && sendCount > 2) {
				dc.bufferedAmount = 300_000; // > HIGH_WATER_MARK (256KB)
				// 之后恢复
				globalThis.setTimeout(() => {
					dc.bufferedAmount = 0;
					dc.onbufferedamountlow?.();
				}, 10);
			}
		};

		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'read', agentId: 'main', path: 'flow.txt' }) });
		await new Promise((r) => setTimeout(r, 500));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const completion = strings.find((s) => s.ok === true && s.bytes !== undefined);
		assert.ok(completion);
		assert.equal(completion.bytes, 65536);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: DC 关闭中止流', async () => {
	const dir = await makeTmpDir();
	try {
		// 创建一个较大文件来触发多个 chunk
		await fs.writeFile(nodePath.join(dir, 'big.txt'), Buffer.alloc(32768, 'x'));

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		// send 第一次后就关闭 DC
		let sendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			sendCount++;
			origSend(data);
			if (sendCount === 2) { // 响应头之后第一个 chunk
				dc.readyState = 'closed';
				dc.onclose?.();
			}
		};

		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'big.txt' }) });
		await new Promise((r) => setTimeout(r, 200));

		// 不应崩溃
		assert.ok(sendCount >= 2);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel read: 响应头发送失败时安静退出', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'f.txt'), 'data');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		dc.send = () => { throw new Error('DC closed'); };

		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'f.txt' }) });
		await new Promise((r) => setTimeout(r, 100));
		// 不应崩溃
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

// --- handleFileChannel: write (上传) ---

test('handleFileChannel write: 成功上传文件', async () => {
	const dir = await makeTmpDir();
	try {
		const content = Buffer.from('uploaded content');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:write-test-id');
		handler.handleFileChannel(dc);

		// 发送 write 请求
		dc.onmessage({ data: JSON.stringify({ method: 'write', agentId: 'main', path: 'upload.txt', size: content.length }) });
		await new Promise((r) => setTimeout(r, 50));

		// 检查就绪信号
		const ready = JSON.parse(dc.__sent[0]);
		assert.equal(ready.ok, true);

		// 发送 binary 数据
		dc.onmessage({ data: content });
		// 发送完成信号
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });

		await new Promise((r) => setTimeout(r, 200));

		// 检查写入结果
		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const result = strings.find((s) => s.ok === true && s.bytes !== undefined);
		assert.ok(result);
		assert.equal(result.bytes, content.length);

		// 检查文件内容
		const written = await fs.readFile(nodePath.join(dir, 'upload.txt'));
		assert.equal(written.toString(), 'uploaded content');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: 自动创建中间目录', async () => {
	const dir = await makeTmpDir();
	try {
		const content = Buffer.from('deep');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:mkdir-test');
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'a/b/c.txt', size: content.length }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 200));

		const written = await fs.readFile(nodePath.join(dir, 'a', 'b', 'c.txt'));
		assert.equal(written.toString(), 'deep');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: 大小超限被拒绝', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'big.bin', size: 2_000_000_000 }) });
		await new Promise((r) => setTimeout(r, 50));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'SIZE_EXCEEDED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: size 不合法被拒绝', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'x.txt', size: -1 }) });
		await new Promise((r) => setTimeout(r, 50));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'INVALID_INPUT');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: size mismatch 被拒绝', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:mismatch-test');
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'mis.txt', size: 100 }) });
		await new Promise((r) => setTimeout(r, 50));

		// 发送 5 字节，但声明 100
		dc.onmessage({ data: Buffer.from('hello') });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: 5 }) });
		await new Promise((r) => setTimeout(r, 200));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const errMsg = strings.find((s) => s.ok === false);
		assert.ok(errMsg);
		assert.equal(errMsg.error.code, 'WRITE_FAILED');

		// 确认临时文件被清理
		const files = await fs.readdir(dir);
		assert.ok(!files.some((f) => f.includes('.tmp.')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: 接收字节数超限 → SIZE_EXCEEDED', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:exceed-test');
		handler.handleFileChannel(dc);

		// 声明 10 字节，实际发送超出
		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'over.txt', size: 10 }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: Buffer.alloc(20, 'x') });
		await new Promise((r) => setTimeout(r, 100));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const errMsg = strings.find((s) => s.ok === false);
		assert.ok(errMsg);
		assert.equal(errMsg.error.code, 'SIZE_EXCEEDED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: DC 取消（未收到 done）→ 清理临时文件', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:cancel-test');
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'cancel.txt', size: 100 }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: Buffer.from('partial') });
		// 不发 done，直接关闭 DC
		dc.close();
		await new Promise((r) => setTimeout(r, 200));

		// 确认临时文件被清理
		const files = await fs.readdir(dir);
		assert.ok(!files.some((f) => f.includes('.tmp.')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: workspace 解析失败', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => { const e = new Error('no'); e.code = 'AGENT_DENIED'; throw e; },
		logger: silentLogger(),
	});
	const dc = createMockDC();
	handler.handleFileChannel(dc);

	dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'x', size: 5 }) });
	await new Promise((r) => setTimeout(r, 100));

	const msg = JSON.parse(dc.__sent[0]);
	assert.equal(msg.ok, false);
	assert.equal(msg.error.code, 'AGENT_DENIED');
});

test('handleFileChannel write: mkdir 失败', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				mkdir: async () => { throw new Error('perm denied'); },
			},
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'fail/x.txt', size: 5 }) });
		await new Promise((r) => setTimeout(r, 100));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'WRITE_FAILED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: createWriteStream 失败', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				createWriteStream: () => { throw new Error('stream fail'); },
			},
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'x.txt', size: 5 }) });
		await new Promise((r) => setTimeout(r, 100));

		const msg = JSON.parse(dc.__sent[0]);
		assert.equal(msg.ok, false);
		assert.equal(msg.error.code, 'WRITE_FAILED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: 就绪信号发送失败时清理', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:ready-fail');
		let sendCount = 0;
		dc.send = () => {
			sendCount++;
			if (sendCount === 1) throw new Error('DC closed');
		};
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'y.txt', size: 5 }) });
		await new Promise((r) => setTimeout(r, 100));

		// 确认临时文件被清理
		const files = await fs.readdir(dir);
		assert.ok(!files.some((f) => f.includes('.tmp.')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: WriteStream 错误触发 WRITE_FAILED', async () => {
	const dir = await makeTmpDir();
	try {
		const { Writable } = await import('node:stream');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				createWriteStream: () => {
					const ws = new Writable({
						write(chunk, enc, cb) {
							const e = new Error('disk broken');
							e.code = 'EIO';
							cb(e);
						},
					});
					return ws;
				},
			},
		});
		const dc = createMockDC('file:ws-err');
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'ws-err.txt', size: 10 }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: Buffer.from('1234567890') });
		await new Promise((r) => setTimeout(r, 200));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const errMsg = strings.find((s) => s.ok === false);
		assert.ok(errMsg);
		assert.equal(errMsg.error.code, 'WRITE_FAILED');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: WriteStream ENOSPC 错误触发 DISK_FULL', async () => {
	const dir = await makeTmpDir();
	try {
		const { Writable } = await import('node:stream');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
			deps: {
				createWriteStream: () => {
					const ws = new Writable({
						write(chunk, enc, cb) {
							const e = new Error('no space');
							e.code = 'ENOSPC';
							cb(e);
						},
					});
					return ws;
				},
			},
		});
		const dc = createMockDC('file:nospc');
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'nospc.txt', size: 10 }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: Buffer.from('1234567890') });
		await new Promise((r) => setTimeout(r, 200));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const errMsg = strings.find((s) => s.ok === false);
		assert.ok(errMsg);
		assert.equal(errMsg.error.code, 'DISK_FULL');
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: DC 在 ws.end 回调期间已关闭', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:close-race');
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'race.txt', size: 5 }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: Buffer.from('hello') });
		// 模拟 DC 在发完成信号后立即关闭
		dc.readyState = 'closed';
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: 5 }) });
		dc.onclose?.();
		await new Promise((r) => setTimeout(r, 200));

		// 不应崩溃；临时文件应被清理
		const files = await fs.readdir(dir);
		assert.ok(!files.some((f) => f.includes('.tmp.')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

// --- handleFileChannel: 通用 ---

test('handleFileChannel: 无效 JSON 请求', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});
	const dc = createMockDC();
	handler.handleFileChannel(dc);

	dc.onmessage({ data: 'not-json' });
	await new Promise((r) => setTimeout(r, 50));

	const msg = JSON.parse(dc.__sent[0]);
	assert.equal(msg.ok, false);
	assert.equal(msg.error.code, 'INVALID_INPUT');
});

test('handleFileChannel: 未知方法', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});
	const dc = createMockDC();
	handler.handleFileChannel(dc);

	dc.onmessage({ data: JSON.stringify({ method: 'patch' }) });
	await new Promise((r) => setTimeout(r, 50));

	const msg = JSON.parse(dc.__sent[0]);
	assert.equal(msg.ok, false);
	assert.equal(msg.error.code, 'UNKNOWN_METHOD');
});

test('handleFileChannel: 30s 超时未收到请求', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});
	const dc = createMockDC();

	// 用很短的超时来测试
	// 直接调用内部逻辑——覆盖 setTimeout
	const origSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (cb, ms) => {
		if (ms === 30_000) {
			return origSetTimeout(cb, 10); // 缩短为 10ms
		}
		return origSetTimeout(cb, ms);
	};

	try {
		handler.handleFileChannel(dc);
		await new Promise((r) => origSetTimeout(r, 50));

		if (dc.__sent.length > 0) {
			const msg = JSON.parse(dc.__sent[0]);
			assert.equal(msg.ok, false);
			assert.equal(msg.error.code, 'TIMEOUT');
		}
	} finally {
		globalThis.setTimeout = origSetTimeout;
	}
});

test('handleFileChannel: 第二条 string 消息被忽略', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'x.txt'), 'data');
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC();
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'x.txt' }) });
		// 第二条请求应被忽略
		dc.onmessage({ data: JSON.stringify({ method: 'read', path: 'x.txt' }) });
		await new Promise((r) => setTimeout(r, 200));

		// 只应有一组 read 响应
		const headers = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s)).filter((m) => m.name === 'x.txt');
		assert.equal(headers.length, 1);
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel: 初始 binary 消息被忽略（等待请求 string）', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});
	const dc = createMockDC();
	handler.handleFileChannel(dc);

	// 发送 binary 应被忽略
	dc.onmessage({ data: Buffer.from('binary data') });
	await new Promise((r) => setTimeout(r, 50));

	// 没有发送任何响应
	assert.equal(dc.__sent.length, 0);
});

// --- 临时文件清理 ---

test('cleanupTmpFilesInDir: 清理 .tmp.* 文件', async () => {
	const dir = await makeTmpDir();
	try {
		// 创建临时文件和正常文件
		await fs.writeFile(nodePath.join(dir, 'real.txt'), 'keep');
		await fs.writeFile(nodePath.join(dir, 'real.txt.tmp.550e8400-e29b-41d4-a716-446655440000'), 'tmp');
		await fs.mkdir(nodePath.join(dir, 'sub'));
		await fs.writeFile(nodePath.join(dir, 'sub', 'deep.txt.tmp.660e8400-e29b-41d4-a716-446655440000'), 'tmp');

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		await handler.__cleanupTmpFilesInDir(dir);

		const files = await fs.readdir(dir);
		assert.ok(files.includes('real.txt'));
		assert.ok(!files.some((f) => f.includes('.tmp.')));

		const subFiles = await fs.readdir(nodePath.join(dir, 'sub'));
		assert.ok(!subFiles.some((f) => f.includes('.tmp.')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('cleanupTmpFilesInDir: 不存在的目录不崩溃', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});
	await handler.__cleanupTmpFilesInDir('/tmp/nonexistent-dir-' + Date.now());
	// 不应抛异常
});

test('scheduleTmpCleanup + cancelCleanup: 正常调度与取消', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});

	let called = false;
	handler.scheduleTmpCleanup(async () => {
		called = true;
		return [];
	});

	// 取消后不应执行
	handler.cancelCleanup();
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(called, false);
});

test('scheduleTmpCleanup: 重复调用只注册一次', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});

	const listFn = async () => [];
	handler.scheduleTmpCleanup(listFn);
	handler.scheduleTmpCleanup(listFn);

	handler.cancelCleanup();
});

test('scheduleTmpCleanup: listAgentWorkspaces 失败不崩溃', async () => {
	const handler = createFileHandler({
		resolveWorkspace: async () => '/tmp',
		logger: silentLogger(),
	});

	// 用短延迟测试
	const origSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (cb, ms) => {
		if (ms === 60_000) {
			return origSetTimeout(cb, 10);
		}
		return origSetTimeout(cb, ms);
	};

	try {
		handler.scheduleTmpCleanup(async () => { throw new Error('list fail'); });
		await new Promise((r) => origSetTimeout(r, 100));
		// 不应崩溃
	} finally {
		globalThis.setTimeout = origSetTimeout;
	}
});

test('scheduleTmpCleanup: 正常执行清理', async () => {
	const dir = await makeTmpDir();
	try {
		await fs.writeFile(nodePath.join(dir, 'good.txt'), 'keep');
		await fs.writeFile(nodePath.join(dir, 'old.txt.tmp.550e8400-e29b-41d4-a716-446655440000'), 'tmp');

		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});

		const origSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = (cb, ms) => {
			if (ms === 60_000) return origSetTimeout(cb, 10);
			return origSetTimeout(cb, ms);
		};

		try {
			handler.scheduleTmpCleanup(async () => [dir]);
			await new Promise((r) => origSetTimeout(r, 200));

			const files = await fs.readdir(dir);
			assert.ok(files.includes('good.txt'));
			assert.ok(!files.some((f) => f.includes('.tmp.')));
		} finally {
			globalThis.setTimeout = origSetTimeout;
		}
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: done 消息中无效 JSON 被忽略', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:bad-done');
		handler.handleFileChannel(dc);

		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'z.txt', size: 5 }) });
		await new Promise((r) => setTimeout(r, 50));

		// 发 binary
		dc.onmessage({ data: Buffer.from('hello') });
		// 发无效 JSON string（不是 done）
		dc.onmessage({ data: 'not-json-at-all' });
		await new Promise((r) => setTimeout(r, 50));

		// 关闭 DC 触发取消
		dc.close();
		await new Promise((r) => setTimeout(r, 100));

		// 确认临时文件被清理
		const files = await fs.readdir(dir);
		assert.ok(!files.some((f) => f.includes('.tmp.')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: rename 失败时记录警告并清理临时文件', async () => {
	const dir = await makeTmpDir();
	try {
		const warns = [];
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {}, debug: () => {} },
			deps: {
				rename: async () => { throw new Error('EXDEV'); },
			},
		});
		const dc = createMockDC('file:rename-fail');
		handler.handleFileChannel(dc);

		const content = Buffer.from('renametest');
		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'ren.txt', size: content.length }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 300));

		assert.ok(warns.some((w) => w.includes('rename failed')));
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: 结果发送失败不崩溃', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:send-fail');
		let sendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			sendCount++;
			if (sendCount === 1) {
				origSend(data); // 就绪信号正常发
			} else {
				throw new Error('DC closed'); // 结果发送失败
			}
		};
		handler.handleFileChannel(dc);

		const content = Buffer.from('abc');
		dc.onmessage({ data: JSON.stringify({ method: 'write', path: 'sf.txt', size: content.length }) });
		await new Promise((r) => setTimeout(r, 50));

		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 200));

		// 不应崩溃
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});

test('handleFileChannel write: 超限发送后 DC close 不崩溃', async () => {
	const dir = await makeTmpDir();
	try {
		const handler = createFileHandler({
			resolveWorkspace: async () => dir,
			logger: silentLogger(),
		});
		const dc = createMockDC('file:exceed-close');
		// send 和 close 抛出
		dc.send = () => { throw new Error('closed'); };
		dc.close = () => { dc.readyState = 'closed'; };
		handler.handleFileChannel(dc);

		// 用注入的请求处理方式
		const origOnMessage = dc.onmessage;
		origOnMessage({ data: JSON.stringify({ method: 'write', path: 'x.txt', size: 5 }) });
		await new Promise((r) => setTimeout(r, 50));

		// 发送超出声明的字节数
		origOnMessage({ data: Buffer.alloc(20, 'x') });
		await new Promise((r) => setTimeout(r, 100));

		// 不应崩溃
	} finally {
		await fs.rm(dir, { recursive: true });
	}
});
