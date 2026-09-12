/**
 * Webwow user management CLI (no e-mail invites in Webwow — create accounts here).
 *
 *   npm run webwow:user -- list
 *   npm run webwow:user -- create <email> <password> [owner|admin|designer|editor]
 *   npm run webwow:user -- passwd <email> <new-password>
 *   npm run webwow:user -- role <email> <owner|admin|designer|editor>
 *   npm run webwow:user -- delete <email>
 *
 * Reads DATABASE_URL from the environment (.env is loaded by the npm script).
 */

import knex from 'knex';
import { randomUUID } from 'crypto';
import { hashPassword } from '../lib/webwow/password';

const ROLES = ['owner', 'admin', 'designer', 'editor'];

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const db = knex({ client: 'pg', connection: databaseUrl, pool: { min: 0, max: 1 } });
  const users = () => db('auth.users');
  const now = () => new Date().toISOString();

  try {
    switch (command) {
      case 'list': {
        const rows = await users().select('id', 'email', 'raw_app_meta_data', 'created_at', 'last_sign_in_at').orderBy('created_at', 'asc');
        if (rows.length === 0) {
          console.log('No users yet.');
        }
        for (const row of rows) {
          const role = (row.raw_app_meta_data as { role?: string } | null)?.role ?? 'designer';
          console.log(`${row.email}\t${role}\t${row.id}\tlast sign-in: ${row.last_sign_in_at ?? 'never'}`);
        }
        break;
      }
      case 'create': {
        const [email, password, roleArg] = args;
        if (!email || !password) throw new Error('usage: create <email> <password> [role]');
        const role = roleArg ?? 'designer';
        if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
        if (password.length < 6) throw new Error('password must be at least 6 characters');
        const existing = await users().whereRaw('lower(email) = ?', [email.toLowerCase()]).first();
        if (existing) throw new Error(`user ${email} already exists`);
        const timestamp = now();
        await users().insert({
          id: randomUUID(),
          email: email.toLowerCase(),
          encrypted_password: hashPassword(password),
          raw_app_meta_data: JSON.stringify({ provider: 'email', providers: ['email'], role }),
          raw_user_meta_data: JSON.stringify({}),
          email_confirmed_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        });
        console.log(`Created ${email} (${role})`);
        break;
      }
      case 'passwd': {
        const [email, password] = args;
        if (!email || !password) throw new Error('usage: passwd <email> <new-password>');
        if (password.length < 6) throw new Error('password must be at least 6 characters');
        const count = await users().whereRaw('lower(email) = ?', [email.toLowerCase()]).update({ encrypted_password: hashPassword(password), updated_at: now() });
        if (!count) throw new Error(`user ${email} not found`);
        console.log(`Password updated for ${email}`);
        break;
      }
      case 'role': {
        const [email, role] = args;
        if (!email || !role) throw new Error('usage: role <email> <role>');
        if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
        const count = await users()
          .whereRaw('lower(email) = ?', [email.toLowerCase()])
          .update({ raw_app_meta_data: db.raw(`coalesce(raw_app_meta_data, '{}'::jsonb) || ?::jsonb`, [JSON.stringify({ role })]), updated_at: now() });
        if (!count) throw new Error(`user ${email} not found`);
        console.log(`Role of ${email} set to ${role}`);
        break;
      }
      case 'delete': {
        const [email] = args;
        if (!email) throw new Error('usage: delete <email>');
        const count = await users().whereRaw('lower(email) = ?', [email.toLowerCase()]).delete();
        if (!count) throw new Error(`user ${email} not found`);
        console.log(`Deleted ${email}`);
        break;
      }
      default:
        console.log('usage: webwow-user <list|create|passwd|role|delete> ...');
        process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
