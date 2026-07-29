#!/usr/bin/env node
const context = process.argv[2];
const role = process.env.IRONSIGHT_NETLIFY_ROLE;
if (context !== 'deploy-preview' || !['staging', 'production'].includes(role)) process.exit(0);
process.exit(role === 'production' ? 0 : 1);
