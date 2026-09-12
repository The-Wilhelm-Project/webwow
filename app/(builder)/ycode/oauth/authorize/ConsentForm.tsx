'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface ConsentFormProps {
  clientName: string;
  userEmail: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  state: string | null;
}

export default function ConsentForm(props: ConsentFormProps) {
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('dark');
    return () => {
      document.documentElement.classList.remove('dark');
    };
  }, []);

  const handleDecision = async (decision: 'approve' | 'deny') => {
    setSubmitting(decision);
    setError(null);

    try {
      const response = await fetch('/ycode/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          client_id: props.clientId,
          redirect_uri: props.redirectUri,
          code_challenge: props.codeChallenge,
          code_challenge_method: props.codeChallengeMethod,
          scope: props.scope,
          state: props.state,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.redirect_to) {
        setError(result.error_description || result.error || 'Failed to process decision');
        setSubmitting(null);
        return;
      }

      window.location.href = result.redirect_to;
    } catch (err) {
      console.error('Consent submission failed:', err);
      setError('Network error. Please try again.');
      setSubmitting(null);
    }
  };

  let hostname = props.redirectUri;
  try {
    hostname = new URL(props.redirectUri).host;
  } catch {
    // keep raw value on parse failure
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-md flex flex-col gap-6 p-8 rounded-lg border border-white/10 bg-neutral-900">

        <div className="flex flex-col gap-1">
          <h1 className="text-base font-medium">Connect {props.clientName}</h1>
          <p className="text-sm text-white/60">
            Signed in as <span className="text-white/85">{props.userEmail}</span>
          </p>
        </div>

        <div className="text-sm text-white/80 leading-relaxed">
          <p>
            <span className="font-medium text-white">{props.clientName}</span> is requesting
            access to your YCode project through the Model Context Protocol.
          </p>
          <p className="mt-3 text-white/60">
            If you approve, this application will be able to read and modify your pages,
            collections, assets, and other project data on your behalf.
          </p>
        </div>

        <div className="text-xs text-white/50 bg-white/5 px-3 py-2 rounded">
          Redirecting to <span className="text-white/80 font-mono">{hostname}</span>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2 justify-end">
          <Button
            variant="secondary"
            onClick={() => handleDecision('deny')}
            disabled={submitting !== null}
          >
            {submitting === 'deny' ? 'Denying…' : 'Deny'}
          </Button>
          <Button
            onClick={() => handleDecision('approve')}
            disabled={submitting !== null}
          >
            {submitting === 'approve' ? 'Approving…' : `Approve ${props.clientName}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
