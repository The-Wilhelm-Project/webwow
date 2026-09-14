import type { Knex } from 'knex';

/**
 * Migration: Create Storage Bucket
 *
 * Creates Supabase storage bucket for assets with policies
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('assets', 'assets', true, 52428800, NULL)
    ON CONFLICT (id) DO NOTHING
  `);

  // Drop existing policies if they exist (includes legacy open policy names)
  await knex.schema.raw('DROP POLICY IF EXISTS "Assets are publicly accessible" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can upload assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can update assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can delete assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can upload assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can update assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can delete assets" ON storage.objects');

  // Public read access for serving assets on published pages
  await knex.schema.raw(`
    CREATE POLICY "Assets are publicly accessible"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'assets')
  `);

  // Write operations restricted to authenticated users
  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can upload assets"
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'assets' AND (SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can update assets"
      ON storage.objects FOR UPDATE
      USING (bucket_id = 'assets' AND (SELECT auth.uid()) IS NOT NULL)
      WITH CHECK (bucket_id = 'assets' AND (SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can delete assets"
      ON storage.objects FOR DELETE
      USING (bucket_id = 'assets' AND (SELECT auth.uid()) IS NOT NULL)
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Drop policies (both legacy and current names)
  await knex.schema.raw('DROP POLICY IF EXISTS "Assets are publicly accessible" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can upload assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can update assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Anyone can delete assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can upload assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can update assets" ON storage.objects');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can delete assets" ON storage.objects');

  // Delete bucket (this will fail if there are files in it)
  await knex.schema.raw("DELETE FROM storage.buckets WHERE id = 'assets'");
}
