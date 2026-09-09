<script lang="ts">
  let {
    busy = false,
    message = '',
    onsubmit,
  }: {
    busy?: boolean;
    message?: string;
    onsubmit: (username: string, password: string) => void;
  } = $props();
  let username = $state('');
  let password = $state('');

  function submit(event: SubmitEvent) {
    event.preventDefault();
    onsubmit(username, password);
    password = '';
  }
</script>

<main class="auth-shell">
  <section class="auth-card" aria-labelledby="login-title">
    <div class="brand-mark">KW</div>
    <p class="auth-rule">KINAN WORKS</p>
    <h1 id="login-title">Telemetry console</h1>
    <p class="muted">Masuk untuk memantau perangkat dan data sensor.</p>
    <form onsubmit={submit}>
      <label
        >Username<input
          type="text"
          bind:value={username}
          required
          autocomplete="username"
          disabled={busy}
        /></label
      >
      <label
        >Password<input
          type="password"
          bind:value={password}
          required
          minlength="6"
          autocomplete="current-password"
          disabled={busy}
        /></label
      >
      <button type="submit" disabled={busy}
        >{busy ? 'Memeriksa…' : 'Masuk'}</button
      >
    </form>
    <p class="auth-note">
      Akun dikelola administrator server. Hubungi administrator jika Anda
      memerlukan akses.
    </p>
    {#if message}<p class="form-error" role="alert">{message}</p>{/if}
  </section>
</main>
