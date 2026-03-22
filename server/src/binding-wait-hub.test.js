import assert from 'node:assert/strict';
import test from 'node:test';

import {
	cancelBindingWait,
	markBindingBound,
	registerBindingWait,
	waitBindingResult,
} from './binding-wait-hub.js';

test('registerBindingWait: should return waitToken', () => {
	const waitToken = registerBindingWait({
		code: 'BW_01',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});
	assert.equal(typeof waitToken, 'string');
	assert.ok(waitToken.length > 0);
});

test('waitBindingResult: should return INVALID for unknown code', async () => {
	const result = await waitBindingResult({ code: 'UNKNOWN', waitToken: 'x', userId: 'u1' });
	assert.equal(result.status, 'INVALID');
});

test('waitBindingResult: should return INVALID for wrong waitToken', async () => {
	registerBindingWait({
		code: 'BW_02',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});
	const result = await waitBindingResult({ code: 'BW_02', waitToken: 'wrong', userId: 'u1' });
	assert.equal(result.status, 'INVALID');
});

test('waitBindingResult: should return INVALID for wrong userId', async () => {
	const waitToken = registerBindingWait({
		code: 'BW_03',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});
	const result = await waitBindingResult({ code: 'BW_03', waitToken, userId: 'wrong' });
	assert.equal(result.status, 'INVALID');
});

test('markBindingBound + waitBindingResult: should resolve immediately if already bound', async () => {
	const waitToken = registerBindingWait({
		code: 'BW_04',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});
	markBindingBound({ code: 'BW_04', botId: 42n, botName: 'bot-42' });

	const result = await waitBindingResult({ code: 'BW_04', waitToken, userId: 'u1' });
	assert.equal(result.status, 'BOUND');
	assert.equal(result.bot.id, '42');
	assert.equal(result.bot.name, 'bot-42');
});

test('markBindingBound: should notify pending waiters', async () => {
	const waitToken = registerBindingWait({
		code: 'BW_05',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});

	const promise = waitBindingResult({ code: 'BW_05', waitToken, userId: 'u1' });
	markBindingBound({ code: 'BW_05', botId: 99n, botName: 'bot-99' });

	const result = await promise;
	assert.equal(result.status, 'BOUND');
	assert.equal(result.bot.id, '99');
});

test('waitBindingResult: should return TIMEOUT for expired code', async () => {
	const waitToken = registerBindingWait({
		code: 'BW_06',
		userId: 'u1',
		expiresAt: new Date(Date.now() - 1000),
	});

	const result = await waitBindingResult({ code: 'BW_06', waitToken, userId: 'u1' });
	assert.equal(result.status, 'TIMEOUT');
});

test('cancelBindingWait: should cancel pending binding', async () => {
	const waitToken = registerBindingWait({
		code: 'BW_07',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});

	const promise = waitBindingResult({ code: 'BW_07', waitToken, userId: 'u1' });
	const cancelled = cancelBindingWait({ code: 'BW_07', waitToken, userId: 'u1' });
	assert.equal(cancelled, true);

	const result = await promise;
	assert.equal(result.status, 'CANCELLED');
});

test('cancelBindingWait: should return false for wrong token', () => {
	registerBindingWait({
		code: 'BW_08',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});
	const result = cancelBindingWait({ code: 'BW_08', waitToken: 'wrong', userId: 'u1' });
	assert.equal(result, false);
});

test('cancelBindingWait: should return false for already bound', () => {
	const waitToken = registerBindingWait({
		code: 'BW_09',
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});
	markBindingBound({ code: 'BW_09', botId: 1n });
	const result = cancelBindingWait({ code: 'BW_09', waitToken, userId: 'u1' });
	assert.equal(result, false);
});

test('markBindingBound: should no-op for unknown code', () => {
	markBindingBound({ code: 'NOPE', botId: 1n });
	// 不应抛异常
});

test('registerBindingWait: should schedule cleanup timer', async () => {
	const code = 'BW_CLEANUP_01';
	registerBindingWait({
		code,
		userId: 'u1',
		expiresAt: new Date(Date.now() - 120_000),
	});
	// 等待 timer 触发（TTL clamp 到 0）
	await new Promise((r) => setTimeout(r, 50));
	// 条目应已被清理
	const result = await waitBindingResult({ code, waitToken: 'any', userId: 'u1' });
	assert.equal(result.status, 'INVALID');
});

test('markBindingBound: should reschedule cleanup timer', async () => {
	const code = 'BW_CLEANUP_02';
	const waitToken = registerBindingWait({
		code,
		userId: 'u1',
		expiresAt: new Date(Date.now() + 300_000),
	});
	markBindingBound({ code, botId: 77n, botName: 'bot-77' });

	// bound 后条目仍可访问（60s 缓冲窗口内）
	const result = await waitBindingResult({ code, waitToken, userId: 'u1' });
	assert.equal(result.status, 'BOUND');
	assert.equal(result.bot.id, '77');
});

test('cancelBindingWait: should schedule cleanup timer', async () => {
	const code = 'BW_CLEANUP_03';
	const waitToken = registerBindingWait({
		code,
		userId: 'u1',
		expiresAt: new Date(Date.now() + 60_000),
	});
	cancelBindingWait({ code, waitToken, userId: 'u1' });

	// 取消后条目仍可短暂访问（返回 CANCELLED 而非 INVALID）
	const result = await waitBindingResult({ code, waitToken, userId: 'u1' });
	assert.equal(result.status, 'CANCELLED');
});
