/**
 * 全局未捕获异常处理
 * 设计理念：尽可能暴露问题，不静默吞掉异常
 */

/** @type {((msg: string) => void) | null} */
let notifyFn = null;

/**
 * 注入 notify 函数（在 Vue app mount 后调用）
 * @param {(msg: string) => void} fn
 */
export function setGlobalErrorNotify(fn) {
	notifyFn = fn;
}

function showError(msg) {
	console.error('[global-error]', msg);
	if (notifyFn) {
		notifyFn(msg);
	}
}

/**
 * 安装全局错误监听器（在 app 初始化时调用一次）
 * @param {import('vue').App} app - Vue App 实例
 */
export function installGlobalErrorHandlers(app) {
	// Vue 组件内未捕获异常
	app.config.errorHandler = (err, _vm, info) => {
		showError(`[Vue ${info}] ${err?.message || err}`);
	};

	// 全局 JS 未捕获异常
	window.addEventListener('error', (event) => {
		// 忽略资源加载错误（如图片 404），只处理脚本错误
		if (event.target !== window) return;
		showError(event.message || 'Unknown error');
	});

	// 未处理的 Promise rejection
	window.addEventListener('unhandledrejection', (event) => {
		const reason = event.reason;
		const msg = reason?.message || reason?.toString?.() || 'Unhandled promise rejection';
		showError(msg);
	});
}
