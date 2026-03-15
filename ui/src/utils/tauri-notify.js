/**
 * Tauri 桌面端 IM 通知能力
 * - 系统通知
 * - 任务栏/Dock 闪烁（requestUserAttention）
 * - 托盘 tooltip 动态更新
 *
 * 所有方法仅在 Tauri 环境下生效，非 Tauri 环境静默跳过。
 *
 * TODO: 任务栏叠加图标（Windows overlay icon）/ Dock 徽章（macOS setBadgeCount）
 *       需在 Tauri v2 后续版本或通过 Rust 侧命令实现，当前 JS API 不支持。
 */
import { isTauriApp } from './platform.js';

/** @returns {boolean} */
function guard() {
	return isTauriApp && !!window.__TAURI__;
}

// ---- 系统通知 ----

/**
 * 发送系统通知
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 */
export async function sendNotification({ title, body }) {
	if (!guard()) return;
	try {
		const { sendNotification: send, isPermissionGranted, requestPermission }
			= window.__TAURI__.notification;
		let granted = await isPermissionGranted();
		if (!granted) {
			const perm = await requestPermission();
			granted = perm === 'granted';
		}
		if (granted) {
			send({ title, body });
		}
	}
	catch (e) {
		console.warn('[tauri-notify] sendNotification failed:', e);
	}
}

// ---- 任务栏/Dock 闪烁 ----

/**
 * 请求用户注意（Windows 任务栏闪烁 / macOS Dock 弹跳）
 * @param {'informational' | 'critical' | null} type - null 取消闪烁
 */
export async function requestAttention(type = 'informational') {
	if (!guard()) return;
	try {
		const win = window.__TAURI__.window.getCurrentWindow();
		if (type === null) {
			await win.requestUserAttention(null);
		}
		else {
			const attnType = type === 'critical' ? 2 : 1; // Critical=2, Informational=1
			await win.requestUserAttention(attnType);
		}
	}
	catch (e) {
		console.warn('[tauri-notify] requestAttention failed:', e);
	}
}

// ---- 托盘 tooltip ----

/**
 * 更新托盘 tooltip
 * @param {string} text
 */
export async function setTrayTooltip(text) {
	if (!guard()) return;
	try {
		const { TrayIcon } = window.__TAURI__.tray;
		const tray = await TrayIcon.getById('main-tray');
		if (tray) {
			await tray.setTooltip(text);
		}
	}
	catch (e) {
		console.warn('[tauri-notify] setTrayTooltip failed:', e);
	}
}

// ---- 综合：新消息提醒 ----

/**
 * 触发新消息全套提醒（系统通知 + 任务栏闪烁 + 托盘 tooltip）
 * @param {object} opts
 * @param {string} opts.title - 通知标题
 * @param {string} opts.body - 通知正文
 * @param {number} opts.unreadCount - 未读总数
 */
export async function notifyNewMessage({ title, body, unreadCount }) {
	if (!guard()) return;

	await sendNotification({ title, body });
	await requestAttention('informational');
	// TODO: tooltip 文案应从调用方传入或接入 i18n
	await setTrayTooltip(`CoClaw (${unreadCount})`);
}

/**
 * 清除所有提醒状态（窗口获焦时调用）
 */
export async function clearNotifications() {
	if (!guard()) return;

	await requestAttention(null);
	await setTrayTooltip('CoClaw');
}
