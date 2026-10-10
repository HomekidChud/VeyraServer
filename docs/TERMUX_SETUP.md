# Run Veyra's maze training in Termux

This is a **best-effort Android phone setup**, not guaranteed 24/7 compute. Android can stop background apps, and continuous CPU use can heat the phone and drain or age its battery. The training loop is a synthetic maze simulation; it is not LLM/foundation-model training and it does not gather internet or personal data.

## 1. Repair the package error shown in the log

The failure is in `python-scipy`'s post-install step from the enabled TUR package source. It is not a Veyra or Node error. Veyra is a Node project and does not need SciPy. TUR is an additional, non-core Termux repository; do not use `sudo` or `systemctl` in Termux.

If you do **not** rely on SciPy for another app, remove only that package first:

```sh
pkg uninstall -y python-scipy
```

If `pkg uninstall` cannot proceed because the package is left half-configured, remove that one broken package and finish any remaining package configuration:

```sh
dpkg --remove --force-remove-reinstreq python-scipy
dpkg --configure -a
```

If the first command says SciPy is not installed, skip directly to installing the Veyra dependencies. If SciPy is needed for another workflow, do not remove it; keep the traceback and diagnose/update that TUR package separately. Avoid rerunning `pkg upgrade -y` until that package's post-install failure is resolved.

Then install only Veyra's runtime requirements:

```sh
pkg install -y git nodejs-lts openssl curl termux-services termux-api
node --version
```

Veyra requires Node 20 or later. If `dpkg --configure -a` still fails, stop before more package changes and copy the new error output; do not delete files under `$PREFIX` manually.

## 2. Install the training branch

Use the branch containing the training loop and this local-data improvement. On a fresh install:

```sh
git clone --single-branch --branch manus/termux-local-experience-data \
  https://github.com/HomekidChud/VeyraServer.git "$HOME/VeyraServer"
cd "$HOME/VeyraServer"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

If you already have the repository:

```sh
cd "$HOME/VeyraServer"
git fetch origin
git switch manus/termux-local-experience-data
git pull --ff-only
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

The browser engine is disabled for this phone profile, so there is no need to install Chromium. Starting `node src/server.js` directly also avoids a browser install step.

## 3. Configure private local checkpoints and data capture

Create a private data/config directory and generate an auth secret on the phone:

```sh
mkdir -p "$HOME/.config/veyra" "$HOME/.local/share/veyra/data" "$HOME/.local/share/veyra/agent-training"
chmod 700 "$HOME/.config/veyra" "$HOME/.local/share/veyra" \
  "$HOME/.local/share/veyra/data" "$HOME/.local/share/veyra/agent-training"
openssl rand -hex 32
nano "$HOME/.config/veyra/server.env"
```

Paste this into the file. Replace the two placeholders locally on the phone; never send the secret in chat:

```sh
export VEYRA_AUTH_SECRET='PASTE_THE_RANDOM_VALUE_HERE'
export VEYRA_ADMIN_EMAILS='your-admin-email@example.com'
export VEYRA_DATA_DIR="$HOME/.local/share/veyra/data"
export VEYRA_AGENT_TRAINING_DIR="$HOME/.local/share/veyra/agent-training"
export VEYRA_ENV='production'
export VEYRA_AGENT_TRAINING_ENABLED='true'
export VEYRA_AGENT_TRAINING_REQUIRE_MONGO='false'
export VEYRA_AGENT_TRAINING_TICK_MS='500'
export VEYRA_AGENT_TRAINING_CHECKPOINT_STEPS='20'
export VEYRA_AGENT_TRAINING_MAX_MAZE='15'
export VEYRA_AGENT_TRAINING_SAMPLES_PER_EPISODE='256'
export VEYRA_AGENT_TRAINING_LOCAL_EPISODES='500'
export BROWSER_ENABLED='false'
export PORT='10000'
```

The correct admin setting is **`VEYRA_ADMIN_EMAILS`**, not `ADMIN_EMAILS`. `VEYRA_AGENT_TRAINING_REQUIRE_MONGO=false` is deliberate: on-device mode saves its checkpoint and generated experience locally and does not pause waiting for a MongoDB server. You do not need to set `MONGODB_URI` for this mode.

The local archive is `episodes.jsonl` in the training directory. It keeps the newest 500 episode records by default and at most 256 visible-observation/action/reward samples per episode. It excludes the hidden maze layout. The sample cap and episode cap prevent unbounded storage growth; raise them only if you have enough free storage. The archive is a reusable synthetic dataset, but the current rule-based policy does **not** learn neural-network weights from it automatically.

Secure the file:

```sh
chmod 600 "$HOME/.config/veyra/server.env"
```

## 4. Test locally before enabling runit

```sh
cd "$HOME/VeyraServer"
set -a
. "$HOME/.config/veyra/server.env"
set +a
node src/server.js
```

In another Termux session:

```sh
curl -fsS http://127.0.0.1:10000/health
wc -l "$HOME/.local/share/veyra/agent-training/episodes.jsonl"
```

The episode file appears after an episode completes. To view the admin training status, use the signed-in admin interface or the protected `/api/admin/agent-training` route. The earlier pasted `/api/assistant/status` check is not the training-status endpoint.

Stop the foreground test with Ctrl+C before creating the runit service.

## 5. Keep it running while Termux is alive

After installing `termux-services`, close and reopen Termux so its service manager starts. Then create the service:

```sh
mkdir -p "$PREFIX/var/service/veyra"
cat > "$PREFIX/var/service/veyra/run" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
cd "$HOME/VeyraServer" || exit 1
set -a
. "$HOME/.config/veyra/server.env"
set +a
exec node src/server.js
EOF
chmod +x "$PREFIX/var/service/veyra/run"
sv-enable veyra
sv status veyra
```

Read logs or stop training with:

```sh
tail -f "$PREFIX/var/log/sv/veyra/current"
sv down veyra
```

## 6. Optional restart after a phone reboot

Install the Termux:Boot and Termux:API companion apps from the **same distribution/signing source** as Termux. Open Termux:Boot once, then create:

```sh
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/10-veyra-services" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
. /data/data/com.termux/files/usr/etc/profile.d/start-services.sh
EOF
chmod +x "$HOME/.termux/boot/10-veyra-services"
```

Set battery use for Termux and Termux:Boot to **Unrestricted** in Android settings. Keep the phone ventilated and monitor heat. A wake lock and boot script improve persistence, but neither overrides Android force-stop behavior, thermal limits, battery shutdown, or vendor background restrictions. Do not expose or port-forward the service's port to the public internet.

## What “more data” means here

This update records more generated maze experience locally. It does not make the agents collect web data, learn from your files, or become a general-purpose AI. The existing decision policy is rule-driven. To make the policy actually learn from recorded examples, a separate learning algorithm and a clear training objective would still be needed.

**References:** [Termux services](https://github.com/termux/termux-services), [Termux Boot](https://github.com/termux/termux-boot), [Termux API](https://github.com/termux/termux-api), [Termux User Repository (TUR)](https://github.com/termux-user-repository/tur).
