import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { config } from './config.js';

/** Live registered role identity, including temporary development/SSO roles. */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
export const oxy = new OxyServer({ baseURL: config.oxyApiUrl, workloadCredentials });
