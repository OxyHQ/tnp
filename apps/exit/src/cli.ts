/**
 * Host-setup helper for `deploy/bootstrap.sh`, run once as root at boot.
 *
 *   bun apps/exit/src/cli.ts nftables --uplink ens5 --operator-cidr 10.0.0.0/16 \
 *     [--operator-cidr …] [--uplink-address 172.26.5.10/20,…] [--wg wg0] \
 *     [--dns 198.51.100.53,…] [--local-dns 10.77.0.1] [--admin-ssh 198.51.100.7/32,…]
 *     [--port 51820]
 *
 * At least one `--operator-cidr` (EC2: the VPC) or `--uplink-address`
 * (Lightsail: the instance's own address and prefix) is required.
 *
 * Prints the ruleset (`nftables.ts`) to stdout; exits non-zero, printing
 * nothing to stdout, on any invalid argument, so the bootstrap's
 * `nft -c` / load step never sees a partial file.
 */

import { FirewallConfigError, renderExitRuleset } from './nftables.js';

export function parseNftablesArgs(argv: readonly string[]) {
  const options = {
    wgInterface: 'wg0',
    uplinkInterface: '',
    listenPort: 51820,
    operatorCidrs: [] as string[],
    uplinkAddresses: [] as string[],
    dnsServers: [] as string[],
    localDnsAddress: undefined as string | undefined,
    adminSshCidrs: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new FirewallConfigError(`${flag} needs a value`);
    i++;
    switch (flag) {
      case '--wg':
        options.wgInterface = value;
        break;
      case '--uplink':
        options.uplinkInterface = value;
        break;
      case '--port':
        options.listenPort = Number(value);
        break;
      case '--operator-cidr':
        options.operatorCidrs.push(...value.split(',').filter(Boolean));
        break;
      case '--uplink-address':
        options.uplinkAddresses.push(...value.split(',').filter(Boolean));
        break;
      case '--dns':
        options.dnsServers.push(...value.split(',').filter(Boolean));
        break;
      case '--admin-ssh':
        options.adminSshCidrs.push(...value.split(',').filter(Boolean));
        break;
      case '--local-dns':
        options.localDnsAddress = value;
        break;
      default:
        throw new FirewallConfigError(`unknown option ${flag}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command !== 'nftables')
      throw new FirewallConfigError(
        'usage: cli.ts nftables --uplink <iface> (--operator-cidr <cidr> | --uplink-address <addr/len>) …',
      );
    process.stdout.write(renderExitRuleset(parseNftablesArgs(rest)));
  } catch (err) {
    console.error(`[tnp-exit] ${err instanceof FirewallConfigError ? err.message : String(err)}`);
    process.exit(2);
  }
}
