import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    "Missing Supabase env vars. Copy .env.example to .env.local and fill in " +
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  );
}

/* The anon key is meant to be public. Row Level Security is what protects
   the data — see supabase/schema.sql. */
export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
