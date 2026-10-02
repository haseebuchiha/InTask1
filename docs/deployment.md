# Deployment

How the live copy runs on the VPS, the commands that put it there, and how to update it. The reasoning for a long-lived server is [decision 2](decisions.md#2-run-on-a-long-lived-server-not-serverless).

The app is live at **[https://ping-monitor.applyfast.tech](https://ping-monitor.applyfast.tech)**. The brief says "deploy to any free platform", and a serverless free tier can't keep a timer running or hold streams open: the timer and the open streams need a process that stays up. It runs on a VPS that already hosts other things, so it shares the box's nginx, Postgres 17 and the `openai-oauth` proxy. Postgres runs on the VPS itself, as the database `task1`, reached over loopback: the app and the database sit on one machine, so a managed tier would only add a network hop and a second place to look when something breaks.

## Installing

On the server, with Node 24, pnpm, pm2 and nginx installed, and a Postgres database ready:

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # set DATABASE_URL, and the LLM_ or AI_GATEWAY_API_KEY settings
pnpm exec prisma migrate deploy   # applies the committed migrations, never creates new ones
pnpm build
PORT=3210 pm2 start ecosystem.config.js && pm2 save
```

`next start` and `prisma.config.ts` both read `.env`, and secrets stay there, never in `ecosystem.config.js`. `PORT` is set on the `pm2 start` line, because on a shared box the default, 3000, may be taken, and `pm2 save` keeps it for `pm2 resurrect`. `pm2 startup` prints the command that starts pm2 on boot.

The live copy was built on the server with `nice -n 10` and `NODE_OPTIONS=--max-old-space-size=2048`, so the build didn't starve the other apps on its single CPU. It took about 3 minutes.

## Updating

By hand: pull, then `pnpm install --frozen-lockfile`, `pnpm exec prisma migrate deploy`, `pnpm build` and `pm2 restart ping-monitor`. These are the same steps [`deploy.sh`](../deploy.sh) runs, so a push to `main` does them for you.

## Automatic deploys

Every push to `main` that passes CI deploys itself. The reasoning is [decision 57](decisions.md#57-deploy-from-ci-over-ssh-with-a-forced-command).

**Three jobs.** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `checks` (format, migrate, lint, types, tests with coverage, against a Postgres 17 service) and `build` (`pnpm build`, no database) in parallel on every push and pull request. `deploy` needs both, runs only for pushes to `main`, and sits in the `deploy` concurrency group, so two deploys never overlap. It writes the private key and the server's host key from secrets, then runs `ssh -i key user@host <commit sha>`.

**The secrets**, under the repo's Settings → Secrets and variables → Actions → Repository secrets:

- `VPS_SSH_KEY`: the private half of a key made only for this.
- `VPS_KNOWN_HOSTS`: the `ssh-keyscan -t ed25519` line for the server.
- `VPS_HOST`: the server's IP. `VPS_USER`: `root`.

**Two keys, one each way.** The first lets GitHub into the server, but only to run the script. Its line in `authorized_keys` carries `command="/opt/task1/deploy.sh"` plus the no-pty and no-forwarding options, so a holder of the key can run nothing else, and the sha it passes arrives as `SSH_ORIGINAL_COMMAND`. The second lets the server read the repo: `/opt/task1` is a clone of `git@github.com:haseebuchiha/InTask1.git` that pulls over a read-only GitHub deploy key ("VPS pull (read-only)" under Settings → Deploy keys), stored at `/root/.ssh/intask1_deploy` and reached through the ssh config alias `github.com-intask1`. `.env`, `node_modules` and `.next` are untracked, so resets leave them alone.

**What `deploy.sh` does.** It fetches `origin main`, runs `git reset --hard` to the sha, `pnpm install --frozen-lockfile --prefer-offline` and `prisma migrate deploy`, then builds into `.next-build` with `NEXT_DIST_DIR=.next-build`, at `nice -n 10` and a 2 GB heap. The live site keeps serving the old `.next` during the 3-minute build on the 1-CPU box. Then `rm -rf .next && mv .next-build .next`, which takes milliseconds, and `pm2 restart ping-monitor`. `next.config.ts` reads `NEXT_DIST_DIR` for `distDir`, and `next start` reads the default, so it serves `.next`.

**Rollback.** Push a revert to `main`. Or on the server, `git reset --hard <sha>` and the rest of `deploy.sh` by hand.

## How the pieces are set up

- **Postgres: a role and database per app.** `create role task1 login password '…'` and `create database task1 owner task1`. The app connects as that role over `127.0.0.1`, which `pg_hba.conf` already allows with `scram-sha-256`. Nothing is exposed to the network.
- **The model: the same `openai-oauth` proxy as development.** It runs on the VPS as a systemd service on `127.0.0.1:10531`, so `.env` keeps the default `LLM_BASE_URL` and no AI Gateway key is set ([decision 55](decisions.md#55-the-ai-gateway-when-its-key-is-set-the-proxy-otherwise)).
- **Next binds loopback.** `ecosystem.config.js` runs `next start --hostname 127.0.0.1`. Without the flag Next listens on every interface, and the box has no firewall, so the app was reachable on its port around nginx until this was set.
- **nginx: one site file**, `/etc/nginx/sites-available/ping-monitor.applyfast.tech`, proxying to `127.0.0.1:3210` with `proxy_buffering off`, `proxy_cache off`, `proxy_http_version 1.1` and an empty `Connection` header. certbot (`certbot --nginx -d ping-monitor.applyfast.tech --redirect`) added the certificate, the 443 server and the HTTP-to-HTTPS redirect, and renews it on its own timer.
- **pm2: fork mode, exactly one instance.** [`ecosystem.config.js`](../ecosystem.config.js) runs plain `next start`, with no custom server. On a restart the app clears its timers, closes every stream, turns new ones away with a 503, and exits, 22 to 50 ms after the signal in testing ([decision 26](decisions.md#26-on-shutdown-stop-the-timer-and-close-every-stream)). Open tabs show Reconnecting…, then go Live. `kill_timeout`, 10 seconds, is only a safety net. Read the logs with `pm2 logs ping-monitor`.
- **nginx: `proxy_buffering off` for the whole site, not only the stream.** A buffered stream delivers events late and in batches, and pages and chat answers stream too. The stream and chat routes also send `X-Accel-Buffering: no`.
- **nginx: HTTP/2.** Over HTTP/1.1 a browser allows only 6 connections to one site, and each open dashboard tab holds one. The box runs nginx 1.24, where HTTP/2 is `listen 443 ssl http2;` on the server block (`http2 on` needs 1.25.1 or newer). On 1.24 the flag applies to the whole 443 socket, so every site on the box now speaks HTTP/2 to browsers. nginx still talks HTTP/1.1 to each app, so none of them changed.
