import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('vue', () => ({
	onBeforeUnmount: vi.fn(),
	ref: (v) => ({ value: v }),
}));

vi.mock('../stores/sessions.store.js', () => {
	const mockStore = { removeSessionsByBotId: vi.fn() };
	return { useSessionsStore: () => mockStore };
});

import { onBeforeUnmount } from 'vue';
import { useSessionsStore } from '../stores/sessions.store.js';
import { useBotStatusSse } from './use-bot-status-sse.js';

describe('useBotStatusSse', () => {
	let store;
	let MockEventSource;
	let esInstance;
	let currentStop;

	beforeEach(() => {
		store = {
			fetched: false,
			applySnapshot: vi.fn(),
			updateBotOnline: vi.fn(),
			addOrUpdateBot: vi.fn(),
			removeBotById: vi.fn(),
			loadBots: vi.fn().mockResolvedValue([]),
		};
		useSessionsStore().removeSessionsByBotId.mockReset();

		esInstance = {
			onopen: null,
			onmessage: null,
			onerror: null,
			close: vi.fn(),
		};

		MockEventSource = vi.fn(() => esInstance);
		vi.stubGlobal('EventSource', MockEventSource);
		vi.useFakeTimers();
		vi.mocked(onBeforeUnmount).mockReset();
		currentStop = null;
	});

	afterEach(() => {
		if (currentStop) currentStop();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function createSse() {
		const result = useBotStatusSse(store);
		currentStop = result.stop;
		return result;
	}

	test('should create EventSource with correct URL', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledWith('/api/v1/bots/status-stream');
	});

	test('should register onBeforeUnmount cleanup', () => {
		createSse();
		expect(onBeforeUnmount).toHaveBeenCalledWith(expect.any(Function));
	});

	test('should set connected=true on open (without calling loadBots)', () => {
		const { connected } = createSse();

		esInstance.onopen();

		expect(connected.value).toBe(true);
		// 不再调用 loadBots——由 server 推送 bot.snapshot
		expect(store.applySnapshot).not.toHaveBeenCalled();
	});

	test('should handle bot.snapshot event via applySnapshot', () => {
		createSse();

		const items = [{ id: '1', name: 'a', online: true }];
		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.snapshot', items }),
		});

		expect(store.applySnapshot).toHaveBeenCalledWith(items);
	});

	test('should update bot status on message', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.status', botId: '42', online: true }),
		});

		expect(store.updateBotOnline).toHaveBeenCalledWith('42', true);
	});

	test('should handle bot.nameUpdated event by updating bot name in store', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.nameUpdated', botId: '42', name: '小点' }),
		});

		expect(store.addOrUpdateBot).toHaveBeenCalledWith({ id: '42', name: '小点' });
	});

	test('should handle bot.bound event by adding bot to store', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.bound', bot: { id: '42', name: 'test' } }),
		});

		expect(store.addOrUpdateBot).toHaveBeenCalledWith({ id: '42', name: 'test' });
	});

	test('should handle bot.unbound event by removing bot', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.unbound', botId: '42' }),
		});

		expect(store.removeBotById).toHaveBeenCalledWith('42');
	});

	test('should handle heartbeat event silently', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'heartbeat' }),
		});

		expect(store.applySnapshot).not.toHaveBeenCalled();
		expect(store.updateBotOnline).not.toHaveBeenCalled();
	});

	test('should ignore messages with unknown event', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'unknown', botId: '42' }),
		});

		expect(store.updateBotOnline).not.toHaveBeenCalled();
	});

	test('should ignore malformed JSON messages', () => {
		createSse();

		esInstance.onmessage({ data: 'not json' });

		expect(store.updateBotOnline).not.toHaveBeenCalled();
	});

	test('snapshot timeout: should call loadBots if snapshot not received within 5s', () => {
		store.fetched = false;
		createSse();
		esInstance.onopen();

		expect(store.loadBots).not.toHaveBeenCalled();

		vi.advanceTimersByTime(5_000);
		expect(store.loadBots).toHaveBeenCalledTimes(1);
	});

	test('snapshot timeout: should not call loadBots if snapshot arrives in time', () => {
		store.fetched = false;
		createSse();
		esInstance.onopen();

		// 快照在 3s 内到达
		vi.advanceTimersByTime(3_000);
		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.snapshot', items: [] }),
		});

		vi.advanceTimersByTime(5_000);
		expect(store.loadBots).not.toHaveBeenCalled();
	});

	test('snapshot timeout: should not start timer if already fetched', () => {
		store.fetched = true;
		createSse();
		esInstance.onopen();

		vi.advanceTimersByTime(10_000);
		expect(store.loadBots).not.toHaveBeenCalled();
	});

	test('should set connected=false on error and clear heartbeat timer', () => {
		const { connected } = createSse();

		esInstance.onopen();
		expect(connected.value).toBe(true);

		esInstance.onerror();
		expect(connected.value).toBe(false);
	});

	test('stop() should close EventSource and clear heartbeat timer', () => {
		const { stop, connected } = createSse();

		esInstance.onopen(); // 启动心跳计时器

		stop();
		currentStop = null;

		expect(esInstance.close).toHaveBeenCalled();
		expect(connected.value).toBe(false);

		// 即使超过超时时间也不应重建（计时器已清理）
		vi.advanceTimersByTime(70_000);
		expect(MockEventSource).toHaveBeenCalledTimes(1);
	});

	test('heartbeat timeout should restart SSE after 65s of silence', () => {
		createSse();
		esInstance.onopen();

		expect(MockEventSource).toHaveBeenCalledTimes(1);

		// 65s 无数据 → 超时重建
		vi.advanceTimersByTime(65_000);

		expect(esInstance.close).toHaveBeenCalled();
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('heartbeat timeout should be reset by any incoming message', () => {
		createSse();
		esInstance.onopen();

		// 40s 后收到心跳
		vi.advanceTimersByTime(40_000);
		esInstance.onmessage({
			data: JSON.stringify({ event: 'heartbeat' }),
		});

		// 再过 40s（距上次消息 40s < 65s）→ 不应超时
		vi.advanceTimersByTime(40_000);
		expect(MockEventSource).toHaveBeenCalledTimes(1);

		// 再过 25s（距上次消息 65s）→ 超时
		vi.advanceTimersByTime(25_000);
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('app:foreground 事件触发 SSE 重建', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledTimes(1);

		window.dispatchEvent(new CustomEvent('app:foreground'));

		expect(esInstance.close).toHaveBeenCalled();
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('stop() 后 app:foreground 不再重建 SSE', () => {
		const { stop } = createSse();
		stop();
		currentStop = null;

		MockEventSource.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));

		expect(MockEventSource).not.toHaveBeenCalled();
	});

	test('stop() 移除 app:foreground 监听器', () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');
		const { stop } = createSse();
		stop();
		currentStop = null;

		expect(removeSpy).toHaveBeenCalledWith('app:foreground', expect.any(Function));
	});

	test('network:online 事件触发 SSE 重建', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledTimes(1);

		window.dispatchEvent(new CustomEvent('network:online'));

		expect(esInstance.close).toHaveBeenCalled();
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('stop() 后 network:online 不再重建 SSE', () => {
		const { stop } = createSse();
		stop();
		currentStop = null;

		MockEventSource.mockClear();
		window.dispatchEvent(new CustomEvent('network:online'));

		expect(MockEventSource).not.toHaveBeenCalled();
	});

	test('stop() 移除 network:online 监听器', () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');
		const { stop } = createSse();
		stop();
		currentStop = null;

		expect(removeSpy).toHaveBeenCalledWith('network:online', expect.any(Function));
	});
});
