import { useOverlay } from '@nuxt/ui/composables';

import UserProfileDialog from '../components/user/UserProfileDialog.vue';
import UserSettingsDialog from '../components/user/UserSettingsDialog.vue';
import { pushDialogState } from '../utils/dialog-history.js';

let profileDialog = null;
let settingsDialog = null;

function ensureDialogInstances(overlay) {
	if (!settingsDialog) {
		settingsDialog = overlay.create(UserSettingsDialog, {
			destroyOnClose: false,
		});
	}

	if (!profileDialog) {
		profileDialog = overlay.create(UserProfileDialog, {
			destroyOnClose: false,
		});
	}
}

function closeAllDialogs() {
	profileDialog?.close();
	settingsDialog?.close();
}

export function useUserDialogs() {
	const overlay = useOverlay();
	ensureDialogInstances(overlay);

	return {
		openSettingsDialog() {
			pushDialogState(closeAllDialogs);
			settingsDialog?.open();
		},
		openProfileDialog() {
			pushDialogState(closeAllDialogs);
			profileDialog?.open();
		},
	};
}
