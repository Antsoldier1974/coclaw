import { watch } from 'vue';

/**
 * 等待指定 bot DataChannel 就绪（消费 botsStore 响应式状态）
 * @param {object} botsStore - useBotsStore() 实例
 * @param {string} botId
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<void>}
 */
export function waitForConnected(botsStore, botId, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		if (botsStore.byId[botId]?.dcReady) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			stop();
			reject(new Error('reconnect timeout'));
		}, timeoutMs);
		const stop = watch(
			() => botsStore.byId[botId]?.dcReady,
			(ready) => {
				if (ready) {
					clearTimeout(timer);
					stop();
					resolve();
				}
			},
		);
	});
}
