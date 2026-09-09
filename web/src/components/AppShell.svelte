<script lang="ts">
  import type { AuthUser } from '../lib/api';
  import type { Route } from '../lib/routes';

  let { user, route, onlogout, children }: { user: AuthUser; route: Route; onlogout: () => void; children: import('svelte').Snippet } = $props();
  const devicesActive = (page: Route['page']) => ['devices', 'detail', 'edit', 'realtime', 'new'].includes(page);
</script>

<div class="app-layout">
  <aside class="sidebar">
    <a class="brand" href="#devices" aria-label="Kinan Works"><span class="brand-mark small">KW</span><span><strong>Kinan Works</strong><small>Telemetry console</small></span></a>
    <nav aria-label="Navigasi utama">
      <a href="#devices" class:active={devicesActive(route.page)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3"></rect><path d="M8 8h8M8 12h8M8 16h4"></path></svg>
        Devices
      </a>
      <a href="#exports" class:active={route.page === 'exports'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path></svg>
        Exports
      </a>
    </nav>
    <div class="sidebar-account"><span class="avatar">{(user.username || 'U').slice(0, 1).toUpperCase()}</span><span><strong>{user.username}</strong><button class="text-button" onclick={onlogout}>Keluar</button></span></div>
  </aside>
  <main class="main-content">{@render children()}</main>
</div>
