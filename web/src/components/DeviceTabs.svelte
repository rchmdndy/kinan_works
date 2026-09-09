<script lang="ts">
  import { devicePath, type Route } from '../lib/routes';
  let { deviceId, page }: { deviceId: string; page: Extract<Route, { id: string }>['page'] } = $props();
</script>

<nav class="device-tabs" aria-label="Halaman perangkat">
  <a href={`#${devicePath(deviceId)}`} class:active={page === 'detail'} aria-current={page === 'detail' ? 'page' : undefined}>Detail</a>
  <a href={`#${devicePath(deviceId, '/edit')}`} class:active={page === 'edit'} aria-current={page === 'edit' ? 'page' : undefined}>Edit device</a>
  <a href={`#${devicePath(deviceId, '/realtime')}`} class:active={page === 'realtime'} aria-current={page === 'realtime' ? 'page' : undefined}>Realtime</a>
</nav>
