import Papr from '@papr/memory';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf8');
const apiKey = envContent.match(/^PAPR_API_KEY=(.+)$/m)?.[1];
console.log('Key:', apiKey?.substring(0, 15) + '...');

const client = new Papr({ xAPIKey: apiKey });

// List schemas
const schemas = await client.schemas.list();
console.log('Found schemas:', JSON.stringify(schemas?.data || schemas, null, 2).substring(0, 500));

