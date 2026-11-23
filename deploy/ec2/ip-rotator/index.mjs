// Lambda: rotates the backend EC2 instance's Elastic IP on a schedule (see
// README.md in this folder) and points a free DuckDNS hostname at the new
// address, so the mobile app can call a stable hostname forever while the
// underlying IP changes — this keeps any single IP from accumulating enough
// request history to look like sustained abuse to YouTube's CDN, without
// ever needing to rebuild/redeploy the app when the IP changes.
//
// Required environment variables (set on the Lambda, not committed here):
//   INSTANCE_ID     - the EC2 instance id, e.g. i-0123456789abcdef0
//   AWS_REGION      - set automatically by Lambda, used as-is
//   DUCKDNS_DOMAIN  - the subdomain only, e.g. "nuclearplayer" for
//                     nuclearplayer.duckdns.org
//   DUCKDNS_TOKEN   - your DuckDNS account token (treat as a secret)
//
// Required IAM permissions on the Lambda's execution role:
//   ec2:AllocateAddress, ec2:AssociateAddress, ec2:DescribeAddresses,
//   ec2:DisassociateAddress, ec2:ReleaseAddress, ec2:DescribeInstances

import {
  EC2Client,
  AllocateAddressCommand,
  AssociateAddressCommand,
  DescribeAddressesCommand,
  DisassociateAddressCommand,
  ReleaseAddressCommand,
} from '@aws-sdk/client-ec2';

const ec2 = new EC2Client({});

async function updateDuckDns(ip) {
  const url = `https://www.duckdns.org/update?domains=${process.env.DUCKDNS_DOMAIN}&token=${process.env.DUCKDNS_TOKEN}&ip=${ip}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok || !body.startsWith('OK')) {
    throw new Error(`DuckDNS update failed: ${res.status} ${body}`);
  }
}

export const handler = async () => {
  const instanceId = process.env.INSTANCE_ID;

  // Find any Elastic IP currently associated with this instance, if any.
  const existing = await ec2.send(
    new DescribeAddressesCommand({
      Filters: [{ Name: 'instance-id', Values: [instanceId] }],
    }),
  );
  const previous = existing.Addresses?.[0];

  // Allocate and associate a fresh one first, so the instance is never
  // without a public IP even for the moment in between.
  const allocated = await ec2.send(new AllocateAddressCommand({ Domain: 'vpc' }));
  await ec2.send(
    new AssociateAddressCommand({
      AllocationId: allocated.AllocationId,
      InstanceId: instanceId,
      AllowReassociation: true,
    }),
  );

  await updateDuckDns(allocated.PublicIp);

  // Now release the old one, if there was one.
  if (previous?.AssociationId) {
    await ec2.send(new DisassociateAddressCommand({ AssociationId: previous.AssociationId }));
  }
  if (previous?.AllocationId) {
    await ec2.send(new ReleaseAddressCommand({ AllocationId: previous.AllocationId }));
  }

  console.log(`Rotated to ${allocated.PublicIp} (was ${previous?.PublicIp ?? 'none'})`);
  return { newIp: allocated.PublicIp, previousIp: previous?.PublicIp ?? null };
};
