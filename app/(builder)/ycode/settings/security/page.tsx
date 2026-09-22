'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
} from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { CodeEditor } from '@/components/ui/code-editor';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn, isCloudVersion } from '@/lib/utils';
import { useSettingsStore } from '@/stores/useSettingsStore';
import {
  REFERRER_POLICY_OPTIONS,
  SECURITY_HEADERS_SETTING_KEY,
  getDefaultSecurityHeadersSettings,
} from '@/lib/security-headers';
import type { SecurityHeadersSettings } from '@/lib/security-headers';

// Radix Select forbids empty-string values, so "off" is a sentinel that maps
// to an empty Referrer-Policy (header omitted).
const REFERRER_POLICY_OFF = 'off';

export default function SecuritySettingsPage() {
  const { getSettingByKey, saveSettings } = useSettingsStore();

  const stored = getSettingByKey(SECURITY_HEADERS_SETTING_KEY) as Partial<SecurityHeadersSettings> | null;
  const [settings, setSettings] = useState<SecurityHeadersSettings>({
    ...getDefaultSecurityHeadersSettings(),
    ...(stored || {}),
  });
  const [isSaving, setIsSaving] = useState(false);

  // Individual header controls are gated on the master toggle.
  const disabled = !settings.enabled;

  // HSTS is a host/TLS concern already handled by the platform on cloud, so the
  // control is only useful for self-hosted installs.
  const showHsts = !isCloudVersion();

  const updateSetting = useCallback(<K extends keyof SecurityHeadersSettings>(
    key: K,
    value: SecurityHeadersSettings[K],
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const success = await saveSettings({
        [SECURITY_HEADERS_SETTING_KEY]: settings,
      });

      if (!success) {
        toast.error(useSettingsStore.getState().error || 'Settings could not be saved. Please try again.');
        return;
      }

      toast.success('Security headers have been successfully saved');
    } finally {
      setIsSaving(false);
    }
  }, [saveSettings, settings]);

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">
        <header className="pt-8 pb-3">
          <span className="text-base font-medium">Security settings</span>
        </header>

        <div className="grid grid-cols-3 gap-10 bg-secondary/20 p-8 rounded-lg">
          <div>
            <FieldLegend>Security headers</FieldLegend>
            <FieldDescription>
              HTTP response headers added to every published page to defend against clickjacking, MIME-sniffing, and referrer leakage. Nothing is applied until you save — recommended values are pre-filled below.
            </FieldDescription>
          </div>

          <div className="col-span-2 grid grid-cols-2 gap-8">
            <Field orientation="horizontal" className="flex-row-reverse col-span-2">
              <FieldContent>
                <FieldLabel htmlFor="security-enabled">Enable security headers</FieldLabel>
                <FieldDescription>
                  Turn off to send no security headers on published pages.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="security-enabled"
                checked={settings.enabled}
                onCheckedChange={(checked) => updateSetting('enabled', checked)}
              />
            </Field>

            <FieldSeparator className="col-span-2" />

            <Field className="col-span-2">
              <FieldLabel htmlFor="frame-options">X-Frame-Options</FieldLabel>
              <FieldDescription>
                Controls whether your pages can be embedded in an iframe. Prevents clickjacking.
              </FieldDescription>
              <Select
                value={settings.frameOptions}
                onValueChange={(value) => updateSetting('frameOptions', value as SecurityHeadersSettings['frameOptions'])}
                disabled={disabled}
              >
                <SelectTrigger id="frame-options">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SAMEORIGIN">SAMEORIGIN — allow embedding on the same origin</SelectItem>
                  <SelectItem value="DENY">DENY — never allow embedding</SelectItem>
                  <SelectItem value="OFF">Off — do not send this header</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field orientation="horizontal" className="flex-row-reverse col-span-2">
              <FieldContent>
                <FieldLabel htmlFor="content-type-options">X-Content-Type-Options: nosniff</FieldLabel>
                <FieldDescription>
                  Stops browsers from MIME-sniffing responses away from the declared content type.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="content-type-options"
                checked={settings.contentTypeOptions}
                onCheckedChange={(checked) => updateSetting('contentTypeOptions', checked)}
                disabled={disabled}
              />
            </Field>

            <FieldSeparator className="col-span-2" />

            <Field className="col-span-2">
              <FieldLabel htmlFor="referrer-policy">Referrer-Policy</FieldLabel>
              <FieldDescription>
                Controls how much referrer information is sent with requests to other sites.
              </FieldDescription>
              <Select
                value={settings.referrerPolicy || REFERRER_POLICY_OFF}
                onValueChange={(value) => updateSetting('referrerPolicy', value === REFERRER_POLICY_OFF ? '' : value)}
                disabled={disabled}
              >
                <SelectTrigger id="referrer-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={REFERRER_POLICY_OFF}>Off — do not send this header</SelectItem>
                  {REFERRER_POLICY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field className="col-span-2">
              <FieldLabel htmlFor="permissions-policy">Permissions-Policy</FieldLabel>
              <FieldDescription>
                Restricts which browser features the page may use. Leave empty to omit the header.
              </FieldDescription>
              <Input
                id="permissions-policy"
                value={settings.permissionsPolicy}
                onChange={(e) => updateSetting('permissionsPolicy', e.target.value)}
                placeholder="camera=(), microphone=(), geolocation=()"
                disabled={disabled}
              />
            </Field>

            <FieldSeparator className="col-span-2" />

            <Field className="col-span-2">
              <FieldLabel htmlFor="content-security-policy">Content-Security-Policy</FieldLabel>
              <FieldDescription>
                Powerful but easy to misconfigure — a strict policy can break inline styles, fonts, or scripts on your site. Leave empty to omit the header.
              </FieldDescription>
              <CodeEditor
                value={settings.contentSecurityPolicy}
                onValueChange={(value) => updateSetting('contentSecurityPolicy', value)}
                placeholder="default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline';"
                readOnly={disabled}
                className={cn('min-h-24', disabled && 'opacity-50')}
              />
            </Field>

            {showHsts && (
              <>
                <Field className="col-span-2">
                  <FieldLabel htmlFor="strict-transport-security">Strict-Transport-Security (HSTS)</FieldLabel>
                  <FieldDescription>
                    Forces browsers to use HTTPS. Leave empty if your host already sets this (e.g. Vercel). Only enable once HTTPS is fully working.
                  </FieldDescription>
                  <Input
                    id="strict-transport-security"
                    value={settings.strictTransportSecurity}
                    onChange={(e) => updateSetting('strictTransportSecurity', e.target.value)}
                    placeholder="max-age=63072000; includeSubDomains; preload"
                    disabled={disabled}
                  />
                </Field>

                <FieldSeparator className="col-span-2" />
              </>
            )}

            <div className="col-span-2 flex justify-end">
              <Button
                size="sm" onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
