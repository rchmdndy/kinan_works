<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api, ApiError, setCsrfToken, type AuthUser } from './lib/api';
  import { parseHashRoute, type Route } from './lib/routes';
  import type { Device } from './lib/types';
  import AppShell from './components/AppShell.svelte';
  import LoginForm from './components/LoginForm.svelte';
  import Devices from './pages/Devices.svelte';
  import DeviceCreate from './pages/DeviceCreate.svelte';
  import DeviceDetail from './pages/DeviceDetail.svelte';
  import DeviceEdit from './pages/DeviceEdit.svelte';
  import DeviceRealtime from './pages/DeviceRealtime.svelte';
  import Exports from './pages/Exports.svelte';

  let user: AuthUser | null = null;
  let sessionBusy = true;
  let authBusy = false;
  let devicesBusy = false;
  let message = '';
  let devices: Device[] = [];
  let route: Route = { page: 'devices' };
  let sessionVersion = 0;
  let revealedSecret = '';
  let secretDeviceId = '';

  function routeDeviceId(current: Route): string | null {
    return current.page === 'detail' || current.page === 'edit' || current.page === 'realtime' ? current.id : null;
  }
  $: selectedDevice = routeDeviceId(route) ? devices.find((device) => device.id === routeDeviceId(route)) || null : null;

  function clearSession() { devices = []; user = null; setCsrfToken(null); revealedSecret = ''; secretDeviceId = ''; }
  function unauthenticated(error?: unknown) { sessionVersion += 1; clearSession(); if (!(error instanceof ApiError && error.status === 401) && error) message = error instanceof Error ? error.message : 'Sesi tidak dapat diperiksa.'; }
  async function loadDevices() {
    devicesBusy = true;
    try { devices = (await api<{ devices: Device[] }>('/api/devices')).devices; }
    catch (error) { if (error instanceof ApiError && error.status === 401) unauthenticated(error); throw error; }
    finally { devicesBusy = false; }
  }
  async function restoreSession() {
    const version = ++sessionVersion; sessionBusy = true; message = '';
    try { user = (await api<{ user: AuthUser }>('/api/auth/session')).user; await loadDevices(); }
    catch (error) { if (version === sessionVersion) unauthenticated(error); }
    finally { if (version === sessionVersion) sessionBusy = false; }
  }
  async function login(username: string, password: string) {
    const version = ++sessionVersion; authBusy = true; message = '';
    try { const result = await api<{ user: AuthUser; csrfToken: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); if (version !== sessionVersion) return; setCsrfToken(result.csrfToken); user = result.user; await loadDevices(); }
    catch (error) { if (version === sessionVersion) { clearSession(); message = error instanceof Error ? error.message : 'Autentikasi gagal.'; } }
    finally { if (version === sessionVersion) authBusy = false; }
  }
  async function logout() { ++sessionVersion; authBusy = true; message = ''; clearSession(); try { await api<void>('/api/auth/logout', { method: 'POST' }); } catch (error) { message = error instanceof Error ? error.message : 'Sesi lokal sudah ditutup, tetapi server gagal dijangkau.'; } finally { authBusy = false; } }
  function updateDevice(device: Device) { devices = devices.map((item) => item.id === device.id ? device : item); }
  function createdDevice(device: Device, secret: string) { devices = [...devices, device]; secretDeviceId = device.id; revealedSecret = secret; }
  function syncRoute() { route = parseHashRoute(window.location.hash); if (!('id' in route) || route.id !== secretDeviceId) { revealedSecret = ''; secretDeviceId = ''; } }

  onMount(() => { window.addEventListener('hashchange', syncRoute); if (!window.location.hash) window.location.hash = '#devices'; syncRoute(); void restoreSession(); });
  onDestroy(() => { sessionVersion += 1; window.removeEventListener('hashchange', syncRoute); clearSession(); });
</script>

<svelte:head><title>Kinan Works | Telemetry</title></svelte:head>
{#if sessionBusy}
  <main class="auth-shell" aria-busy="true"><section class="auth-card"><div class="brand-mark">KW</div><div class="spinner"></div><p class="muted">Memeriksa sesi…</p></section></main>
{:else if !user}
  <LoginForm busy={authBusy} {message} onsubmit={(username, password) => void login(username, password)} />
{:else}
  <AppShell {user} {route} onlogout={() => void logout()}>
    {#if route.page === 'devices'}<Devices {devices} busy={devicesBusy} />
    {:else if route.page === 'new'}<DeviceCreate oncreated={createdDevice} />
    {:else if route.page === 'exports'}<Exports {devices} />
    {:else if selectedDevice}
      {#if route.page === 'detail'}<DeviceDetail device={selectedDevice} secret={secretDeviceId === selectedDevice.id ? revealedSecret : ''} ondevicechange={updateDevice} />
      {:else if route.page === 'edit'}<DeviceEdit device={selectedDevice} ondevicechange={updateDevice} />
      {:else}<DeviceRealtime device={selectedDevice} />{/if}
    {:else}<section class="panel empty"><h2>Device tidak ditemukan</h2><p>Perangkat ini tidak tersedia atau sudah dihapus.</p><a class="button" href="#devices">Kembali ke devices</a></section>{/if}
  </AppShell>
{/if}
