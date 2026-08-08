/**
 * Create (or re-confirm) an admin user in Supabase Auth.
 *
 *   npx tsx src/scripts/createAdminUser.ts admin@example.com 'a-strong-password'
 *
 * Uses the service role key already in `backend/.env`, so it needs no extra
 * configuration and never asks for the password over the network in plain form.
 *
 * The user is created ALREADY CONFIRMED. Supabase otherwise emails a
 * confirmation link, and until it is clicked the account exists but cannot sign
 * in — which looks exactly like a wrong password.
 *
 * Creating the user does NOT make them an admin. `ADMIN_EMAILS` in the
 * backend's environment decides that, and the script prints the line to add.
 */

import 'dotenv/config';
import { readSupabaseConfig } from '../db/supabase.js';

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error(
    'Usage: npx tsx src/scripts/createAdminUser.ts <email> <password>\n' +
      '\nQuote the password if it contains shell characters.',
  );
  process.exit(1);
}

if (password.length < 8) {
  // Supabase enforces its own minimum; failing here gives a clearer message
  // than the API's.
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const config = readSupabaseConfig();
const base = config.url.replace(/\/+$/, '');

const response = await fetch(`${base}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
  },
  body: JSON.stringify({
    email,
    password,
    // Skip the confirmation email — this is an internal tool and the operator
    // running this script is already trusted with the service role key.
    email_confirm: true,
  }),
});

const body = (await response.json()) as {
  id?: string;
  email?: string;
  msg?: string;
  message?: string;
  error_description?: string;
};

if (!response.ok) {
  const reason = body.msg ?? body.message ?? body.error_description ?? response.statusText;
  console.error(`Could not create the user (${response.status}): ${reason}`);
  if (response.status === 422) {
    console.error('A user with that email probably already exists — sign in with it.');
  }
  process.exit(1);
}

console.log(`Created ${body.email ?? email}`);
console.log(`  id: ${body.id}`);
console.log('');
console.log('Now add this to backend/.env and restart the backend:');
console.log('');
console.log(`  ADMIN_EMAILS=${email}`);
console.log('');
console.log('Then sign in at the admin dashboard (npm run dev in webapp/admin).');
