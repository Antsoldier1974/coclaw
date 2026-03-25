import { describe, test, expect } from 'vitest';
import {
	buildChunks,
	createReassembler,
	FLAG_BEGIN,
	FLAG_MIDDLE,
	FLAG_END,
	HEADER_SIZE,
} from './dc-chunking.js';

describe('dc-chunking (UI 侧)', () => {
	// --- buildChunks ---

	test('小消息不分片，返回 null', () => {
		const result = buildChunks('{"ok":true}', 100, () => 1);
		expect(result).toBeNull();
	});

	test('恰好等于 maxMessageSize 不分片', () => {
		const msg = 'x'.repeat(50);
		const byteLen = new TextEncoder().encode(msg).byteLength;
		expect(buildChunks(msg, byteLen, () => 1)).toBeNull();
	});

	test('超过 maxMessageSize 产生正确的 chunk 数组', () => {
		const msg = 'a'.repeat(31);
		let id = 0;
		const chunks = buildChunks(msg, 30, () => ++id);

		expect(chunks).not.toBeNull();
		expect(chunks.length).toBe(2);
		expect(chunks[0]).toBeInstanceOf(ArrayBuffer);

		// 验证 flag
		expect(new Uint8Array(chunks[0])[0]).toBe(FLAG_BEGIN);
		expect(new Uint8Array(chunks[1])[0]).toBe(FLAG_END);

		// 每个 chunk ≤ maxMessageSize
		for (const c of chunks) {
			expect(c.byteLength).toBeLessThanOrEqual(30);
		}
	});

	test('大消息帧格式正确（BEGIN/MIDDLE/END）', () => {
		const msg = JSON.stringify({ data: 'x'.repeat(500) });
		let id = 0;
		const chunks = buildChunks(msg, 100, () => ++id);

		expect(chunks.length).toBeGreaterThan(2);
		expect(new Uint8Array(chunks[0])[0]).toBe(FLAG_BEGIN);
		expect(new Uint8Array(chunks[chunks.length - 1])[0]).toBe(FLAG_END);
		for (let i = 1; i < chunks.length - 1; i++) {
			expect(new Uint8Array(chunks[i])[0]).toBe(FLAG_MIDDLE);
		}
	});

	test('多字节 UTF-8 字符（中文/emoji）正确分片和重组', () => {
		const msg = JSON.stringify({ msg: '你好世界🌍测试分片' });
		let id = 0;
		const chunks = buildChunks(msg, 20, () => ++id);
		expect(chunks).not.toBeNull();

		const received = [];
		const r = createReassembler((s) => received.push(s));
		for (const c of chunks) r.feed(c);

		expect(received.length).toBe(1);
		expect(JSON.parse(received[0])).toEqual(JSON.parse(msg));
	});

	// --- createReassembler ---

	test('string 消息直接回调', () => {
		const received = [];
		const r = createReassembler((s) => received.push(s));
		r.feed('{"type":"req"}');
		expect(received).toEqual(['{"type":"req"}']);
	});

	test('分片中夹杂普通 string 消息，各自独立处理', () => {
		const received = [];
		const r = createReassembler((s) => received.push(s));
		const original = 'CHUNKED_DATA_12345678901234567890';
		let id = 0;
		const chunks = buildChunks(original, 20, () => ++id);

		// 发前半 chunk
		r.feed(chunks[0]);
		// 插入普通消息
		r.feed('{"type":"event"}');
		// 发剩余 chunk
		for (let i = 1; i < chunks.length; i++) r.feed(chunks[i]);

		expect(received.length).toBe(2);
		expect(received[0]).toBe('{"type":"event"}');
		expect(received[1]).toBe(original);
	});

	test('reset 清空缓冲区', () => {
		const received = [];
		const r = createReassembler((s) => received.push(s));

		// 发 BEGIN 不发 END
		const buf = new Uint8Array(HEADER_SIZE + 5);
		buf[0] = FLAG_BEGIN;
		new DataView(buf.buffer).setUint32(1, 1, false);
		buf.set(new TextEncoder().encode('hello'), HEADER_SIZE);
		r.feed(buf.buffer);

		r.reset();

		// END 不应重组
		const end = new Uint8Array(HEADER_SIZE + 5);
		end[0] = FLAG_END;
		new DataView(end.buffer).setUint32(1, 1, false);
		end.set(new TextEncoder().encode('world'), HEADER_SIZE);
		r.feed(end.buffer);

		expect(received.length).toBe(0);
	});
});

