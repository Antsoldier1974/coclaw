import fs from 'node:fs';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';

// --- 常量 ---

const CHUNK_SIZE = 16_384; // 16KB
const HIGH_WATER_MARK = 262_144; // 256KB
const LOW_WATER_MARK = 65_536; // 64KB
const MAX_UPLOAD_SIZE = 1_073_741_824; // 1GB
const FILE_DC_TIMEOUT_MS = 30_000; // DC 打开后 30s 内需收到请求
const TMP_CLEANUP_DELAY_MS = 60_000; // 启动后 60s 延迟清理
const TMP_FILE_PATTERN = /\.tmp\.[0-9a-f-]{36}$/;

// --- 路径安全校验 ---

/**
 * 校验 userPath 是否在 workspaceDir 沙箱内，返回解析后的绝对路径。
 * 校验内容：路径穿越、符号链接指向沙箱外、特殊文件类型。
 * @param {string} workspaceDir - workspace 绝对路径
 * @param {string} userPath - 用户提供的相对路径
 * @param {object} [deps] - 可注入依赖（测试用）
 * @returns {Promise<string>} 解析后的绝对路径
 */
export async function validatePath(workspaceDir, userPath, deps = {}) {
	const _lstat = deps.lstat ?? fsp.lstat;

	if (!userPath || typeof userPath !== 'string') {
		const err = new Error('Path is required');
		err.code = 'PATH_DENIED';
		throw err;
	}

	const resolved = nodePath.resolve(workspaceDir, userPath);

	// 路径穿越检查
	if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + nodePath.sep)) {
		const err = new Error(`Path traversal denied: ${userPath}`);
		err.code = 'PATH_DENIED';
		throw err;
	}

	// 符号链接 & 文件类型检查（仅对已存在的路径）
	let stat;
	try {
		stat = await _lstat(resolved);
	} catch (e) {
		// 路径不存在 — 对 write 场景合法，后续操作自行判断
		if (e.code === 'ENOENT') return resolved;
		throw e;
	}

	// 符号链接：检查实际目标是否在 workspace 内
	if (stat.isSymbolicLink()) {
		let realTarget;
		try {
			realTarget = await (deps.realpath ?? fsp.realpath)(resolved);
		} catch {
			const err = new Error(`Cannot resolve symlink: ${userPath}`);
			err.code = 'PATH_DENIED';
			throw err;
		}
		if (realTarget !== workspaceDir && !realTarget.startsWith(workspaceDir + nodePath.sep)) {
			const err = new Error(`Symlink target outside workspace: ${userPath}`);
			err.code = 'PATH_DENIED';
			throw err;
		}
	}

	// 仅允许普通文件和目录
	if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
		const err = new Error(`Special file type denied: ${userPath}`);
		err.code = 'PATH_DENIED';
		throw err;
	}

	return resolved;
}

// --- File Handler 工厂 ---

/**
 * @param {object} opts
 * @param {function} opts.resolveWorkspace - (agentId) => Promise<string> 返回 workspace 绝对路径
 * @param {object} [opts.logger]
 * @param {object} [opts.deps] - 可注入依赖（测试用）
 */
