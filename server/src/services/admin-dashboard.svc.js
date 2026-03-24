import { createRequire } from 'node:module';

import * as adminRepo from '../repos/admin.repo.js';
import { listOnlineBotIds } from '../bot-ws-hub.js';

const require = createRequire(import.meta.url);
const { version: serverVersion } = require('../../package.json');

/**
 * 从 npm registry 获取 @coclaw/openclaw-coclaw 最新发布版本
 * @returns {Promise<string|null>}
 */
async function fetchPluginVersionFromNpm() {
	try {
		const res = await fetch('https://registry.npmjs.org/@coclaw/openclaw-coclaw/latest');
		if (!res.ok) return null;
		const { version } = await res.json();
		return version ?? null;
	} catch {
		return null;
	}
}

/**
 * @param {object} [deps] - 依赖注入
 * @param {object} [deps.repo] - admin repo
 * @param {Function} [deps.getOnlineBotCount] - 获取在线 bot 数
 * @param {Function} [deps.fetchPluginVersion] - 获取插件版本
 */
export async function getAdminDashboard(deps = {}) {
	const repo = deps.repo ?? adminRepo;
	const getOnlineBotCount = deps.getOnlineBotCount ?? (() => listOnlineBotIds().size);
	const getPluginVersion = deps.fetchPluginVersion ?? fetchPluginVersionFromNpm;

	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [total, todayNew, todayActive, topActive, latestRegistered, botsTotal, pluginVersion] = await Promise.all([
		repo.countUsers(),
		repo.countUsersCreatedSince(todayStart),
		repo.countUsersActiveSince(todayStart),
		repo.topActiveUsers(10),
		repo.latestRegisteredUsers(30),
		repo.countBots(),
		getPluginVersion(),
	]);

	return {
		users: { total, todayNew, todayActive },
		topActiveUsers: topActive,
		latestRegisteredUsers: latestRegistered,
		bots: {
			total: botsTotal,
			online: getOnlineBotCount(),
		},
		version: {
			server: serverVersion,
			plugin: pluginVersion,
		},
	};
}
