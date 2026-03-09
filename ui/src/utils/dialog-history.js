/**
 * 对话框 history 状态管理
 * 打开对话框时 pushState，返回手势触发 popstate 时通过回调关闭对话框
 * 独立模块，不依赖任何对话框组件，避免循环依赖
 */

const DIALOG_STATE_KEY = '__dialog';

/** @type {(() => void) | null} */
let closeCallback = null;
let statePushed = false;
let listenerBound = false;

function onPopState() {
	if (statePushed && closeCallback) {
		statePushed = false;
		closeCallback();
	}
}

function ensureListener() {
	if (listenerBound) return;
	listenerBound = true;
	window.addEventListener('popstate', onPopState);
}

/**
 * 对话框打开时调用
 * @param {() => void} onBack - 返回手势时的关闭回调
 */
export function pushDialogState(onBack) {
	ensureListener();
	if (!statePushed) {
		statePushed = true;
		closeCallback = onBack;
		history.pushState({ [DIALOG_STATE_KEY]: true }, '');
	}
}

/**
 * 对话框被关闭后调用（非返回手势触发的关闭，如点击关闭按钮、遮罩）
 * 回退 pushState 以保持 history 栈干净
 */
export function popDialogState() {
	if (statePushed) {
		statePushed = false;
		closeCallback = null;
		history.back();
	}
}

/** 是否有通过 pushDialogState 打开的对话框 */
export function hasOpenDialog() {
	return statePushed;
}

/** 关闭当前对话框（供 Capacitor backButton 调用） */
export function closeCurrentDialog() {
	if (statePushed && closeCallback) {
		const cb = closeCallback;
		statePushed = false;
		closeCallback = null;
		cb();
	}
}
