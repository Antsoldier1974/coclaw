import { watch } from 'vue';

/**
 * 等待指定 bot 连接就绪（消费 botsStore 响应式状态）
 * @param {object} botsStore - useBotsStore() 实例
 * @param {string} botId
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<void>}
 */
export function waitForConnected(botsStore, botId, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		if (botsStore.byId[botId]?.connState === 'connected') {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			stop();
			reject(new Error('reconnect timeout'));
		}, timeoutMs);
		const stop = watch(
			() => botsStore.byId[botId]?.connState,
			(s) => {
				if (s === 'connected') {
					clearTimeout(timer);
					stop();
					resolve();
				}
			},
		);
	});
}
