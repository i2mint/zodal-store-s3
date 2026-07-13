import { defineConfig } from 'tsup';

export default defineConfig({
  // `presigned` is a separate entry so it stays behind the `./presigned` subpath
  // export — importing it pulls in the optional @aws-sdk/s3-request-presigner peer,
  // which users who never presign should not have to install.
  entry: ['src/index.ts', 'src/presigned.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
