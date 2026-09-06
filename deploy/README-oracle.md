# Deploy the Nuclear backend on Oracle Cloud (Always Free)

Goal: an **always-on, free, fast** HTTPS backend that does stream resolution, so
the app plays music 24/7 without your PC. Metadata already runs on-device, so this
box only runs **yt-dlp + your YouTube cookies**.

Result: a stable URL like `https://yourname.duckdns.org` that we bake into the app.

---

## 1. Create the VM (Oracle console)

1. Sign in to https://cloud.oracle.com → **Compute → Instances → Create instance**.
2. **Image & shape → Change shape → Ampere** → `VM.Standard.A1.Flex`.
   Set **2 OCPU / 12 GB** (well within Always Free: 4 OCPU / 24 GB total).
   *(If it says "out of capacity", pick another Availability Domain or region, or
   try again later — Ampere free capacity comes and goes.)*
3. **Image:** Canonical **Ubuntu 22.04**.
4. **Networking:** keep the default VCN + "Assign a public IPv4 address" = Yes.
5. **SSH keys:** Download the private key (or paste your own public key). Keep it.
6. Create. When it's **Running**, note the **Public IP address**.

> Recommended: **Reserve the public IP** so it never changes —
> Instance → Attached VNICs → the VNIC → IPv4 → edit the public IP → "Reserved".
> (Free.) DuckDNS also tracks IP changes, so this is optional.

## 2. Open ports 80 + 443 (Oracle firewall)

Instance page → **Virtual Cloud Network** → **Security Lists** → the default list →
**Add Ingress Rules** (twice):

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(The setup script opens the VM's own iptables for these; this step opens Oracle's
cloud firewall.)

## 3. Get a free HTTPS domain (DuckDNS)

1. Go to https://www.duckdns.org → sign in (Google/GitHub).
2. Create a subdomain, e.g. **`nuclearmusic`** → you get `nuclearmusic.duckdns.org`.
3. Copy your **token** (shown at the top of the page).
   *(You can set the IP to your VM's public IP now, or let the script do it.)*

## 4. Run the setup script

SSH into the VM (from your PC):

```bash
ssh -i <your-key> ubuntu@<VM_PUBLIC_IP>
```

Then:

```bash
git clone https://github.com/Raghvendra2405/Nuclear-Backend.git
sudo bash Nuclear-Backend/deploy/oracle-setup.sh <subdomain> <duckdns-token>
# e.g. sudo bash Nuclear-Backend/deploy/oracle-setup.sh nuclearmusic 8f3c1a...token
```

This installs Node + yt-dlp (ARM), builds the backend, runs it as a service,
points DuckDNS at the VM, and gets an HTTPS cert via Caddy. Takes ~3–5 min.

## 5. Add your YouTube cookies

The resolver needs them (datacenter IP). Paste the same `cookies.txt` we made:

```bash
sudo nano /opt/nuclear-backend/cookies.txt      # paste the full cookies.txt, save
sudo systemctl restart nuclear-backend
```

*(Or `scp` it up: `scp -i <key> cookies.txt ubuntu@<IP>:/tmp/ && sudo mv /tmp/cookies.txt /opt/nuclear-backend/`)*

## 6. Verify

```bash
curl https://<subdomain>.duckdns.org/health
curl "https://<subdomain>.duckdns.org/resolve-stream?title=Believer&artist=Imagine%20Dragons&duration=204"
```

`/health` → `{"ok":true,...}`; `/resolve-stream` → a JSON with a `stream.url`.
Logs if needed: `journalctl -u nuclear-backend -f`

## 7. Tell me the URL

Give me `https://<subdomain>.duckdns.org` and I'll bake it into the app
(`EXPO_PUBLIC_BACKEND_URL`) and rebuild the APK. Then the app plays 24/7, no PC.

---

## Maintenance
- **yt-dlp auto-updates weekly** (cron) so YouTube player changes don't rot it.
- **Cookies** expire eventually — if playback starts failing, re-export the burner's
  cookies and repeat step 5. (Metadata/browse keep working regardless.)
- Update the backend later: `cd /opt/nuclear-backend && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart nuclear-backend`.
