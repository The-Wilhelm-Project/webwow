import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';
import CustomCodeInjector from '@/components/CustomCodeInjector';

/** Preview layout — injects global custom body code. Head code is handled by root layout. */
export default async function PreviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const settings = await getSettingsByKeys(['custom_code_body']);
  const globalCustomCodeBody = settings.custom_code_body as string | null;

  return (
    <>
      {children}
      {globalCustomCodeBody && (
        <CustomCodeInjector html={globalCustomCodeBody} />
      )}
    </>
  );
}
