<template>
	<img
		:src="src"
		alt=""
		class="rounded-lg"
		:class="[customClass, { 'cursor-pointer': loaded }]"
		@load="loaded = true"
		@click="viewImg"
	/>
	<ImgViewDialog
		v-model:open="dialogOpen"
		:src="src"
		:filename="filename"
	/>
</template>

<script>
import ImgViewDialog from './ImgViewDialog.vue';
import { pushDialogState } from '../utils/dialog-history.js';

export default {
	name: 'ChatImg',
	components: { ImgViewDialog },
	props: {
		src: {
			type: String,
			required: true,
		},
		filename: {
			type: String,
			default: 'image',
		},
		customClass: {
			type: String,
			default: '',
		},
	},
	data() {
		return {
			loaded: false,
			dialogOpen: false,
		};
	},
	methods: {
		viewImg() {
			if (!this.loaded) return;
			pushDialogState(() => {
				this.dialogOpen = false;
			});
			this.dialogOpen = true;
		},
	},
};
</script>
