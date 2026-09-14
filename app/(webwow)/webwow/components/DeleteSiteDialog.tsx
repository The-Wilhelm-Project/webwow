'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage, sitesApi, type SiteJson } from './sites-api';

export interface DeleteSiteDialogProps {
  site: SiteJson | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (site: SiteJson) => void;
}

/** Typed confirmation ("type the site name") before dropping the site's database and files. */
export function DeleteSiteDialog({ site, open, onOpenChange, onDeleted }: DeleteSiteDialogProps) {
  if (!site) return null;
  return (
    <DeleteConfirm
      key={site.id}
      site={site}
      open={open}
      onOpenChange={onOpenChange}
      onDeleted={onDeleted}
    />
  );
}

function DeleteConfirm({ site, open, onOpenChange, onDeleted }: DeleteSiteDialogProps & { site: SiteJson }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === site.name;

  const confirm = async () => {
    setError(null);
    try {
      await sitesApi.remove(site.id);
      toast.success(`Site "${site.name}" deleted`);
      onDeleted(site);
    } catch (err) {
      const message = errorMessage(err, 'Could not delete the site');
      setError(message);
      toast.error(message);
      throw err; // keeps the dialog open
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete "${site.name}"?`}
      confirmLabel="Delete site"
      confirmVariant="destructive"
      disableConfirm={!matches}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground">
          This drops the site&apos;s database{site.database_name ? <> <code>{site.database_name}</code></> : ''}, deletes every uploaded file
          and ends all editor sessions. This cannot be undone.
        </p>
        <Field>
          <Label htmlFor="delete-site-confirm">Type the site name to confirm</Label>
          <Input
            id="delete-site-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={site.name}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}

export default DeleteSiteDialog;
