/**
 * 统一平台检测
 * - Capacitor：移动端原生壳（Android/iOS）
 * - Tauri：桌面端原生壳（Windows/macOS）
 * - Web：普通浏览器
 *
 * 注意：此模块不依赖 capacitor-app.js，避免 Tauri/Web 环境加载 @capacitor/core
 */

/** 是否运行在桌面壳子（Tauri）中 */
export const isTauriApp = '__TAURI_INTERNALS__' in window;

/** 是否运行在移动壳子（Capacitor）中 */
export const isCapacitorApp = !!window.Capacitor?.isNativePlatform();

/** 是否运行在任何原生壳子中（Capacitor 或 Tauri） */
export const isNativeShell = isCapacitorApp || isTauriApp;

/** 是否为桌面环境（Tauri 或普通浏览器桌面视口） */
export const isDesktop = isTauriApp || !isCapacitorApp;

/**
 * 平台标识
 * @returns {'capacitor' | 'tauri' | 'web'}
 */
export function getPlatformType() {
	if (isCapacitorApp) return 'capacitor';
	if (isTauriApp) return 'tauri';
	return 'web';
}
