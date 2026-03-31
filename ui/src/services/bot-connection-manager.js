/**
 * BotConnection 实例管理器（全局单例）
 * 管理所有 per-bot DC 连接实例的生命周期。
 * WS 信令已迁移至 SignalingConnection（per-tab 单例）。
 */
import { BotConnection } from './bot-connection.js';
import { useSignalingConnection } from './signaling-connection.js';

let instance = null;

class BotConnectionManager {
	constructor() {
		/** @type {Map<string, BotConnection>} */
		this.__connections = new Map();
	}

	/**
	 * 为指定 bot 创建连接实例（幂等：已存在则返回现有实例）
	 * @param {string} botId
	 * @returns {BotConnection}
	 */
	connect(botId) {
		const key = String(botId);
		const existing = this.__connections.get(key);
		if (existing) return existing;
		console.debug('[BotConnMgr] connect botId=%s', key);
		const conn = new BotConnection(key);
		this.__connections.set(key, conn);
		return conn;
	}

	/**
	 * 断开指定 bot 连接
	 * @param {string} botId
	 */
	disconnect(botId) {
		const key = String(botId);
		const conn = this.__connections.get(key);
		if (!conn) return;
		console.debug('[BotConnMgr] disconnect botId=%s', key);
		conn.disconnect();
		this.__connections.delete(key);
	}

	/**
	 * 获取指定 bot 的连接实例
	 * @param {string} botId
	 * @returns {BotConnection | undefined}
	 */
	get(botId) {
		return this.__connections.get(String(botId));
	}

	/**
	 * 同步连接列表：连接新增的 bot，断开已移除的 bot
	 * @param {string[]} botIds - 当前需要连接的 bot ID 列表
	 */
	syncConnections(botIds) {
		const desired = new Set(botIds.map(String));
		console.debug('[BotConnMgr] sync desired=%o current=%o', [...desired], [...this.__connections.keys()]);
		// 断开不再需要的
		for (const key of [...this.__connections.keys()]) {
			if (!desired.has(key)) {
				this.disconnect(key);
			}
		}
		// 连接新增的
		for (const id of desired) {
			if (!this.__connections.has(id)) {
				this.connect(id);
			}
		}
	}

	/** 断开所有连接 */
	disconnectAll() {
		console.debug('[BotConnMgr] disconnectAll count=%d', this.__connections.size);
		for (const key of [...this.__connections.keys()]) {
			this.disconnect(key);
		}
	}

	/**
	 * 获取所有连接的状态（统一返回信令 WS 的全局状态）
	 * @returns {Object<string, string>}
	 */
	getStates() {
		const sigState = useSignalingConnection().state;
		const states = {};
		for (const key of this.__connections.keys()) {
			states[key] = sigState;
		}
		return states;
	}

	/** @returns {number} 当前连接数 */
	get size() {
		return this.__connections.size;
	}
}

/**
 * 获取全局 BotConnectionManager 单例
 * @returns {BotConnectionManager}
 */
export function useBotConnections() {
	if (!instance) {
		instance = new BotConnectionManager();
	}
	return instance;
}

/**
 * 重置单例（仅测试用）
 */
export function __resetBotConnections() {
	if (instance) {
		instance.disconnectAll();
		instance = null;
	}
}

export { BotConnectionManager };
