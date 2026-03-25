import { describe, test, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { chatStoreManager } from './chat-store-manager.js';

// --- Mocks ---

vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => ({
		get: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetBotConnections: vi.fn(),
}));

vi.mock('../utils/file-helper.js', () => ({
	fileToBase64: vi.fn(),
}));

// --- Tests ---

describe('chatStoreManager', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		chatStoreManager.__reset();
	});

	// =====================================================================
	// get
	// =====================================================================

	describe('get', () => {
		test('创建 session store 并缓存', () => {
			const store = chatStoreManager.get('session:1:main', { botId: '1', agentId: 'main' });
			expect(store).toBeTruthy();
			expect(store.botId).toBe('1');
			expect(store.chatSessionKey).toBe('agent:main:main');
			expect(store.topicMode).toBe(false);

			// 再次获取返回同一实例
			const same = chatStoreManager.get('session:1:main');
			expect(same).toBe(store);
		});

		test('创建 topic store', () => {
			const store = chatStoreManager.get('topic:uuid-1', { botId: '2', agentId: 'research' });
			expect(store.topicMode).toBe(true);
			expect(store.sessionId).toBe('uuid-1');
			expect(store.topicAgentId).toBe('research');
		});

		test('size 正确反映实例数', () => {
			expect(chatStoreManager.size).toBe(0);
			chatStoreManager.get('session:1:main', { botId: '1' });
			expect(chatStoreManager.size).toBe(1);
			chatStoreManager.get('topic:t1', { botId: '1' });
			expect(chatStoreManager.size).toBe(2);
		});

		test('topicCount 仅统计 topic 实例', () => {
			chatStoreManager.get('session:1:main', { botId: '1' });
			chatStoreManager.get('topic:t1', { botId: '1' });
			chatStoreManager.get('topic:t2', { botId: '1' });
			expect(chatStoreManager.topicCount).toBe(2);
		});
	});

	// =====================================================================
	// dispose
	// =====================================================================

	describe('dispose', () => {
		test('销毁实例并从索引移除', () => {
			chatStoreManager.get('session:1:main', { botId: '1' });
			expect(chatStoreManager.size).toBe(1);

			chatStoreManager.dispose('session:1:main');
			expect(chatStoreManager.size).toBe(0);
		});

		test('销毁 topic 实例同时更新 LRU', () => {
			chatStoreManager.get('topic:t1', { botId: '1' });
			chatStoreManager.get('topic:t2', { botId: '1' });
			expect(chatStoreManager.topicCount).toBe(2);

			chatStoreManager.dispose('topic:t1');
			expect(chatStoreManager.topicCount).toBe(1);
		});

		test('销毁不存在的 key 不报错', () => {
			chatStoreManager.dispose('nonexistent');
		});
	});

	// =====================================================================
	// LRU 淘汰
	// =====================================================================

	describe('topic LRU eviction', () => {
		test('超过上限时淘汰最久未用的 topic', () => {
			// 创建 11 个 topic（上限为 10）
			for (let i = 0; i < 11; i++) {
				chatStoreManager.get(`topic:t${i}`, { botId: '1' });
			}
			// 第 1 个（t0）应被淘汰
			expect(chatStoreManager.topicCount).toBe(10);
			expect(chatStoreManager.size).toBe(10);
		});

		test('session 实例不受淘汰影响', () => {
			chatStoreManager.get('session:1:main', { botId: '1' });
			for (let i = 0; i < 11; i++) {
				chatStoreManager.get(`topic:t${i}`, { botId: '1' });
			}
			// session 仍在
			expect(chatStoreManager.size).toBe(11); // 1 session + 10 topics
		});

		test('重复访问 topic 更新 LRU 顺序', () => {
			for (let i = 0; i < 10; i++) {
				chatStoreManager.get(`topic:t${i}`, { botId: '1' });
			}
			// 访问 t0（最旧），使其变为最新
			chatStoreManager.get('topic:t0');

			// 创建第 11 个 → 应淘汰 t1（现在最旧）
			chatStoreManager.get('topic:t10', { botId: '1' });
			expect(chatStoreManager.topicCount).toBe(10);
		});
	});

	// =====================================================================
	// __reset
	// =====================================================================

	describe('__reset', () => {
		test('清空所有实例', () => {
			chatStoreManager.get('session:1:main', { botId: '1' });
			chatStoreManager.get('topic:t1', { botId: '1' });
			chatStoreManager.__reset();

			expect(chatStoreManager.size).toBe(0);
			expect(chatStoreManager.topicCount).toBe(0);
		});
	});
});
