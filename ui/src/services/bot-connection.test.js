import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BotConnection, BRIEF_DISCONNECT_MS } from './bot-connection.js';

// mock signaling-connection 单例
vi.mock('./signaling-connection.js', () => {
	const releaseConnId = vi.fn();
	return {
		useSignalingConnection: () => ({ releaseConnId }),
		__mockReleaseConnId: releaseConnId,
	};
});

import { __mockReleaseConnId } from './signaling-connection.js';

// 工厂：创建 DC 就绪的连接
function makeRtcReady(botId = 'bot1') {
	const conn = new BotConnection(botId);
	const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue(), close: vi.fn() };
	conn.setRtc(mockRtc);
	return { conn, mockRtc };
}

// --- 测试套件 ---

describe('BotConnection – constructor', () => {
	test('botId 转为字符串', () => {
		const conn = new BotConnection(42);
		expect(conn.botId).toBe('42');
	});

	test('初始状态无 RTC', () => {
		const conn = new BotConnection('bot1');
		expect(conn.rtc).toBeNull();
	});
});

describe('BotConnection – disconnect()', () => {
	test('关闭 RTC 并释放 connId', () => {
		const { conn, mockRtc } = makeRtcReady();
		__mockReleaseConnId.mockClear();
		conn.disconnect();
		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.rtc).toBeNull();
		expect(__mockReleaseConnId).toHaveBeenCalledWith('bot1');
	});

	test('无 RTC 时也正常执行', () => {
		const conn = new BotConnection('bot1');
		__mockReleaseConnId.mockClear();
		expect(() => conn.disconnect()).not.toThrow();
		expect(__mockReleaseConnId).toHaveBeenCalledWith('bot1');
	});

	test('reject 所有挂起请求', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('test');
		conn.disconnect();
		await expect(p).rejects.toMatchObject({ message: 'connection closed' });
	});
});

describe('BotConnection – RTC 管理', () => {
	test('setRtc / get rtc', () => {
		const conn = new BotConnection('bot1');
		const rtc = { isReady: true, send: vi.fn(), close: vi.fn() };
		conn.setRtc(rtc);
		expect(conn.rtc).toBe(rtc);
	});

	test('clearRtc rejects pending with RTC_LOST', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('test');
		conn.clearRtc();
		expect(conn.rtc).toBeNull();
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
	});
});

describe('BotConnection – request()', () => {
	test('通过 DataChannel 发送请求', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('ping.me', { x: 1 });
		expect(mockRtc.send).toHaveBeenCalledTimes(1);
		const sent = mockRtc.send.mock.calls[0][0];
		expect(sent.type).toBe('req');
		expect(sent.method).toBe('ping.me');
		expect(sent.params).toEqual({ x: 1 });
		expect(sent.id).toMatch(/^ui-/);
		conn.__onRtcMessage({ type: 'res', id: sent.id, ok: true, payload: { result: 42 } });
		const res = await p;
		expect(res).toEqual({ result: 42 });
	});

	test('DC 不可用时 reject DC_NOT_READY', async () => {
		const conn = new BotConnection('b1');
		await expect(conn.request('foo')).rejects.toMatchObject({ code: 'DC_NOT_READY' });
	});

	test('插件返回 ok=false 时 reject', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('bad.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
		await expect(p).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'not found' });
	});

	test('error.code 缺失时使用默认 RPC_FAILED', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('bad.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: false, error: { message: 'oops' } });
		await expect(p).rejects.toMatchObject({ code: 'RPC_FAILED' });
	});

	test('自增 counter 保证请求 ID 唯一', () => {
		const { conn, mockRtc } = makeRtcReady();
		conn.request('a').catch(() => {});
		conn.request('b').catch(() => {});
		const id1 = mockRtc.send.mock.calls[0][0].id;
		const id2 = mockRtc.send.mock.calls[1][0].id;
		expect(id1).not.toBe(id2);
	});

	test('rtc.send() 失败时 reject RTC_SEND_FAILED', async () => {
		const { conn, mockRtc } = makeRtcReady();
		mockRtc.send.mockRejectedValue(new Error('dc error'));
		await expect(conn.request('some.method')).rejects.toMatchObject({ code: 'RTC_SEND_FAILED' });
	});
});

