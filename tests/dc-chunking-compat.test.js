/**
 * 跨端协议兼容性测试
 * 验证插件侧（Buffer）与 UI 侧（ArrayBuffer）的分片/重组互操作性
 * 使用 Node.js 原生 test runner
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// 插件侧（Buffer）
import {
	chunkAndSend as pluginChunkAndSend,
	createReassembler as pluginCreateReassembler,
} from '../plugins/openclaw/src/utils/dc-chunking.js';

// UI 侧（ArrayBuffer / Uint8Array）
import {
	buildChunks as uiBuildChunks,
	createReassembler as uiCreateReassembler,
} from '../ui/src/utils/dc-chunking.js';

/** Buffer → ArrayBuffer（模拟浏览器 DC binaryType='arraybuffer' 收到的数据） */
function toArrayBuffer(buf) {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('插件侧分片 → UI 侧重组', () => {
	const dc = { sent: [], send(d) { dc.sent.push(d); } };
	const original = JSON.stringify({ type: 'res', data: 'P'.repeat(500), nested: [1, 2, 3] });
	let id = 0;
	pluginChunkAndSend(dc, original, 100, () => ++id);
	assert.ok(dc.sent.length > 1);

	const received = [];
	const r = uiCreateReassembler((s) => received.push(s));
	for (const buf of dc.sent) {
		r.feed(toArrayBuffer(buf));
	}
	assert.equal(received.length, 1);
	assert.equal(received[0], original);
});

test('UI 侧分片 → 插件侧重组', () => {
	const original = JSON.stringify({ type: 'req', id: 'ui-1', method: 'test', params: { big: 'U'.repeat(500) } });
	let id = 0;
	const chunks = uiBuildChunks(original, 100, () => ++id);
	assert.ok(chunks !== null);

	const received = [];
	const r = pluginCreateReassembler((s) => received.push(s));
	for (const ab of chunks) {
		r.feed(Buffer.from(ab));
	}
	assert.equal(received.length, 1);
	assert.equal(received[0], original);
});

test('插件侧分片中夹杂 string 消息 → UI 侧正确处理', () => {
	const dc = { sent: [], send(d) { dc.sent.push(d); } };
	const largeMsg = JSON.stringify({ type: 'res', data: 'M'.repeat(300) });
	const smallMsg = JSON.stringify({ type: 'event', event: 'status' });
	let id = 0;

	pluginChunkAndSend(dc, largeMsg, 80, () => ++id);
	const chunkedItems = [...dc.sent];
	dc.sent.length = 0;
	pluginChunkAndSend(dc, smallMsg, 80, () => ++id);
	const smallItem = dc.sent[0]; // string

	const received = [];
	const r = uiCreateReassembler((s) => received.push(s));

	// chunk1, chunk2
	r.feed(toArrayBuffer(chunkedItems[0]));
	r.feed(toArrayBuffer(chunkedItems[1]));
	// 插入 string 消息
	r.feed(smallItem);
	// 剩余 chunk
	for (let i = 2; i < chunkedItems.length; i++) {
		r.feed(toArrayBuffer(chunkedItems[i]));
	}

	assert.equal(received.length, 2);
	assert.equal(received[0], smallMsg);
	assert.equal(received[1], largeMsg);
});

test('大消息（>1MB 模拟 session content）跨端正确传输', () => {
	const bigData = 'X'.repeat(1024 * 1024 + 100);
	const original = JSON.stringify({ type: 'res', id: 'ui-99', ok: true, payload: { content: bigData } });

	// 插件 → UI（Safari maxMessageSize=65535）
	const dc = { sent: [], send(d) { dc.sent.push(d); } };
	let id = 0;
	pluginChunkAndSend(dc, original, 65535, () => ++id);
	assert.ok(dc.sent.length > 15);

	const received = [];
	const r = uiCreateReassembler((s) => received.push(s));
	for (const buf of dc.sent) {
		r.feed(toArrayBuffer(buf));
	}
	assert.equal(received.length, 1);
	assert.equal(received[0], original);
});

test('UI 侧大消息分片 → 插件侧重组（Chrome maxMessageSize=256KB）', () => {
	const bigData = 'C'.repeat(512 * 1024);
	const original = JSON.stringify({ type: 'req', params: { img: bigData } });
	let id = 0;
	const chunks = uiBuildChunks(original, 65536, () => ++id);
	assert.ok(chunks !== null);

	const received = [];
	const r = pluginCreateReassembler((s) => received.push(s));
	for (const ab of chunks) {
		r.feed(Buffer.from(ab));
	}
	assert.equal(received.length, 1);
	assert.equal(received[0], original);
});

test('小消息不分片（string 直传）跨端兼容', () => {
	const msg = JSON.stringify({ type: 'req', method: 'ping' });

	// 插件侧不分片 → string
	const dc = { sent: [], send(d) { dc.sent.push(d); } };
	pluginChunkAndSend(dc, msg, 65536, () => 1);
	assert.equal(dc.sent.length, 1);
	assert.equal(typeof dc.sent[0], 'string');

	// UI 侧接收 string
	const received = [];
	const r = uiCreateReassembler((s) => received.push(s));
	r.feed(dc.sent[0]);
	assert.equal(received.length, 1);
	assert.equal(received[0], msg);
});
