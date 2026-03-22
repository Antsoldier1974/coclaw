export function isMobileViewport(width) {
	if (typeof width !== 'number') {
		return false;
	}
	return width <= 767;
}