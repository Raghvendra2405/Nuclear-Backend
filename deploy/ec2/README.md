# Deploy Nuclear Backend on Amazon EC2

This setup runs the backend and Caddy on one Ubuntu 24.04 LTS EC2 instance.
Caddy serves HTTPS on a domain or HTTP on a public IP. Docker keeps the backend
and its token provider on private ports. The stack supports Linux x86-64 and
ARM64.

## Prepare the instance

1. Set up an EC2 instance in a public subnet with internet access. For a stable
   IPv4 endpoint, associate an Elastic IP. For a domain, point its `A` record
   to that address. Public IPv4 addresses incur AWS charges.
   [EC2 Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)
2. Allow inbound TCP `80` and `443` for HTTPS or TCP `4000` for IP-based HTTP.
   Use Systems Manager Session Manager with an attached instance role and the
   SSM Agent for admin access. If using SSH, restrict port `22` to your admin
   IP. Require IMDSv2 and use a metadata hop limit of `1` for this stack, since
   the containers do not use instance metadata. [EC2 security groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html) · [Session Manager setup](https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-startup-security-baseline/wkld-06.html) · [EC2 metadata options](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html)
3. Install Docker Engine with the Buildx and Compose plugins on the instance.
   [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

## Start the verified release

Check out the commit that passed GitHub Actions on the instance. From the root
of that checkout, build and tag the image using its commit SHA.

```bash
release=$(git rev-parse HEAD)
sudo docker build --tag "nuclear-backend:$release" .
cp -n deploy/ec2/.env.example deploy/ec2/.env
```

Set `NUCLEAR_RELEASE` in `deploy/ec2/.env` to that commit SHA.

Optional settings such as `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
`LASTFM_API_KEY`, and `YTDLP_COOKIES_B64` go in `deploy/ec2/.env.secrets`.
Create that file on the host with mode `0600`. Use an approved secret source
for its values.

### Serve HTTPS on a domain

Set `NUCLEAR_HOSTNAME` in `deploy/ec2/.env` to the public DNS hostname without
`https://` or a path. Use a staging hostname for verification if the production
hostname already serves the mobile app. Caddy obtains and renews the certificate
using public DNS and ports `80` and `443`.
[Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

```bash
sudo docker compose --env-file deploy/ec2/.env -f deploy/ec2/compose.yml config --quiet
sudo docker compose --env-file deploy/ec2/.env -f deploy/ec2/compose.yml up --detach --wait --wait-timeout 75
```

### Serve HTTP by public IP

Set `NUCLEAR_HOSTNAME=http://` in `deploy/ec2/.env` and retain the built image
tag in `NUCLEAR_RELEASE`. Use Docker Compose 2.24.4 or newer to apply the
override that publishes Caddy on TCP `4000`.
[Compose override syntax](https://docs.docker.com/reference/compose-file/merge/#replace-value)

```bash
sudo docker compose --env-file deploy/ec2/.env -f deploy/ec2/compose.yml \
  -f deploy/ec2/compose.ip.yml up --detach --wait --wait-timeout 75
```

Use `http://PUBLIC_IPV4:4000` as the base URL and check `/ready` from another
network. This endpoint uses plain HTTP. Use both Compose files for status,
logs, and updates in this mode.

## Verify before cutover

Run these from a workstation with Node 22.12 or newer. Set `BACKEND_URL` to
the deployed base URL and choose a representative public track.

```bash
curl --fail "$BACKEND_URL/ready"
node deploy/smoke-test.mjs "$BACKEND_URL" "$PLAYBACK_VIDEO_URL" "$TRACK_TITLE" "$TRACK_ARTIST"
```

The smoke test checks metadata, direct and title-based resolution, and HTTP
byte ranges. In the mobile app over a separate network, verify search, first
playback, repeat playback, and seeking.
YouTube can treat EC2 IPs differently. Verify live playback before updating
the app's `EXPO_PUBLIC_BACKEND_URL` or switching DNS.

## Operate and roll back

- Monitor the public `/ready` endpoint and watch backend logs for `429`, `502`,
  `503`, and high latency. View service status and logs on EC2 with the same
  Compose arguments followed by `ps` or `logs --tail 100`.
- Rate limits apply per client IP per minute. The default is 240 requests,
  with route limits of 30 for `/resolve-stream` and 120 for `/stream`. The
  backend trusts one proxy hop for the client address forwarded by Caddy.
- Keep the previous verified backend image. To roll back, set `NUCLEAR_RELEASE`
  to its tag, run the Compose `up` command again, and repeat the smoke test.
  Keep the Compose volumes so Caddy can reuse its certificate and renewal state.
- This stack runs on one instance. Instance restarts and backend replacement can
  interrupt traffic. Keep the previous backend URL available during the rollout.
