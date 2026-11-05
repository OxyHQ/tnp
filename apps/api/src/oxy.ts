import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { config } from './config.js';

/** Live registered role identity, including temporary development/SSO roles. */
export const workloadCredentials = createAwsWorkloadCredentialProvider();

/**
 * The API's one Oxy client. Session-less reads go out with the workload's own
 * service token (`serviceIdentity: 'when-anonymous'`) instead of anonymously,
 * so they are not charged to the shared NAT address's anonymous budget.
 */
export const oxy = new OxyServer({
  baseURL: config.oxyApiUrl,
  workloadCredentials,
  serviceIdentity: 'when-anonymous',
});
