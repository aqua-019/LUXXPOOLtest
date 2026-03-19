# LUXXPOOL v0.6.0 — Production Deployment Guide

## Server Requirements

- Ubuntu 22.04 or 24.04 LTS
- 4+ CPU cores, 16 GB RAM, 100 GB SSD
- Static IP address
- Domain: luxxpool.io → A record pointing to server IP

## 1. Server Prep

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential nginx certbot python3-certbot-nginx

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Docker (if using containerized deployment)
curl -fsSL https://get.docker.com | sh
sudo apt install -y docker-compose-plugin
```

## 2. SSL Certificate (Let's Encrypt)

```bash
# Stop nginx temporarily
sudo systemctl stop nginx

# Get certificate
sudo certbot certonly --standalone -d luxxpool.io -d www.luxxpool.io

# Verify
sudo ls /etc/letsencrypt/live/luxxpool.io/
# Should show: fullchain.pem  privkey.pem  chain.pem  cert.pem

# Auto-renewal (certbot installs a systemd timer by default)
sudo certbot renew --dry-run
```

The certificate is used in two places:
- **Nginx** (HTTPS for API on port 443)
- **Stratum SSL** (TLS for mining on port 3334)

Both read from `/etc/letsencrypt/live/luxxpool.io/`.

## 3. Litecoin Core Setup

```bash
# Download and install
wget https://download.litecoin.org/litecoin-0.21.3/linux/litecoin-0.21.3-x86_64-linux-gnu.tar.gz
tar xzf litecoin-*.tar.gz
sudo cp litecoin-*/bin/* /usr/local/bin/

# Create config
mkdir -p ~/.litecoin
cat > ~/.litecoin/litecoin.conf << EOF
server=1
txindex=1
rpcuser=luxxpool_rpc
rpcpassword=YOUR_STRONG_PASSWORD_HERE
rpcallowip=127.0.0.1
rpcport=9332
zmqpubhashblock=tcp://127.0.0.1:28332
maxconnections=64
dbcache=1024
EOF

# Start and sync (takes 12-48 hours)
litecoind -daemon

# Check sync progress
litecoin-cli getblockchaininfo | grep -E "blocks|headers"
```

## 4. PostgreSQL + Redis

```bash
# PostgreSQL
sudo apt install -y postgresql-16
sudo -u postgres createuser -P luxxpool  # enter password
sudo -u postgres createdb -O luxxpool luxxpool

# Redis
sudo apt install -y redis-server
sudo systemctl enable redis-server
```

## 5. Pool Installation

```bash
git clone https://github.com/aqua-019/luxxpool.git
cd luxxpool
npm install

# Configure
cp .env.example .env
nano .env  # Fill in ALL passwords and addresses

# Run migrations
npm run migrate

# Test
node tests/emulation.js  # Should pass 62/62
```

## 6. Nginx Setup

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/luxxpool
sudo ln -s /etc/nginx/sites-available/luxxpool /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

## 7. Firewall

```bash
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP (redirects to HTTPS)
sudo ufw allow 443/tcp     # HTTPS (API)
sudo ufw allow 3333/tcp    # Stratum
sudo ufw allow 3334/tcp    # Stratum SSL
sudo ufw allow 3336/tcp    # Solo mining
sudo ufw enable
```

## 8. Start the Pool

### Option A: Systemd (recommended for bare metal)

```bash
sudo cat > /etc/systemd/system/luxxpool.service << EOF
[Unit]
Description=LUXXPOOL Mining Pool
After=network.target postgresql.service redis.service
Requires=postgresql.service redis.service

[Service]
Type=simple
User=luxxpool
WorkingDirectory=/home/luxxpool/luxxpool
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable luxxpool
sudo systemctl start luxxpool
sudo journalctl -u luxxpool -f
```

### Option B: Docker (containerized)

```bash
cd luxxpool
docker compose -f docker/docker-compose.prod.yml up -d
docker compose -f docker/docker-compose.prod.yml logs -f luxxpool
```

## 9. Verify

```bash
# Health check
curl http://localhost:8080/health

# Pool stats
curl http://localhost:8080/api/v1/pool/stats

# Fleet status
curl http://localhost:8080/api/v1/fleet/overview

# Test stratum connection
echo '{"id":1,"method":"mining.subscribe","params":["test/1.0"]}' | nc localhost 3333
```

## 10. Post-Launch Checklist

- [ ] Litecoin daemon fully synced
- [ ] PostgreSQL migrations run successfully
- [ ] Redis responding to PING
- [ ] Stratum port 3333 accepting connections
- [ ] SSL port 3334 accepting TLS connections
- [ ] API port 8080 returning health OK
- [ ] Nginx proxying API on port 443
- [ ] SSL certificate valid (check with browser)
- [ ] Fleet IPs configured in .env
- [ ] Pool fee address set
- [ ] At least one L9 connected and submitting shares
- [ ] Dashboard deployed and showing live data
- [ ] UFW firewall enabled with correct rules
- [ ] Systemd service enabled for auto-restart
- [ ] Let's Encrypt auto-renewal working
