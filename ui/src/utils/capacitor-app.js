/**
 * Capacitor 原生壳初始化
 * - Edge-to-Edge 状态栏配置
 * - Android 返回键处理
 */
import { Capacitor } from '@capacitor/core';
import { hasOpenDialog, closeCurrentDialog } from './dialog-history.js';

/** 是否运行在 Capacitor 原生壳中 */
export const isNative = Capacitor.isNativePlatform();

/**
 * 初始化 Capacitor 原生能力
 * @param {import('vue-router').Router} router - Vue Router 实例
 */
export async function initCapacitorApp(router) {
	if (!isNative) return;
	console.log('[capacitor] native platform detected, initializing...');

	try {
		await setupStatusBar();
	}
	catch (e) {
		console.warn('[capacitor] StatusBar init failed:', e);
	}

	try {
		setupBackButton(router);
	}
	catch (e) {
		console.warn('[capacitor] BackButton init failed:', e);
	}
}

async function setupStatusBar() {
	const { StatusBar, Style } = await import('@capacitor/status-bar');
	await StatusBar.setOverlaysWebView({ overlay: true });
	await StatusBar.setStyle({ style: Style.Dark });
	await StatusBar.setBackgroundColor({ color: '#00000000' });
	console.log('[capacitor] StatusBar configured (overlay + transparent)');
}

function setupBackButton(router) {
	import('@capacitor/app').then(({ App }) => {
		App.addListener('backButton', ({ canGoBack }) => {
			// 优先关闭打开的对话框
			if (hasOpenDialog()) {
				closeCurrentDialog();
				return;
			}
			const isTopPage = !!router.currentRoute.value?.meta?.isTopPage;
			if (isTopPage || !canGoBack) {
				App.minimizeApp();
				return;
			}
			window.history.back();
		});
		console.log('[capacitor] backButton listener registered');
	});
}
