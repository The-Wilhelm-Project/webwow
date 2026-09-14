'use client';

import React, { useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { BrandMark } from '../components/BrandMark';

interface EditLoginFormProps {
  siteId: string;
  siteName: string;
  editorEnabled: boolean;
  returnPath: string;
}

/**
 * Password gate of the `?edit` content editor: one shared password per site,
 * checked by `POST /ycode/api/webwow/auth/edit-login`, which then issues a
 * 12 h editor session and sends the visitor to the CMS.
 */
export function EditLoginForm({ siteId, siteName, editorEnabled, returnPath }: EditLoginFormProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    editorEnabled
      ? null
      : 'Editor access is not enabled for this site. An administrator can set an editor password in the Sites dashboard.',
  );
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/ycode/api/webwow/auth/edit-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ site: siteId, password, return: returnPath }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && typeof body?.data?.redirect === 'string') {
        window.location.assign(body.data.redirect);
        return;
      }
      setError(typeof body?.error === 'string' ? body.error : 'Could not open the editor');
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-950 py-10 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8 text-center">
          <BrandMark className="size-7 text-white" />
          <h1 className="text-base font-medium text-white">Edit {siteName}</h1>
          <p className="text-xs text-white/50">You will be returned to {returnPath} when you sign out.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}

          <Field>
            <Label htmlFor="webwow-edit-password">Editor password</Label>
            <Input
              type="password"
              id="webwow-edit-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={busy || !editorEnabled}
              required
            />
          </Field>

          <Button
            type="submit" size="sm"
            disabled={busy || !editorEnabled}
          >
            {busy ? <Spinner /> : 'Open editor'}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-white/40">
          Content editors can change texts, images and CMS entries — not the design.
        </p>
      </div>
    </div>
  );
}

export default EditLoginForm;
