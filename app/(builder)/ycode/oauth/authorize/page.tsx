import { redirect } from 'next/navigation';
import { getAuthUser } from '@/lib/supabase-auth';
import { getClient } from '@/lib/repositories/mcpOAuthClientRepository';
import ConsentForm from './ConsentForm';

/**
 * OAuth Consent Page
 *
 * Server component that validates the OAuth request server-side:
 *  - Requires a logged-in YCode user (redirects to login with ?next= otherwise).
 *  - Looks up the registered client by `client_id`.
 *  - Validates the supplied `redirect_uri` was registered at DCR time.
 *  - Enforces the MCP-required PKCE method (S256).
 *
 * On a valid request, renders the client-side `<ConsentForm />` which
 * posts the approve/deny decision to `/ycode/api/oauth/authorize`.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface SearchParams {
  [key: string]: string | string[] | undefined;
}

function asString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return null;
}

function buildLoginRedirect(searchParams: SearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') {
      params.set(key, value);
    } else if (Array.isArray(value) && value.length > 0) {
      params.set(key, value[0]);
    }
  }
  const next = `/ycode/oauth/authorize?${params.toString()}`;
  return `/ycode?next=${encodeURIComponent(next)}`;
}

function ErrorPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-md flex flex-col gap-3 p-8 rounded-lg border border-white/10 bg-neutral-900">
        <h1 className="text-base font-medium">{title}</h1>
        <p className="text-sm text-white/60">{message}</p>
      </div>
    </div>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const responseType = asString(params.response_type);
  const clientId = asString(params.client_id);
  const redirectUri = asString(params.redirect_uri);
  const codeChallenge = asString(params.code_challenge);
  const codeChallengeMethod = asString(params.code_challenge_method);
  const scope = asString(params.scope);
  const state = asString(params.state);

  if (!responseType || !clientId || !redirectUri || !codeChallenge || !codeChallengeMethod) {
    return (
      <ErrorPanel
        title="Invalid authorization request"
        message="The request is missing one or more required OAuth parameters."
      />
    );
  }

  if (responseType !== 'code') {
    return (
      <ErrorPanel
        title="Unsupported response type"
        message="Only the authorization code flow is supported."
      />
    );
  }

  if (codeChallengeMethod !== 'S256') {
    return (
      <ErrorPanel
        title="Unsupported PKCE method"
        message="Only the S256 code challenge method is supported."
      />
    );
  }

  const auth = await getAuthUser();
  if (!auth) {
    redirect(buildLoginRedirect(params));
  }

  let client;
  try {
    client = await getClient(clientId);
  } catch (error) {
    console.error('[oauth/authorize page] getClient failed:', error);
    return (
      <ErrorPanel
        title="Authorization unavailable"
        message="Could not look up the OAuth client. Please try again later."
      />
    );
  }

  if (!client) {
    return (
      <ErrorPanel
        title="Unknown client"
        message="The application requesting access has not been registered with this YCode instance."
      />
    );
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    return (
      <ErrorPanel
        title="Invalid redirect URI"
        message="The redirect URI does not match any registered for this client."
      />
    );
  }

  return (
    <ConsentForm
      clientName={client.client_name}
      userEmail={auth.user.email || ''}
      clientId={clientId}
      redirectUri={redirectUri}
      codeChallenge={codeChallenge}
      codeChallengeMethod={codeChallengeMethod}
      scope={scope}
      state={state}
    />
  );
}
