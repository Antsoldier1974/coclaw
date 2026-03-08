/**
 * 跨平台 mock os.homedir()
 *
 * Node.js os.homedir() 在不同平台读取不同环境变量：
 * - POSIX: HOME
 * - Windows: USERPROFILE（优先）、HOMEDRIVE+HOMEPATH
 *
 * 测试中需同时设置两端变量，确保 os.homedir() 返回期望路径。
 */

const HOME_VARS = ['HOME', 'USERPROFILE'];

/**
 * 保存当前 home 相关环境变量
 * @returns {Record<string, string | undefined>}
 */
export function saveHomedir() {
	const saved = {};
	for (const key of HOME_VARS) {
		saved[key] = process.env[key];
	}
	return saved;
}

/**
 * 将 home 相关环境变量统一设置为指定路径
 * @param {string} dir - 目标路径
 */
export function setHomedir(dir) {
	for (const key of HOME_VARS) {
		process.env[key] = dir;
	}
}

/**
 * 恢复之前保存的 home 相关环境变量
 * @param {Record<string, string | undefined>} saved
 */
export function restoreHomedir(saved) {
	for (const key of HOME_VARS) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
}
