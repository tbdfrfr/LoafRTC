# LoafRTC Manual Deployment (DigitalOcean Backend + Optional GitHub Pages Frontend)

This guide deploys LoafRTC manually on a fresh Ubuntu 22.04 droplet.

## 1. Provision droplet

1. Create Ubuntu 22.04 droplet.
2. Open inbound firewall ports in DigitalOcean:
   - `22/tcp` (SSH)
   - `80/tcp` (HTTP)
   - `443/tcp` (HTTPS)
   - `3478/tcp` and `3478/udp` (TURN)
   - `5349/tcp` and `5349/udp` (TURN TLS)
   - `49152-65535/udp` (TURN relay media)
3. Point your domain A record to droplet IP.

## 2. Base system packages

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl ca-certificates gnupg lsb-release software-properties-common
sudo apt install -y nginx certbot python3-certbot-nginx coturn ufw
```

## 3. Install Node.js LTS and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Verify:

```bash
node -v
npm -v
pm2 -v
```

## 4. Clone repository and install dependencies

```bash
cd /opt
sudo git clone https://github.com/tbdfrfr/LoafRTC.git loafrtc
sudo chown -R $USER:$USER /opt/loafrtc
cd /opt/loafrtc

cd server
npm install
cd ../loafhost
npm install
cd /opt/loafrtc
```

## 4.1 Optional: frontend on GitHub Pages

If you want backend on DigitalOcean and viewer frontend on GitHub Pages:

1. In [frontend/index.html](../frontend/index.html), set:

```html
<script>
   window.LOAFRTC_SIGNALING_URL = 'wss://signal.your-domain.com/ws';
</script>
```

2. Publish [frontend/](../frontend/) as static files on GitHub Pages.

3. Keep this droplet deployment for signaling/TURN only.

4. Your final endpoints should look like:
    - Viewer: `https://viewer.your-domain.com` (or `https://<user>.github.io/<repo>/`)
    - Signaling: `https://signal.your-domain.com`
    - WebSocket: `wss://signal.your-domain.com/ws`

## 5. Configure server environment

Create `/opt/loafrtc/server/.env`:

```bash
cat > /opt/loafrtc/server/.env << 'EOF'
TURN_USERNAME=loafuser
TURN_PASSWORD=CHANGE_ME_STRONG_RANDOM_PASSWORD
TURN_DOMAIN=your-domain
PORT=3000
EOF
```

If you do not yet have a domain, temporary IP fallback is allowed:

```env
TURN_DOMAIN=YOUR_DROPLET_PUBLIC_IP
```

## 6. Configure PM2 process

Create logs directory:

```bash
mkdir -p /opt/loafrtc/logs
```

Start and persist:

```bash
cd /opt/loafrtc
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd
```

Follow the printed `pm2 startup` command exactly if prompted.

## 7. Configure Nginx reverse proxy

1. Copy config:

```bash
sudo cp /opt/loafrtc/nginx.conf /etc/nginx/sites-available/loafrtc
sudo ln -sf /etc/nginx/sites-available/loafrtc /etc/nginx/sites-enabled/loafrtc
sudo rm -f /etc/nginx/sites-enabled/default
```

2. Edit placeholders in `/etc/nginx/sites-available/loafrtc`:
   - Replace `your-domain` with your domain.
   - Optionally keep `your-server-ip` in HTTP server_name for fallback.

3. Test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Issue SSL certificate (Let's Encrypt)

```bash
sudo certbot --nginx -d your-domain
```

Optional additional hostname:

```bash
sudo certbot --nginx -d your-domain -d www.your-domain
```

Auto-renew is installed by default. Verify:

```bash
systemctl status certbot.timer
```

## 9. Configure Coturn

1. Ensure coturn daemon is enabled:

```bash
sudo sed -i 's/^#TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

2. Copy template:

```bash
sudo cp /opt/loafrtc/turnserver.conf /etc/turnserver.conf
```

3. Edit `/etc/turnserver.conf` values:
   - `realm=loafrtc` or your domain
   - `server-name` to your domain
   - `user=loafuser:CHANGE_ME_STRONG_PASSWORD` to match `server/.env`
   - TLS cert paths to your valid certbot files

4. Prepare log path and restart:

```bash
sudo mkdir -p /var/log/turnserver
sudo chown turnserver:turnserver /var/log/turnserver
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager
```

## 10. Configure Ubuntu firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
sudo ufw enable
sudo ufw status
```

## 11. Validate deployment

1. HTTP health check:

```bash
curl -i https://your-domain/health
```

Expected: status `200` with JSON `{ "ok": true, ... }`.

2. PM2 logs:

```bash
pm2 logs loafrtc-server --lines 100
```

3. Nginx logs:

```bash
sudo tail -n 100 /var/log/nginx/error.log
```

4. Coturn logs:

```bash
sudo tail -n 100 /var/log/turnserver/turnserver.log
```

## 12. Manual update procedure

Deployment updates are manual by design:

```bash
cd /opt/loafrtc
git pull
cd server
npm install --omit=dev
cd /opt/loafrtc
pm2 restart loafrtc-server
```

If server env changed:

```bash
pm2 restart loafrtc-server --update-env
```

## 13. Rollback

```bash
cd /opt/loafrtc
git log --oneline -n 5
git checkout <previous_commit>
pm2 restart loafrtc-server
```

## 14. Notes

- No SSH deploy workflow is used.
- No GitHub Actions deploy job is used.
- Windows host packaging is handled in CI workflow `.github/workflows/build-windows.yml`.