export function createFileHandler({ resolveWorkspace, logger, deps = {} }) {
	/* c8 ignore next -- ?? fallback */
	const log = logger ?? console;
	const _lstat = deps.lstat ?? fsp.lstat;
	const _readdir = deps.readdir ?? fsp.readdir;
	const _unlink = deps.unlink ?? fsp.unlink;
	const _rmdir = deps.rmdir ?? fsp.rmdir;
	const _stat = deps.stat ?? fsp.stat;
	const _mkdir = deps.mkdir ?? fsp.mkdir;
	const _rename = deps.rename ?? fsp.rename;
	const _createReadStream = deps.createReadStream ?? fs.createReadStream;
	const _createWriteStream = deps.createWriteStream ?? fs.createWriteStream;
	const _realpath = deps.realpath ?? fsp.realpath;

	const pathDeps = { lstat: _lstat, realpath: _realpath };

	// --- RPC 处理（rpc DC 上的 coclaw.file.list / coclaw.file.delete） ---

	/**
	 * 处理 rpc DC 上的 coclaw.file.* 请求
	 * @param {object} payload - { id, method, params }
	 * @param {function} sendFn - (responseObj) => void
	 */
	async function handleRpcRequest(payload, sendFn) {
		const { id, method, params } = payload;
		try {
			if (method === 'coclaw.file.list') {
				const result = await listFiles(params);
				sendFn({ type: 'res', id, ok: true, payload: result });
			} else if (method === 'coclaw.file.delete') {
				const result = await deleteFile(params);
				sendFn({ type: 'res', id, ok: true, payload: result });
			} else {
				sendFn({
					type: 'res', id, ok: false,
					error: { code: 'UNKNOWN_METHOD', message: `Unknown file method: ${method}` },
				});
			}
		} catch (err) {
			sendFn({
				type: 'res', id, ok: false,
				error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message },
			});
		}
	}

	async function listFiles(params) {
		const agentId = params?.agentId?.trim?.() || 'main';
		const userPath = params?.path ?? ''; /* c8 ignore next -- ?? fallback */
		const workspaceDir = await resolveWorkspace(agentId);
		const resolved = await validatePath(workspaceDir, userPath || '.', pathDeps);

		let stat;
		try {
			stat = await _stat(resolved);
		} catch (e) {
			if (e.code === 'ENOENT') {
				const err = new Error(`Directory not found: ${userPath || '.'}`);
				err.code = 'NOT_FOUND';
				throw err;
			}
			/* c8 ignore next 2 */
			throw e;
		}
		if (!stat.isDirectory()) {
			const err = new Error(`Not a directory: ${userPath}`);
			err.code = 'IS_DIRECTORY';
			throw err;
		}

		const entries = await _readdir(resolved, { withFileTypes: true });
		const files = [];
		for (const entry of entries) {
			// 跳过临时文件
			if (TMP_FILE_PATTERN.test(entry.name)) continue;

			let type;
			if (entry.isSymbolicLink()) type = 'symlink';
			else if (entry.isDirectory()) type = 'dir';
			else if (entry.isFile()) type = 'file';
			/* c8 ignore next */
			else continue; // 跳过特殊文件

			let size = 0;
			let mtime = 0;
			try {
				const s = await _lstat(nodePath.join(resolved, entry.name));
				size = s.size;
				mtime = s.mtimeMs;
			} catch {
				// 获取 stat 失败时，条目仍然返回但没有 size/mtime
			}
			files.push({ name: entry.name, type, size, mtime: Math.floor(mtime) });
		}

		return { files };
	}

	async function deleteFile(params) {
		const agentId = params?.agentId?.trim?.() || 'main';
		const userPath = params?.path;
		if (!userPath) {
			const err = new Error('path is required');
			err.code = 'PATH_DENIED';
			throw err;
		}
		const workspaceDir = await resolveWorkspace(agentId);
		const resolved = await validatePath(workspaceDir, userPath, pathDeps);

		let stat;
		try {
			stat = await _lstat(resolved);
		} catch (e) {
			if (e.code === 'ENOENT') {
				const err = new Error(`File not found: ${userPath}`);
				err.code = 'NOT_FOUND';
				throw err;
			}
			throw e;
		}
		if (stat.isDirectory()) {
			try {
				await _rmdir(resolved);
			} catch (e) {
				if (e.code === 'ENOTEMPTY') {
					const err = new Error(`Directory not empty: ${userPath}`);
					err.code = 'NOT_EMPTY';
					throw err;
				}
				throw e;
			}
		} else {
			await _unlink(resolved);
		}
		return {};
	}

	// --- File DataChannel 处理 ---

	/**
	 * 处理 file:<transferId> DataChannel
	 * @param {object} dc - werift DataChannel
	 */
	function handleFileChannel(dc) {
		let requestTimer = setTimeout(() => {
			try {
				dc.send(JSON.stringify({
					ok: false,
					error: { code: 'TIMEOUT', message: 'No request received within 30s' },
				}));
			/* c8 ignore next */
			} catch { /* ignore */ }
			/* c8 ignore next */
			try { dc.close(); } catch { /* ignore */ }
		}, FILE_DC_TIMEOUT_MS);
		requestTimer.unref?.();

		let requestReceived = false;

		dc.onmessage = (event) => {
			// 只处理第一条 string 消息作为请求
			if (requestReceived) return;
			if (typeof event.data !== 'string') return;

			requestReceived = true;
			clearTimeout(requestTimer);
			requestTimer = null;

			let req;
			try {
				req = JSON.parse(event.data);
			} catch {
				sendError(dc, 'INVALID_INPUT', 'Invalid JSON request');
				return;
			}

			if (req.method === 'read') {
				/* c8 ignore next 3 -- handleRead 内部已完整处理异常，此 catch 纯防御 */
				handleRead(dc, req).catch((err) => {
					log.warn?.(`[coclaw/file] read error: ${err.message}`);
				});
			} else if (req.method === 'write') {
				/* c8 ignore next 3 -- handleWrite 内部已完整处理异常，此 catch 纯防御 */
				handleWrite(dc, req).catch((err) => {
					log.warn?.(`[coclaw/file] write error: ${err.message}`);
				});
			} else {
				sendError(dc, 'UNKNOWN_METHOD', `Unknown method: ${req.method}`);
			}
		};
	}

	async function handleRead(dc, req) {
		let workspaceDir, resolved;
		try {
			const agentId = req.agentId?.trim?.() || 'main'; /* c8 ignore next -- ?./?? fallback */
			workspaceDir = await resolveWorkspace(agentId);
			resolved = await validatePath(workspaceDir, req.path, pathDeps);
		} catch (err) {
			sendError(dc, err.code ?? 'INTERNAL_ERROR', err.message); /* c8 ignore next -- ?? fallback */
			return;
		}

		let stat;
		try {
			stat = await _stat(resolved);
		} catch (e) {
			if (e.code === 'ENOENT') {
				sendError(dc, 'NOT_FOUND', `File not found: ${req.path}`);
			} else {
				sendError(dc, 'READ_FAILED', e.message);
			}
			return;
		}
		if (stat.isDirectory()) {
			sendError(dc, 'IS_DIRECTORY', `Cannot read a directory: ${req.path}`);
			return;
		}
		if (!stat.isFile()) {
			sendError(dc, 'PATH_DENIED', `Not a regular file: ${req.path}`);
			return;
		}

		// 发送响应头
		try {
			dc.send(JSON.stringify({
				ok: true,
				size: stat.size,
				name: nodePath.basename(resolved),
			}));
		} catch {
			return; // DC 已关闭
		}

		// 流式发送文件内容
		const stream = _createReadStream(resolved, { highWaterMark: CHUNK_SIZE });
		let sentBytes = 0;
		let dcClosed = false;

		dc.onclose = () => { dcClosed = true; stream.destroy(); };

		if (dc.bufferedAmountLowThreshold !== undefined) {
			dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
		}
		dc.onbufferedamountlow = () => stream.resume();

		await new Promise((resolve, reject) => {
			stream.on('data', (chunk) => {
				if (dcClosed) { stream.destroy(); return; }
				try {
					dc.send(chunk);
					sentBytes += chunk.length;
					if (dc.bufferedAmount > HIGH_WATER_MARK) {
						stream.pause();
					}
				/* c8 ignore start -- dc.send 抛异常属罕见竞态 */
				} catch {
					dcClosed = true;
					stream.destroy();
				}
				/* c8 ignore stop */
			});
			stream.on('end', () => {
				if (dcClosed) { resolve(); return; }
				try {
					dc.send(JSON.stringify({ ok: true, bytes: sentBytes }));
					dc.close();
				} catch { /* ignore */ }
				resolve();
			});
			stream.on('error', (err) => {
				if (!dcClosed) {
					sendError(dc, 'READ_FAILED', err.message);
				}
				reject(err);
			});
		}).catch((err) => {
			log.warn?.(`[coclaw/file] read stream error: ${err.message}`);
		});
	}

	async function handleWrite(dc, req) {
		let workspaceDir, resolved;
		try {
			const agentId = req.agentId?.trim?.() || 'main';
			workspaceDir = await resolveWorkspace(agentId);
			resolved = await validatePath(workspaceDir, req.path, pathDeps);
		} catch (err) {
			sendError(dc, err.code ?? 'INTERNAL_ERROR', err.message);
			return;
		}

		const declaredSize = req.size;
		if (!Number.isFinite(declaredSize) || declaredSize < 0) {
			sendError(dc, 'INVALID_INPUT', 'size must be a non-negative number');
			return;
		}
		if (declaredSize > MAX_UPLOAD_SIZE) {
			sendError(dc, 'SIZE_EXCEEDED', `File size ${declaredSize} exceeds 1GB limit`);
			return;
		}

		// 确保目标目录存在
		const targetDir = nodePath.dirname(resolved);
		try {
			await _mkdir(targetDir, { recursive: true });
		} catch (err) {
			sendError(dc, 'WRITE_FAILED', `Cannot create directory: ${err.message}`);
			return;
		}

		// 临时文件与目标在同一目录（避免 EXDEV）
		const transferId = dc.label?.split(':')?.[1] ?? randomUUID();
		const tmpPath = `${resolved}.tmp.${transferId}`;

		let ws;
		try {
			ws = _createWriteStream(tmpPath, { highWaterMark: CHUNK_SIZE });
		} catch (err) {
			sendError(dc, 'WRITE_FAILED', `Cannot create temp file: ${err.message}`);
			return;
		}

		// 发送就绪信号
		try {
			dc.send(JSON.stringify({ ok: true }));
		} catch {
			// WriteStream 可能尚未完成文件创建，等 close 后再清理
			ws.on('close', () => safeUnlink(tmpPath));
			ws.destroy();
			return;
		}

		let receivedBytes = 0;
		let doneReceived = false;
		let dcClosed = false;

		// 替换原始 onmessage（文件传输模式）
		dc.onmessage = (event) => {
			if (typeof event.data === 'string') {
				let msg;
				try { msg = JSON.parse(event.data); } catch { return; }
				if (msg.done) {
					doneReceived = true;
					ws.end(async () => {
						if (dcClosed) {
							safeUnlink(tmpPath);
							return;
						}
						const valid = receivedBytes === declaredSize;
						if (!valid) {
							try {
								dc.send(JSON.stringify({ ok: false, error: { code: 'WRITE_FAILED', message: `Size mismatch: expected ${declaredSize}, got ${receivedBytes}` } }));
							/* c8 ignore next */
							} catch { /* ignore */ }
							safeUnlink(tmpPath);
							/* c8 ignore next */
							try { dc.close(); } catch { /* ignore */ }
							return;
						}
						// 先 rename，再发成功响应（避免 rename 失败时 UI 误认为成功）
						try {
							await _rename(tmpPath, resolved);
						} catch (renameErr) {
							log.warn?.(`[coclaw/file] rename failed: ${renameErr.message}`);
							/* c8 ignore next 3 -- dc.send/close 失败属罕见竞态 */
							try {
								dc.send(JSON.stringify({ ok: false, error: { code: 'WRITE_FAILED', message: `rename failed: ${renameErr.message}` } }));
							} catch { /* ignore */ }
							safeUnlink(tmpPath);
							/* c8 ignore next */
							try { dc.close(); } catch { /* ignore */ }
							return;
						}
						try {
							dc.send(JSON.stringify({ ok: true, bytes: receivedBytes }));
						/* c8 ignore next */
						} catch { /* ignore */ }
						/* c8 ignore next */
						try { dc.close(); } catch { /* ignore */ }
					});
				}
			} else {
				// binary 数据帧
				const chunk = event.data;
				const len = chunk.byteLength ?? chunk.length ?? 0;
				receivedBytes += len;

				// 接收端超限防护
				if (receivedBytes > MAX_UPLOAD_SIZE || receivedBytes > declaredSize) {
					ws.destroy();
					safeUnlink(tmpPath);
					try {
						dc.send(JSON.stringify({
							ok: false,
							error: { code: 'SIZE_EXCEEDED', message: 'Received bytes exceed declared size or 1GB limit' },
						}));
					} catch { /* ignore */ }
					try { dc.close(); } catch { /* ignore */ }
					return;
				}
				ws.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
		};

		dc.onclose = () => {
			dcClosed = true;
			if (!doneReceived) {
				ws.destroy();
				safeUnlink(tmpPath);
			}
		};

		// WriteStream 错误处理
		ws.on('error', (err) => {
			log.warn?.(`[coclaw/file] write stream error: ${err.message}`);
			if (!dcClosed) {
				const code = err.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED';
				sendError(dc, code, err.message);
			}
			safeUnlink(tmpPath);
		});
	}

	// --- 临时文件清理 ---

	let cleanupTimer = null;

	/**
	 * 延迟启动临时文件清理任务
	 * @param {function} listAgentWorkspaces - () => Promise<string[]> 返回所有 workspace 路径
	 */
	function scheduleTmpCleanup(listAgentWorkspaces) {
		if (cleanupTimer) return;
		cleanupTimer = setTimeout(async () => {
			cleanupTimer = null;
			try {
				const workspaces = await listAgentWorkspaces();
				for (const dir of workspaces) {
					await cleanupTmpFilesInDir(dir);
				}
			} catch (err) {
				log.warn?.(`[coclaw/file] tmp cleanup failed: ${err.message}`);
			}
		}, TMP_CLEANUP_DELAY_MS);
		cleanupTimer.unref?.();
	}

	async function cleanupTmpFilesInDir(dir) {
		let entries;
		try {
			entries = await _readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isFile() && TMP_FILE_PATTERN.test(entry.name)) {
				safeUnlink(nodePath.join(dir, entry.name));
			}
			// 递归进入子目录
			if (entry.isDirectory()) {
				await cleanupTmpFilesInDir(nodePath.join(dir, entry.name));
			}
		}
	}

	function cancelCleanup() {
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			cleanupTimer = null;
		}
	}

	// --- 工具函数 ---

	function sendError(dc, code, message) {
		try {
			dc.send(JSON.stringify({ ok: false, error: { code, message } }));
		} catch { /* DC 可能已关闭 */ }
		try { dc.close(); } catch { /* ignore */ }
	}

	function safeUnlink(filePath) {
		_unlink(filePath).catch(() => {});
	}

	return {
		handleRpcRequest,
		handleFileChannel,
		scheduleTmpCleanup,
		cancelCleanup,
		// 暴露内部方法便于测试
		__listFiles: listFiles,
		__deleteFile: deleteFile,
		__handleRead: handleRead,
		__handleWrite: handleWrite,
		__cleanupTmpFilesInDir: cleanupTmpFilesInDir,
	};
}
