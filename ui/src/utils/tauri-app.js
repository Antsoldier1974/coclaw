/**
 * Tauri 壳子初始化（仅在 Tauri 环境下执行）
 */
import { isTauriApp } from './platform.js';

/**
 * @param {import('vue-router').Router} router - Vue Router 实例
 */
export function initTauriApp(router) {
	if (!isTauriApp) return;
	console.log('[tauri] desktop shell detected, initializing...');

	initDeepLink(router);
}

function initDeepLink(router) {
	try {
		const { onOpenUrl } = window.__TAURI__?.['deep-link'] ?? {};
		if (!onOpenUrl) {
			console.warn('[tauri] deep-link plugin not available');
			return;
		}
		onOpenUrl((urls) => {
			if (!urls?.length) return;
			try {
				const url = new URL(urls[0]);
				// coclaw://chat/123 → host="chat", pathname="/123"
				// 拼接为完整路由路径：/chat/123
				const routePath = '/' + [url.host, url.pathname].filter(Boolean).join('').replace(/^\/+/, '');
				if (routePath !== '/') {
					router.push(routePath);
				}
			}
			catch (e) {
				console.warn('[tauri] invalid deep-link URL:', urls[0], e);
			}
		});
		console.log('[tauri] deep-link listener registered');
	}
	catch (e) {
		console.warn('[tauri] deep-link init failed:', e);
	}
}
