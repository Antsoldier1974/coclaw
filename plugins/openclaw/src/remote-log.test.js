import assert from 'node:assert/strict';
import test from 'node:test';

import {
	remoteLog, setSender, __reset, __buffer, __BATCH_SIZE, __MAX_BUFFER,
} from './remote-log.js';

test.afterEach(() => __reset());

test('remoteLog 将条目推入缓冲区（含 ts 和 text）', () => {
	remoteLog('hello');
	assert.equal(__buffer.length, 1);
	assert.equal(__buffer[0].text, 'hello');
	assert.equal(typeof __buffer[0].ts, 'number');
});

test('缓冲区满时丢弃最旧条目', () => {
	for (let i = 0; i < __MAX_BUFFER + 5; i++) {
		remoteLog(`msg-${i}`);
	}
	assert.equal(__buffer.length, __MAX_BUFFER);
	// 最旧的 5 条应被丢弃，第一条应是 msg-5
	assert.equal(__buffer[0].text, 'msg-5');
	assert.equal(__buffer[__buffer.length - 1].text, `msg-${__MAX_BUFFER + 4}`);
});

test('无 sender 时仅缓冲不发送', () => {
	remoteLog('buffered');
	assert.equal(__buffer.length, 1);
});

test('setSender 注入后自动 flush 缓冲区', async () => {
	remoteLog('a');
	remoteLog('b');
	const sent = [];
	setSender((msg) => sent.push(msg));
	// flush 是异步的，等一个 tick
	await new Promise(r => setTimeout(r, 10));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'log');
	assert.deepEqual(sent[0].logs.map(l => l.text), ['a', 'b']);
	assert.equal(__buffer.length, 0);
});

test('remoteLog 在 sender 可用时自动 flush', async () => {
	const sent = [];
	setSender((msg) => sent.push(msg));
	// 清空初始 flush
	await new Promise(r => setTimeout(r, 10));
	remoteLog('live');
	await new Promise(r => setTimeout(r, 10));
	assert.ok(sent.some(m => m.logs.some(l => l.text === 'live')));
	assert.equal(__buffer.length, 0);
});

test('flush 按 BATCH_SIZE 分批发送', async () => {
	const count = __BATCH_SIZE * 2 + 3;
	for (let i = 0; i < count; i++) {
		remoteLog(`item-${i}`);
	}
	const sent = [];
	setSender((msg) => sent.push(msg));
	await new Promise(r => setTimeout(r, 50));
	// 应分 3 批：20 + 20 + 3
	assert.equal(sent.length, 3);
	assert.equal(sent[0].logs.length, __BATCH_SIZE);
	assert.equal(sent[1].logs.length, __BATCH_SIZE);
	assert.equal(sent[2].logs.length, 3);
	assert.equal(__buffer.length, 0);
});

test('sender 抛异常时停止 flush 并保留缓冲区', async () => {
	remoteLog('a');
	remoteLog('b');
	let callCount = 0;
	setSender(() => {
		callCount++;
		throw new Error('send failed');
	});
	await new Promise(r => setTimeout(r, 10));
	assert.equal(callCount, 1);
	// 缓冲区应保留全部条目
	assert.equal(__buffer.length, 2);
});

test('sender 置 null 后 flush 中断', async () => {
	// 填入超过一批的数据
	for (let i = 0; i < __BATCH_SIZE + 5; i++) {
		remoteLog(`msg-${i}`);
	}
	const sent = [];
	let sendCount = 0;
	setSender((msg) => {
		sent.push(msg);
		sendCount++;
		// 第一批发送后立即断开 sender
		setSender(null);
	});
	await new Promise(r => setTimeout(r, 50));
	// 只发了第一批
	assert.equal(sendCount, 1);
	assert.equal(sent[0].logs.length, __BATCH_SIZE);
	// 剩余 5 条仍在缓冲区
	assert.equal(__buffer.length, 5);
});

test('__reset 清空所有状态', () => {
	remoteLog('x');
	setSender(() => {});
	__reset();
	assert.equal(__buffer.length, 0);
});

test('并发 flush 不会重复执行', async () => {
	for (let i = 0; i < 10; i++) {
		remoteLog(`msg-${i}`);
	}
	const sent = [];
	setSender((msg) => sent.push(msg));
	// 立即再触发一次 remoteLog（尝试触发第二次 flush）
	remoteLog('extra');
	await new Promise(r => setTimeout(r, 30));
	// 所有条目应被发送，无重复
	const allTexts = sent.flatMap(m => m.logs.map(l => l.text));
	assert.equal(new Set(allTexts).size, allTexts.length);
	assert.equal(__buffer.length, 0);
});
