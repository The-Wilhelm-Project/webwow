'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  EDITOR_PASSWORD_MIN_LENGTH,
  SITE_NAME_MAX_LENGTH,
  errorMessage,
  sitesApi,
  slugProblem,
  type SiteJson,
} from './sites-api';

export interface SiteSettingsDialogProps {
  site: SiteJson | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the updated site after every successful change (rename, domains, editor password). */
  onSaved: (site: SiteJson) => void;
}

/** Name, slug, domains and the `?edit` editor access of one site. */
export function SiteSettingsDialog({ site, open, onOpenChange, onSaved }: SiteSettingsDialogProps) {
  return (
    <Dialog
      open={open && !!site}
      onOpenChange={onOpenChange}
    >
      {open && site && (
        <SettingsForm
          key={site.id}
          site={site}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function parseDomains(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function SettingsForm({ site, onOpenChange, onSaved }: { site: SiteJson } & Omit<SiteSettingsDialogProps, 'site' | 'open'>) {
  const [name, setName] = useState(site.name);
  const [slug, setSlug] = useState(site.slug);
  const [domainsText, setDomainsText] = useState(site.domains.join('\n'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editorPasswordSet, setEditorPasswordSet] = useState(site.editorPasswordSet);
  const [password, setPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState<'set' | 'disable' | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const slugError = slugProblem(slug.trim().toLowerCase());
  const nameError = !name.trim() ? 'A name is required' : name.trim().length > SITE_NAME_MAX_LENGTH ? `At most ${SITE_NAME_MAX_LENGTH} characters` : null;
  const dirty = name.trim() !== site.name || slug.trim().toLowerCase() !== site.slug || parseDomains(domainsText).join('\n') !== site.domains.join('\n');
  const busy = saving || passwordBusy !== null;

  const editHint = site.is_default
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/?edit`
    : `${site.previewUrl}/?edit`;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || nameError || slugError) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; slug?: string; domains?: string[] } = {};
      if (name.trim() !== site.name) patch.name = name.trim();
      if (slug.trim().toLowerCase() !== site.slug) patch.slug = slug.trim().toLowerCase();
      const domains = parseDomains(domainsText);
      if (domains.join('\n') !== site.domains.join('\n')) patch.domains = domains;
      const updated = Object.keys(patch).length > 0 ? await sitesApi.update(site.id, patch) : site;
      toast.success('Site settings saved');
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the settings'));
    } finally {
      setSaving(false);
    }
  };

  const setEditorPassword = async () => {
    if (password.length < EDITOR_PASSWORD_MIN_LENGTH) {
      setPasswordError(`The editor password must be at least ${EDITOR_PASSWORD_MIN_LENGTH} characters`);
      return;
    }
    setPasswordBusy('set');
    setPasswordError(null);
    try {
      const result = await sitesApi.setEditorPassword(site.id, password);
      setEditorPasswordSet(result.editorPasswordSet);
      setPassword('');
      toast.success(editorPasswordSet ? 'Editor password changed — open editor sessions were ended' : 'Editor access enabled');
      onSaved(result.site);
    } catch (err) {
      setPasswordError(errorMessage(err, 'Could not set the editor password'));
    } finally {
      setPasswordBusy(null);
    }
  };

  const disableEditorAccess = async () => {
    setPasswordBusy('disable');
    setPasswordError(null);
    try {
      const result = await sitesApi.setEditorPassword(site.id, null);
      setEditorPasswordSet(result.editorPasswordSet);
      setPassword('');
      toast.success('Editor access disabled — open editor sessions were ended');
      onSaved(result.site);
    } catch (err) {
      setPasswordError(errorMessage(err, 'Could not disable editor access'));
    } finally {
      setPasswordBusy(null);
    }
  };

  return (
    <DialogContent
      showCloseButton={!busy}
      className="max-h-[calc(100vh-2rem)] overflow-y-auto"
      onInteractOutside={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      <form
        onSubmit={save}
        className="flex flex-col gap-6"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Site settings
            {site.is_default && <Badge variant="secondary">Default</Badge>}
          </DialogTitle>
          <DialogDescription>
            {site.database_name ? <>Database <code>{site.database_name}</code></> : 'Stored in the main database'} · id <code>{site.id}</code>
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Field>
          <Label htmlFor="site-settings-name">Name</Label>
          <Input
            id="site-settings-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            aria-invalid={!!nameError}
            required
          />
          {nameError && <p className="text-destructive">{nameError}</p>}
        </Field>

        <Field>
          <Label htmlFor="site-settings-slug">Slug</Label>
          <Input
            id="site-settings-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            disabled={busy || site.is_default}
            aria-invalid={!!slugError}
            spellCheck={false}
          />
          <p className={slugError ? 'text-destructive' : 'text-muted-foreground'}>
            {slugError ?? (site.is_default
              ? 'The default site keeps its slug.'
              : `Used for the preview host (${slug || 'slug'}.<base domain>). The database name stays ${site.database_name ?? 'unchanged'}.`)}
          </p>
        </Field>

        <Field>
          <Label htmlFor="site-settings-domains">Domains (one per line)</Label>
          <Textarea
            id="site-settings-domains"
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            placeholder={'www.example.com\nexample.com'}
            rows={3}
            disabled={busy}
            spellCheck={false}
          />
          <p className="text-muted-foreground">
            Requests on these hosts are served from this site (point their DNS at this server).
            {site.is_default ? ' The default site also answers on every host no other site claims.' : ''}
          </p>
        </Field>

        <Separator />

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium">Editor access</div>
            {editorPasswordSet ? <Badge variant="green">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
          </div>
          <p className="text-muted-foreground">
            With a password, anyone can open <code className="text-foreground">{editHint}</code> and edit the site&apos;s CMS content
            (no design changes, no settings). Changing or disabling the password ends all open editor sessions.
          </p>
          {passwordError && (
            <Alert variant="destructive">
              <AlertTitle>{passwordError}</AlertTitle>
            </Alert>
          )}
          <div className="flex items-end gap-2">
            <Field className="flex-1">
              <Label htmlFor="site-settings-editor-password">{editorPasswordSet ? 'New editor password' : 'Editor password'}</Label>
              <Input
                id="site-settings-editor-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${EDITOR_PASSWORD_MIN_LENGTH} characters`}
                autoComplete="new-password"
                disabled={busy}
                minLength={EDITOR_PASSWORD_MIN_LENGTH}
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={setEditorPassword}
              disabled={busy || password.length === 0}
            >
              {passwordBusy === 'set' ? <Spinner className="size-3" /> : editorPasswordSet ? 'Change password' : 'Set password'}
            </Button>
          </div>
          {editorPasswordSet && (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={disableEditorAccess}
                disabled={busy}
              >
                {passwordBusy === 'disable' ? <Spinner className="size-3" /> : 'Disable editor access'}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {dirty ? 'Cancel' : 'Close'}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !dirty || !!nameError || !!slugError}
          >
            {saving ? <Spinner className="size-3" /> : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export default SiteSettingsDialog;
