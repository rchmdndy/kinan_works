<script lang="ts">
  import { Tabs } from 'bits-ui';
  import { devicePath, type Route } from '../lib/routes';
  let {
    deviceId,
    page,
  }: { deviceId: string; page: Extract<Route, { id: string }>['page'] } =
    $props();
  const tabs = $derived([
    { value: 'detail', label: 'Detail', href: devicePath(deviceId) },
    {
      value: 'edit',
      label: 'Edit device',
      href: devicePath(deviceId, '/edit'),
    },
    {
      value: 'realtime',
      label: 'Realtime',
      href: devicePath(deviceId, '/realtime'),
    },
    {
      value: 'credential',
      label: 'Credential',
      href: devicePath(deviceId, '/credential'),
    },
  ]);
</script>

<Tabs.Root value={page} orientation="horizontal">
  <Tabs.List class="device-tabs">
    {#each tabs as tab (tab.value)}
      <Tabs.Trigger
        value={tab.value}
        class="device-tabs-trigger"
        onclick={() => (window.location.hash = tab.href)}
      >
        {tab.label}
      </Tabs.Trigger>
    {/each}
  </Tabs.List>
</Tabs.Root>