describe('BotConnection – request() 两阶段 (onAccepted)', () => {
	test('收到 accepted 后调用 onAccepted，不 resolve', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const accepted = vi.fn();
		const p = conn.request('slow.op', {}, { onAccepted: accepted });
		const reqId = mockRtc.send.mock.calls[0][0].id;

		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'accepted', token: 'tok' } });
		await Promise.resolve();
		expect(accepted).toHaveBeenCalledWith({ status: 'accepted', token: 'tok' });
		let settled = false;
		p.then(() => { settled = true; }).catch(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);

		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'ok', data: 123 } });
		const res = await p;
		expect(res).toEqual({ status: 'ok', data: 123 });
	});

	test('终态 status=error 也 resolve', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow.op', {}, { onAccepted: vi.fn() });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'accepted' } });
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'error', reason: 'fail' } });
		const res = await p;
		expect(res.status).toBe('error');
	});

	test('未知中间态调用 onUnknownStatus', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const onUnknown = vi.fn();
		conn.request('slow.op', {}, { onAccepted: vi.fn(), onUnknownStatus: onUnknown });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'processing' } });
		await Promise.resolve();
		expect(onUnknown).toHaveBeenCalledWith('processing', { status: 'processing' });
	});
});

describe('BotConnection – request() 超时', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test('超时后 reject RPC_TIMEOUT', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('slow', {}, { timeout: 5000 });
		vi.advanceTimersByTime(5001);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
	});

	test('超时前收到响应正常 resolve', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow', {}, { timeout: 5000 });
		vi.advanceTimersByTime(3000);
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: {} });
		const res = await p;
		expect(res).toEqual({});
	});

	test('默认 30 分钟超时', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('longRunning');
		vi.advanceTimersByTime(29 * 60_000);
		expect(conn.__pending.size).toBe(1);
		vi.advanceTimersByTime(1 * 60_000 + 1);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
	});
});

describe('BotConnection – 事件系统', () => {
	test('on/off/__emit 基本功能', () => {
		const conn = new BotConnection('b1');
		const cb = vi.fn();
		conn.on('custom', cb);
		conn.__emit('custom', { foo: 1 });
		expect(cb).toHaveBeenCalledWith({ foo: 1 });
		conn.off('custom', cb);
		conn.__emit('custom', { foo: 2 });
		expect(cb).toHaveBeenCalledTimes(1);
	});

	test('多个监听器都会收到事件', () => {
		const conn = new BotConnection('b1');
		const a = vi.fn();
		const b = vi.fn();
		conn.on('e', a);
		conn.on('e', b);
		conn.__emit('e', 42);
		expect(a).toHaveBeenCalledWith(42);
		expect(b).toHaveBeenCalledWith(42);
	});

	test('监听器异常不影响其他监听器', () => {
		const conn = new BotConnection('b1');
		const bad = vi.fn(() => { throw new Error('oops'); });
		const good = vi.fn();
		conn.on('e', bad);
		conn.on('e', good);
		expect(() => conn.__emit('e', {})).not.toThrow();
		expect(good).toHaveBeenCalled();
	});

	test('无监听器时 emit 不抛异常', () => {
		const conn = new BotConnection('b1');
		expect(() => conn.__emit('nonexistent', {})).not.toThrow();
	});
});

describe('BotConnection – __onRtcMessage', () => {
	test('DC event 分发到 event:<name>', () => {
		const conn = new BotConnection('b1');
		const cb = vi.fn();
		conn.on('event:message.new', cb);
		conn.__onRtcMessage({ type: 'event', event: 'message.new', payload: { text: 'hi' } });
		expect(cb).toHaveBeenCalledWith({ text: 'hi' });
	});

	test('DC res 路由到 pending', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('test');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { done: true } });
		const res = await p;
		expect(res).toEqual({ done: true });
	});

	test('无 id 的 res 消息被安全忽略', () => {
		const conn = new BotConnection('b1');
		expect(() => conn.__onRtcMessage({ type: 'res', ok: true })).not.toThrow();
	});
});

describe('BotConnection – __rejectAllPending', () => {
	test('reject 所有挂起请求并清空', async () => {
		const { conn } = makeRtcReady();
		const p1 = conn.request('a');
		const p2 = conn.request('b');
		conn.__rejectAllPending('test reason', 'TEST_CODE');
		await expect(p1).rejects.toMatchObject({ code: 'TEST_CODE', message: 'test reason' });
		await expect(p2).rejects.toMatchObject({ code: 'TEST_CODE' });
		expect(conn.__pending.size).toBe(0);
	});
});

describe('BotConnection – BRIEF_DISCONNECT_MS 导出', () => {
	test('BRIEF_DISCONNECT_MS 是合理的正整数', () => {
		expect(BRIEF_DISCONNECT_MS).toBeGreaterThan(0);
		expect(Number.isInteger(BRIEF_DISCONNECT_MS)).toBe(true);
	});
});
