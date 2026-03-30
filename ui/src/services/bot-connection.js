/**
 * 单个 Bot 的数据通道连接
 * 职责：RPC over DataChannel、WebRtcConnection 引用管理、事件分发
 * 无 Vue 依赖，纯 JS
 *
 * WS 信令管理已迁移至 SignalingConnection（per-tab 单例）
 */
import { useSignalingConnection } from './signaling-connection.js';

const DEFAULT_RPC_TIMEOUT_MS = 30 * 60_000; // 30 分钟兜底
/** 短暂抖动 vs 实质断连分界 */
const BRIEF_DISCONNECT_MS = 5000;
const TERMINAL_STATUSES = new Set(['ok', 'error']);

// 导出常量供外部模块使用
export { BRIEF_DISCONNECT_MS };

/**
 * Per-bot 数据通道连接
 *
 * 事件:
 * - `event:<name>` — DataChannel 推送事件 (data: payload)
 */
export class BotConnection {
	/**
	 * @param {string} botId
	 */
	constructor(botId) {
		this.botId = String(botId);

		// RPC pending
		this.__pending = new Map();
		this.__counter = 1;

		// 事件监听
		this.__listeners = new Map();

		/** @type {import('./webrtc-connection.js').WebRtcConnection | null} */
		this.__rtc = null;
	}

	/** @returns {import('./webrtc-connection.js').WebRtcConnection | null} */
	get rtc() { return this.__rtc; }

	/** 设置 RTC 连接引用 */
	setRtc(rtcConn) { this.__rtc = rtcConn; }

	/** 清除 RTC 连接引用并 reject 所有挂起请求（DC 已不可用） */
	clearRtc() {
		this.__rtc = null;
		this.__rejectAllPending('RTC connection lost', 'RTC_LOST');
	}

	/** 断开：关闭 RTC + reject pending + 释放 connId */
	disconnect() {
		console.debug('[BotConn] disconnect botId=%s', this.botId);
		if (this.__rtc) {
			try { this.__rtc.close(); } catch (err) { console.debug('[BotConn] rtc.close() failed: %s', err?.message); }
			this.__rtc = null;
		}
		this.__rejectAllPending('connection closed');
		useSignalingConnection().releaseConnId(this.botId);
	}

	/**
	 * 发送 RPC 请求
	 * @param {string} method
	 * @param {object} [params]
	 * @param {object} [options]
	 * @param {(payload: object) => void} [options.onAccepted] - 两阶段模式回调
	 * @param {(status: string, payload: object) => void} [options.onUnknownStatus]
	 * @param {number} [options.timeout] - 超时 ms
	 * @returns {Promise<object>}
	 */
	request(method, params = {}, options = {}) {
		if (!this.__rtc?.isReady) {
			const err = new Error('DataChannel not ready');
			err.code = 'DC_NOT_READY';
			return Promise.reject(err);
		}
		const id = `ui-${Date.now()}-${this.__counter++}`;
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject };
			if (options.onAccepted) waiter.onAccepted = options.onAccepted;
			if (options.onUnknownStatus) waiter.onUnknownStatus = options.onUnknownStatus;
			const timeoutMs = options.timeout ?? DEFAULT_RPC_TIMEOUT_MS;
			waiter.timer = setTimeout(() => {
				this.__pending.delete(id);
				const err = new Error('rpc timeout');
				err.code = 'RPC_TIMEOUT';
				reject(err);
			}, timeoutMs);
			this.__pending.set(id, waiter);
			this.__rtc.send({ type: 'req', id, method, params })
				.catch(() => {
					if (!this.__pending.has(id)) return;
					this.__pending.delete(id);
					clearTimeout(waiter.timer);
					const err = new Error('rtc send failed');
					err.code = 'RTC_SEND_FAILED';
					reject(err);
				});
		});
	}

	/** @param {string} event @param {Function} cb */
	on(event, cb) {
		const set = this.__listeners.get(event) ?? new Set();
		set.add(cb);
		this.__listeners.set(event, set);
	}

	/** @param {string} event @param {Function} cb */
	off(event, cb) {
		this.__listeners.get(event)?.delete(cb);
	}

	// --- 内部方法 ---

	__emit(event, data) {
		const cbs = this.__listeners.get(event);
		if (!cbs) return;
		for (const cb of cbs) {
			try { cb(data); }
			catch (e) { console.error('[BotConn] listener error:', e); }
		}
	}

	/** DataChannel 消息处理（由 WebRtcConnection 回调） */
	__onRtcMessage(payload) {
		if (payload.type === 'res' && payload.id) {
			this.__handleRpcResponse(payload);
		} else if (payload.type === 'event' && payload.event) {
			this.__emit(`event:${payload.event}`, payload.payload);
		}
	}

	__handleRpcResponse(payload) {
		const waiter = this.__pending.get(payload.id);
		if (!waiter) {
			console.warn('[BotConn] unmatched rpc response id=%s ok=%s botId=%s', payload.id, payload.ok, this.botId);
			return;
		}

		// 失败：立即 reject
		if (payload.ok === false) {
			this.__pending.delete(payload.id);
			if (waiter.timer) clearTimeout(waiter.timer);
			const err = new Error(payload?.error?.message ?? 'rpc failed');
			err.code = payload?.error?.code ?? 'RPC_FAILED';
			waiter.reject(err);
			return;
		}

		const status = payload.payload?.status;

		// 两阶段 accepted
		if (waiter.onAccepted && status === 'accepted') {
			waiter.onAccepted(payload.payload);
			return;
		}

		// 非两阶段：任何 ok=true 直接 resolve
		if (!waiter.onAccepted) {
			this.__pending.delete(payload.id);
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(payload.payload ?? {});
			return;
		}

		// 两阶段终态
		if (TERMINAL_STATUSES.has(status)) {
			this.__pending.delete(payload.id);
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.resolve(payload.payload ?? {});
			return;
		}

		// 未知中间态
		console.error('[BotConn] unknown intermediate status=%s id=%s', status, payload.id);
		if (waiter.onUnknownStatus) {
			waiter.onUnknownStatus(status, payload.payload);
		}
	}

	__rejectAllPending(message, code = 'DC_CLOSED') {
		for (const waiter of this.__pending.values()) {
			if (waiter.timer) clearTimeout(waiter.timer);
			const err = new Error(message);
			err.code = code;
			waiter.reject(err);
		}
		this.__pending.clear();
	}
}
