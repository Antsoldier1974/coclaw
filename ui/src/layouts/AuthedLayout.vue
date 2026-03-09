<template>
	<div class="min-h-screen bg-default text-highlighted">
		<div class="flex min-h-screen">
			<DesktopSidebar
				:current-path="$route.path"
				:user="authStore.user"
				@logout="onLogout"
			/>

			<section
				class="flex min-h-screen min-w-0 flex-1 flex-col"
				:class="sectionClasses"
			>
				<router-view />
				<MobileBottomTabs v-if="showMobileNav" :current-path="$route.path" />
			</section>
		</div>
	</div>
</template>

<script>
import DesktopSidebar from '../components/DesktopSidebar.vue';
import MobileBottomTabs from '../components/MobileBottomTabs.vue';
import { useBotStatusPoll } from '../composables/use-bot-status-poll.js';
import { useBotStatusSse } from '../composables/use-bot-status-sse.js';
import { useAuthStore } from '../stores/auth.store.js';
import { useBotsStore } from '../stores/bots.store.js';

export default {
	name: 'AuthedLayout',
	components: {
		DesktopSidebar,
		MobileBottomTabs,
	},
	setup() {
		const botsStore = useBotsStore();
		const { connected: sseConnected } = useBotStatusSse(botsStore);
		useBotStatusPoll(botsStore, { sseConnected });
		return {
			authStore: useAuthStore(),
		};
	},
	computed: {
		showMobileNav() {
			return !this.$route.meta.hideMobileNav;
		},
		isTopPage() {
			return !!this.$route.meta.isTopPage;
		},
		sectionClasses() {
			const cls = [];
			// 顶级页面无 MobilePageHeader，需要为状态栏留出安全距离
			if (this.isTopPage) cls.push('pt-[env(safe-area-inset-top)] md:pt-0');
			// 底部导航可见时为其留出空间
			if (this.showMobileNav) cls.push('pb-[calc(3.25rem+env(safe-area-inset-bottom))] md:pb-0');
			return cls.join(' ');
		},
	},
	async mounted() {
		// 为非 requiresAuth 路由（如 AboutPage）填充用户数据
		await this.authStore.refreshSession();
	},
	methods: {
		async onLogout() {
			await this.authStore.logout();
			if (this.$route.path !== '/about') {
				this.$router.replace('/about');
			}
		},
	},
};
</script>
