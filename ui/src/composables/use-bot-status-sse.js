import { onBeforeUnmount, ref } from 'vue';

const HB_TIMEOUT_MS = 65_000; // server 30s 间隔，留 ~2x 余量
const SNAPSHOT_TIMEOUT_MS = 5_000; // 快照到达超时，回退到 loadBots

/**
 * 通过 SSE 实时接收 bot 快照、状态变更及解绑通知。
 * 连接建立后 server 推送全量快照（bot.snapshot），后续增量更新。
 * 内置心跳超时检测：超过 65s 未收到任何数据则自动重建连接。
 * @param {import('pinia').Store} botsStore - bots store 实例
 * @returns {{ connected: import('vue').Ref<boolean>, stop: () => void }}
 */
export function useBotStatusSse(botsStore) {
	const connected = ref(false);
	let es = null;
	let stopped = false;
	let hbTimer = null;
	let snapshotTimer = null;

	function resetHbTimer() {
		clearTimeout(hbTimer);
		hbTimer = setTimeout(() => {
			console.warn('[SSE] heartbeat timeout, restarting');
			connected.value = false;
			restart();
		}, HB_TIMEOUT_MS);
	}

	function clearHbTimer() {
		clearTimeout(hbTimer);
		hbTimer = null;
	}

	function clearSnapshotTimer() {
		clearTimeout(snapshotTimer);
		snapshotTimer = null;
	}

	function start() {
		if (stopped || es) return;
		es = new EventSource('/api/v1/bots/status-stream');

		es.onopen = () => {
			console.debug('[SSE] connected');
			connected.value = true;
			resetHbTimer();
			// 快照超时保护：若 server 未能推送快照，回退到 HTTP loadBots
			if (!botsStore.fetched) {
				clearSnapshotTimer();
				snapshotTimer = setTimeout(() => {
					if (!botsStore.fetched) {
						console.warn('[SSE] snapshot timeout, falling back to loadBots');
						botsStore.loadBots().catch(() => {});
					}
				}, SNAPSHOT_TIMEOUT_MS);
			}
		};

		es.onmessage = (evt) => {
			resetHbTimer();
			try {
				const data = JSON.parse(evt.data);
				console.debug('[SSE] event=%s', data.event, data);
				switch (data.event) {
					case 'bot.snapshot':
						clearSnapshotTimer();
						botsStore.applySnapshot(data.items);
						break;
					case 'bot.status':
						botsStore.updateBotOnline(data.botId, data.online);
						break;
					case 'bot.nameUpdated':
						botsStore.addOrUpdateBot({ id: data.botId, name: data.name });
						break;
					case 'bot.bound':
						botsStore.addOrUpdateBot(data.bot);
						break;
					case 'bot.unbound':
						botsStore.removeBotById(data.botId);
						break;
					case 'heartbeat':
						break;
				}
			}
			catch (err) {
				console.warn('[SSE] message handling error', err);
			}
		};

		es.onerror = () => {
			console.debug('[SSE] error/disconnected');
			connected.value = false;
			clearHbTimer();
			clearSnapshotTimer();
		};
	}

	/** 强制重建 SSE 连接（前台恢复 / 心跳超时时调用） */
	function restart() {
		if (stopped) return;
		console.debug('[SSE] restart');
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
		clearHbTimer();
		clearSnapshotTimer();
		start();
	}

	function onForeground() {
		restart();
	}

	function onNetworkOnline() {
		restart();
	}

	function stop() {
		stopped = true;
		if (es) {
			es.close();
			es = null;
		}
		connected.value = false;
		clearHbTimer();
		clearSnapshotTimer();
		window.removeEventListener('app:foreground', onForeground);
		window.removeEventListener('network:online', onNetworkOnline);
	}

	start();
	window.addEventListener('app:foreground', onForeground);
	window.addEventListener('network:online', onNetworkOnline);
	onBeforeUnmount(stop);

	return { connected, stop };
}
