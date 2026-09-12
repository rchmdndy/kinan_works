# Production CD

CI calls `deploy.yml` only after both GHCR images publish successfully on a main push. Tags and PR events do not deploy. Manual runs accept a full SHA with a successful main-push CI run. Configure the GitHub Environment `production` with required reviewers if the repository plan supports them. Without reviewers, deployment does not wait for approval. GitHub concurrency and VPS flock prevent overlapping deployments. GitHub may replace a queued pending run; this is not a FIFO deployment queue.

## One-time VPS installation

Review scripts before installing. Use the existing administrative SSH access, not the CI key. Copy `deploy.sh` and `ssh-command.sh` to a temporary directory on the VPS, then:

```sh
sudo apt install -y python3 util-linux
sudo useradd --create-home --shell /bin/bash kinan-deploy
sudo install -o root -g root -m 755 deploy.sh /usr/local/sbin/kinan-deploy
sudo install -o root -g root -m 755 ssh-command.sh /usr/local/sbin/kinan-deploy-ssh
sudo install -d -o root -g root -m 755 /home/kinan-deploy/.ssh
```

If the account already exists, inspect it instead of running `useradd` again. It must not belong to sudo/docker groups. Scripts, Compose, `.env.vps`, and broker configuration must be root-owned and not writable by this account. Do not recursively change ownership of the data directory or broker runtime files. Rootful Docker is privileged; restricting deployment access does not make deployment of a malicious image harmless. Protect main, environment approvals, and workflow edits.

Generate a **separate** Ed25519 key on your trusted workstation for GitHub Actions. Do not reuse the administrative key. Put its public key into a root-owned `/home/kinan-deploy/.ssh/authorized_keys` file with mode 644 and this prefix:

```text
restrict,command="/usr/local/sbin/kinan-deploy-ssh" ssh-ed25519 <PUBLIC-KEY> kinan-production-cd
```

Add using `sudo visudo -f /etc/sudoers.d/kinan-deploy`:

```text
kinan-deploy ALL=(root) NOPASSWD: /usr/local/sbin/kinan-deploy sha-*
```

The root script independently requires exactly one SHA argument. Validate with `sudo visudo -cf /etc/sudoers.d/kinan-deploy`. No unrestricted shell, forwarding, PTY, file transfer, or arbitrary sudo command is granted by this key. Ensure account policy permits SSH public-key login while password login is disabled.

## GitHub Environment secrets

Set these on `production` in Settings → Environments, never in repository files:

- `VPS_HOST`: `43.173.2.49`
- `VPS_SSH_PRIVATE_KEY`: the new dedicated private key (OpenSSH format)
- `VPS_KNOWN_HOSTS`: verified known_hosts entry for the exact host/IP above. Verify fingerprint through provider console; do not trust an unverified ssh-keyscan or disable host checking.

Environment secrets are read by the job bound to production. Both caller and reusable workflow must exist on main. Do not deploy until the VPS scripts, account, key and environment are configured. Private GHCR packages require a root Docker login on the VPS with read-only package access; public packages need no registry secret.

## Deployment behavior

The script validates both fixed app image references and OCI revision labels, pulls before stopping anything, stops the sole API SQLite writer, creates a consistent SQLite backup with integrity check, updates only IMAGE_TAG atomically, runs Compose, then checks public HTTPS and API/Redis health. MQTT end-to-end delivery is not covered by these health probes.

Backups and prior environment files are root-only under `/var/backups/kinan-works/`. They contain sensitive data and encryption keys. Arrange encrypted off-server backup and retention before sustained production use; this script does not upload backups or delete old ones. Monitor free disk space. Deployment history is `/var/lib/kinan-deploy/history.log`.

Failure before new code starts restarts the old API when possible. Failure after new code may have migrated the database fails visibly and **does not roll back automatically**. Inspect the migration and logs; choose a compatible previous image or a deliberate database restore during maintenance. Never restore an old database without considering newly ingested data. Do not run `down -v`.

## Compose/configuration releases

This initial CD updates application image tags only. It deliberately cannot upload or replace privileged Compose, broker files, Caddy configuration, or its own scripts. For releases changing those files, review and install the matching files through administrative SSH **before approving deployment**, with compatibility assessed. No git clone/build occurs on VPS. A fully versioned configuration-artifact deployment is not implemented yet.

## Verification

```sh
bash -n scripts/deploy/deploy.sh scripts/deploy/ssh-command.sh
python3 scripts/deploy/test_deploy.py
```

Test the restricted key with a malformed command first; it must reject without changing services. Then approve a same-version deployment during a maintenance window to exercise backup/recreate. This is downtime-tolerant single-instance CD, not blue-green.
