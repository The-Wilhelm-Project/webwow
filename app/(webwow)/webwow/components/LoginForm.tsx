'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/stores/useAuthStore';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { BrandMark } from './BrandMark';

interface LoginFormProps {
  onSignedIn?: () => void;
}

/**
 * Dashboard login (same look as the builder's login screen): e-mail + password
 * against `POST /ycode/api/webwow/auth/login` through the auth store.
 */
export function LoginForm({ onSignedIn }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await useAuthStore.getState().signIn(email, password);
      if (result.error) {
        setError(result.error);
        return;
      }
      onSignedIn?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-950 py-10 px-4">
      <div
        className="w-full max-w-sm animate-in fade-in slide-in-from-bottom-1 duration-700"
        style={{ animationFillMode: 'both' }}
      >
        <div className="flex flex-col items-center gap-3 mb-8 text-center">
          <BrandMark className="size-7 text-white" />
          <h1 className="text-base font-medium text-white">Sign in to Webwow</h1>
          <p className="text-xs text-white/50">Manage all of your sites from one place.</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-6"
        >
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}

          <Field>
            <Label htmlFor="webwow-login-email">Email</Label>
            <Input
              type="email"
              id="webwow-login-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
              disabled={busy}
              required
            />
          </Field>

          <Field>
            <Label htmlFor="webwow-login-password">Password</Label>
            <Input
              type="password"
              id="webwow-login-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={busy}
              required
            />
          </Field>

          <Button
            type="submit"
            size="sm"
            disabled={busy}
          >
            {busy ? <Spinner /> : 'Sign In'}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <p className="text-xs text-white/50">
            First time here?{' '}
            <Link
              href="/ycode/welcome"
              className="text-white/80"
            >
              Complete setup
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default LoginForm;
