'use client';

import React, { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Spinner } from '@/components/ui/spinner';
import {
  SITE_NAME_MAX_LENGTH,
  errorMessage,
  sitesApi,
  slugProblem,
  slugifyClient,
  type SiteJson,
} from './sites-api';

export interface NewSiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new site once it exists (also when the optional import failed but the site was kept). */
  onCreated: (site: SiteJson) => void;
}

type Phase = 'idle' | 'creating' | 'importing' | 'import-failed' | 'deleting';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * "New site": name + slug (auto-derived, editable, live validation) and an
 * optional `.ycode` export to start from. Flow: `POST /sites` -> optional
 * `POST /sites/[id]/import`; a failed import offers to delete the empty site.
 */
export function NewSiteDialog({ open, onOpenChange, onCreated }: NewSiteDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      {/* key: fresh form state every time the dialog opens */}
      {open && (
        <NewSiteForm
          key="new-site-form"
          onOpenChange={onOpenChange}
          onCreated={onCreated}
        />
      )}
    </Dialog>
  );
}

function NewSiteForm({ onOpenChange, onCreated }: Omit<NewSiteDialogProps, 'open'>) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<SiteJson | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = phase === 'creating' || phase === 'importing' || phase === 'deleting';
  const effectiveSlug = slugTouched ? slug : slugifyClient(name);
  const slugError = name.trim() || slugTouched ? slugProblem(effectiveSlug) : null;
  const nameError = name.trim().length > SITE_NAME_MAX_LENGTH ? `At most ${SITE_NAME_MAX_LENGTH} characters` : null;
  const canSubmit = !busy && name.trim().length > 0 && !nameError && !slugError;

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    let site = created;
    let stage: 'create' | 'import' = 'create';
    try {
      if (!site) {
        setPhase('creating');
        site = await sitesApi.create({ name: name.trim(), slug: effectiveSlug });
        setCreated(site);
      }
      if (file) {
        stage = 'import';
        setPhase('importing');
        await sitesApi.importFile(site.id, file, password || undefined);
        toast.success(`Site "${site.name}" created from ${file.name}`);
      } else {
        toast.success(`Site "${site.name}" created`);
      }
      setPhase('idle');
      onCreated(site);
      onOpenChange(false);
    } catch (err) {
      // 'import': the site exists, only the export could not be applied
      setPhase(stage === 'import' ? 'import-failed' : 'idle');
      setError(errorMessage(err, 'Could not create the site'));
    }
  };

  const deleteEmptySite = async () => {
    if (!created) return;
    setPhase('deleting');
    try {
      await sitesApi.remove(created.id);
      toast.success(`Site "${created.name}" deleted`);
      setCreated(null);
      setPhase('idle');
      setError(null);
      onCreated(created); // refresh the list (the site is gone)
      onOpenChange(false);
    } catch (err) {
      setPhase('import-failed');
      setError(errorMessage(err, 'Could not delete the site'));
    }
  };

  const keepEmptySite = () => {
    if (!created) return;
    onCreated(created);
    onOpenChange(false);
  };

  return (
    <DialogContent
      showCloseButton={!busy}
      onInteractOutside={(e) => {
        if (busy) e.preventDefault();
      }}
      onEscapeKeyDown={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-6"
      >
        <DialogHeader>
          <DialogTitle>New site</DialogTitle>
          <DialogDescription>
            Every site gets its own database and upload folder. Start empty or from a <code>.ycode</code> export.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{phase === 'import-failed' ? 'Import failed' : 'Could not create the site'}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {phase === 'import-failed' && created ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground">
              The site <strong className="text-foreground">{created.name}</strong> was created, but the export could not be applied.
              Keep the empty site or delete it again.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={deleteEmptySite}
              >
                Delete the empty site
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={keepEmptySite}
              >
                Keep the empty site
              </Button>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={!file}
              >
                Retry import
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Field>
              <Label htmlFor="new-site-name">Name</Label>
              <Input
                id="new-site-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My new website"
                maxLength={SITE_NAME_MAX_LENGTH + 20}
                autoFocus
                disabled={busy || !!created}
                aria-invalid={!!nameError}
                required
              />
              {nameError && <p className="text-destructive">{nameError}</p>}
            </Field>

            <Field>
              <Label htmlFor="new-site-slug">Slug</Label>
              <Input
                id="new-site-slug"
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                placeholder="my-new-website"
                disabled={busy || !!created}
                aria-invalid={!!slugError}
                spellCheck={false}
              />
              <p className={slugError ? 'text-destructive' : 'text-muted-foreground'}>
                {slugError ?? `Preview host ${effectiveSlug || 'slug'}.<base domain>; database webwow_site_${(effectiveSlug || 'slug').replace(/-/g, '_')}`}
              </p>
            </Field>

            <Field>
              <Label htmlFor="new-site-file">Start from a .ycode export (optional)</Label>
              <input
                ref={fileInput}
                id="new-site-file"
                type="file"
                accept=".ycode,application/octet-stream"
                disabled={busy || !!created}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-secondary/70 file:cursor-pointer"
              />
              {file ? (
                <p className="text-muted-foreground">
                  {file.name} · {formatBytes(file.size)}{' '}
                  <button
                    type="button"
                    className="underline hover:text-foreground"
                    onClick={() => {
                      setFile(null);
                      if (fileInput.current) fileInput.current.value = '';
                    }}
                    disabled={busy}
                  >
                    remove
                  </button>
                </p>
              ) : (
                <p className="text-muted-foreground">
                  A project export from Settings → Templates or from another site&apos;s card menu. Pages, CMS, assets and settings are applied to the new site.
                </p>
              )}
            </Field>

            {file && (
              <Field>
                <Label htmlFor="new-site-password">Export password (only for encrypted exports)</Label>
                <Input
                  id="new-site-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  disabled={busy}
                />
              </Field>
            )}
          </>
        )}

        {phase !== 'import-failed' && (
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
            >
              {phase === 'creating' && (<><Spinner className="size-3" /> Creating site…</>)}
              {phase === 'importing' && (<><Spinner className="size-3" /> Importing export…</>)}
              {phase === 'deleting' && (<><Spinner className="size-3" /> Deleting…</>)}
              {phase === 'idle' && (file ? 'Create site and import' : 'Create site')}
            </Button>
          </DialogFooter>
        )}
      </form>
    </DialogContent>
  );
}

export default NewSiteDialog;
