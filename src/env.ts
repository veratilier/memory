import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
export interface Env {
 DB: D1Database;
 OAUTH_KV: KVNamespace;
 OAUTH_PROVIDER: OAuthHelpers;
 ASSETS: Fetcher;
 APP_ORIGIN: string;
 SESSION_SECRET: string;
 EMBEDDING_URL?: string;
 EMBEDDING_MODEL?: string;
 EMBEDDING_API_KEY?: string;
}
export type AuthProps = { userId: string; clientId: string; scopes: string[]; authVersion: number };
