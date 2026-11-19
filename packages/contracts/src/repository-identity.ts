import { z } from 'zod';

export const repositoryPath = z.string().min(1).max(4096);
const hostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const segment = /^[a-zA-Z0-9_.~-]{1,128}$/;

export const repositorySegment = (value: string) =>
  value !== '.' && value !== '..' && segment.test(value);

export const repositoryHost = (value: string) => {
  const [host, port, extra] = value.split(':');
  return (
    !!host &&
    hostname.test(host) &&
    extra === undefined &&
    (port === undefined ||
      (/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535))
  );
};

const repositoryAddress = (value: string, pattern: boolean) => {
  const [host, ...path] = value.split('/');
  return (
    repositoryHost(host!) &&
    path.length >= 1 &&
    path.length <= 12 &&
    path.every(part => (pattern && part === '*') || repositorySegment(part))
  );
};

export const repositoryRemoteSchema = z
  .string()
  .max(1024)
  .refine(value => repositoryAddress(value, false));
export const repositoryPatternSchema = z
  .string()
  .max(1024)
  .refine(value => repositoryAddress(value, true));

const checkoutIdentity = {
  root: repositoryPath,
  gitDirectory: repositoryPath,
  checkouts: z.array(repositoryPath).min(1).max(256),
};

export const repositoryIdentitySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('remote'),
    ...checkoutIdentity,
    remote: repositoryRemoteSchema,
  }),
  z.strictObject({ status: z.literal('local'), ...checkoutIdentity }),
  z.strictObject({ status: z.literal('ambiguous'), ...checkoutIdentity }),
  z.strictObject({ status: z.literal('unverified'), root: repositoryPath }),
]);

export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;
