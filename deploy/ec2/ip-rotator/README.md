# IP rotation (Lambda + EventBridge + DuckDNS)

Rotates the backend's Elastic IP every 10 minutes so no single address
accumulates enough request history to look like sustained abuse to YouTube's
CDN, while the mobile app keeps calling one stable hostname forever (never
needs rebuilding when the IP changes).

## 1. Get a free DuckDNS hostname

1. Go to [duckdns.org](https://www.duckdns.org) and sign in (GitHub/Google/etc.).
2. Create a subdomain, e.g. `nuclearplayer` → gives you `nuclearplayer.duckdns.org`.
3. Copy your **token** shown on that page — treat it like a password.
4. Point it at your current IP once, manually, to start: enter your current
   Elastic IP in the box next to your subdomain and save.

## 2. Create the IAM role for the Lambda

1. IAM Console → **Roles** → **Create role**.
2. Trusted entity: **AWS service** → Use case: **Lambda** → Next.
3. Skip attaching a managed policy for now → name it `ip-rotator-lambda-role` → **Create role**.
4. Open the role → **Add permissions → Create inline policy** → JSON tab → paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "ec2:AllocateAddress",
           "ec2:AssociateAddress",
           "ec2:DescribeAddresses",
           "ec2:DisassociateAddress",
           "ec2:ReleaseAddress",
           "ec2:DescribeInstances"
         ],
         "Resource": "*"
       }
     ]
   }
   ```
5. Name it `ip-rotator-ec2-permissions` → **Create policy**.

## 3. Create the Lambda function

1. Lambda Console → **Create function** → **Author from scratch**.
2. Name: `nuclear-backend-ip-rotator`. Runtime: **Node.js 22.x**.
3. Execution role: **Use an existing role** → `ip-rotator-lambda-role`.
4. Create it, then open the function → **Code** tab → replace the default
   `index.mjs` with the contents of this folder's `index.mjs`.
5. **Configuration → Environment variables** → add:
   - `INSTANCE_ID` = your instance id (EC2 Console → Instances → copy the `i-...` id)
   - `DUCKDNS_DOMAIN` = the subdomain only, e.g. `nuclearplayer`
   - `DUCKDNS_TOKEN` = your DuckDNS token from step 1
6. **Configuration → General configuration** → set **Timeout** to 30 seconds
   (default 3s is too short for several EC2 API calls in sequence).
7. **Deploy**.
8. Test it once manually: **Test** tab → create a test event (any input, the
   handler ignores it) → **Test**. Confirm it succeeds and check the EC2
   Console that a new Elastic IP is now associated with your instance.

## 4. Schedule it every 10 minutes

1. Amazon EventBridge Console → **Scheduler → Create schedule**.
2. Name: `nuclear-backend-ip-rotation`.
3. Schedule pattern: **Recurring schedule** → rate: **10 minutes**.
4. Target: **AWS Lambda → Invoke** → select `nuclear-backend-ip-rotator`.
5. Flexible time window: **Off** (keep it precise).
6. Create. It will now fire every 10 minutes indefinitely.

## 5. Point the mobile app at the stable hostname

In `packages/mobile/.env`, change:
```
EXPO_PUBLIC_BACKEND_URL=http://nuclearplayer.duckdns.org:4000
```
(replace `nuclearplayer` with your actual DuckDNS subdomain), then rebuild
the app once. It never needs to change again regardless of how often the
underlying IP rotates.

## Notes

- The Lambda allocates and associates the **new** IP before releasing the
  old one, so the instance is never without a public address, even for the
  moment in between.
- DNS propagation after each rotation typically takes 10-60 seconds on most
  resolvers — a small, expected gap, not a bug, which is why 10 minutes
  (not something much shorter) was chosen as the interval.
- Check **CloudWatch Logs** for this Lambda's log group if a rotation ever
  fails (e.g. DuckDNS unreachable) — it logs the old/new IP on every
  successful run.
