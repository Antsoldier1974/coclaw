<template>
	<div class="mx-auto w-full max-w-3xl pl-1.5">
		<UDropdownMenu
			:items="menuItems"
			:content="{ side: 'top', align: 'start' }"
		>
			<UButton
				data-testid="btn-slash-menu"
				variant="ghost"
				color="primary"
				icon="i-lucide-chevron-right"
				size="sm"
				:disabled="disabled"
			/>
		</UDropdownMenu>
	</div>
</template>

<script>
export default {
	name: 'SlashCommandMenu',
	props: {
		disabled: { type: Boolean, default: false },
	},
	emits: ['command'],
	computed: {
		menuItems() {
			const emit = (cmd) => () => this.$emit('command', cmd);
			return [
				{
					label: this.$t('slashCmd.compact'),
					icon: 'i-lucide-archive',
					onSelect: emit('/compact'),
				},
				{
					label: this.$t('slashCmd.reset'),
					icon: 'i-lucide-refresh-cw',
					onSelect: emit('/new'),
				},
				{
					label: this.$t('slashCmd.help'),
					icon: 'i-lucide-help-circle',
					onSelect: emit('/help'),
				},
			];
		},
	},
};
</script>
