# RAID Log

Track risks, actions, issues, dependencies and decisions in one place.
Vite + React on Vercel, Supabase for auth and data, Stripe Payment Links for billing.

```
src/
  RaidLog.jsx      the whole UI
  lib/supabase.js  client
  lib/api.js       every read and write
  lib/errors.js    maps database errors to plain English
supabase/
  schema.sql       tables, RLS, helpers, cap triggers — idempotent
```

## Before you start

Accounts needed: Supabase, Vercel, GitHub, Stripe. All have free tiers
that cover this.

---

## 1. Install and run

```bash
npm install
cp .env.example .env.local
```

Leave `.env.local` for now — you fill it in at step 2. Then:

```bash
npm run dev
```

It will throw on the missing env vars. That's expected.

## 2. Supabase project

1. Create a project at supabase.com. Pick a region near your users.
2. Settings → API → copy **Project URL** and the **anon public** key.
3. Paste both into `.env.local`.
4. `npm run dev` again — you should get the sign-in screen.

The anon key is meant to be public. Row Level Security is what protects
the data, which is why step 3 matters more than key secrecy.

## 3. Schema

Open Supabase → SQL Editor → New query. Paste all of
`supabase/schema.sql` and run it. It's idempotent, so rerun freely.

Verify:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public';
```

Every row must show `rowsecurity = true`. If any says false, the policies
didn't apply and your data is open.

## 4. Auth settings

Supabase → Authentication:

- **Providers → Email**: turn **Confirm email OFF**. Magic links are
  already a confirmation; leaving this on adds a second dead-end step.
- **URL Configuration → Site URL**: `http://localhost:5173` for now.

Test it: sign in with your own address, click the emailed link, name a
workspace. You should land on the Projects tab.

## 5. Stripe

Create three Payment Links and one portal link:

| What | Price |
|---|---|
| Paid, monthly | $15/mo |
| Paid, annual | $150/yr |
| Expansion add-on | $9/mo |
| Customer Portal | Settings → Billing → Customer portal |

Paste all four into the `STRIPE` object near the top of
`src/RaidLog.jsx`, and set `SALES_EMAIL` to a real address.

## 6. Deploy

```bash
git init && git add -A && git commit -m "RAID Log"
```

Publish to GitHub, then in Vercel: **Add New → Project → import the repo**.
Framework auto-detects as Vite. Before deploying, add under
**Environment Variables**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Apply both to Production, Preview and Development. Deploy.

## 7. Point Supabase at the deployed URL

**This is the step that breaks magic links if skipped.**

Supabase → Authentication → URL Configuration:

- **Site URL** → your Vercel production URL
- **Redirect URLs** → add the production URL, and
  `https://*-yourname.vercel.app/**` so preview builds work too

Add your custom domain here as well if you have one.

## 8. Test with two real inboxes

1. Sign up fresh at the production URL, create a workspace.
2. Add a project. Invite a second address you control.
3. Sign in as that person. **They should land in the workspace, not on
   "name your workspace"** — if they don't, the invite-linking trigger
   didn't fire.
4. Log an item, @mention the other person, check the bell.
5. As the second person, try to write to a project they aren't on. The
   database should refuse, not just the hidden button.

---

## Selling a plan

At launch, billing is manual and that's deliberate — the webhook
automation isn't worth building before you have customers.

When someone pays via a Payment Link, in Supabase → Table Editor →
`workspaces`, set for their row:

- `plan` → `paid`
- `has_expansion_addon` → `true` if they bought the add-on

Their limits lift on next page load. The caps are enforced by database
triggers reading those two columns, so nothing else needs touching.

**Fast-follow once you have paying customers:** an Edge Function on
`checkout.session.completed` that sets the same two fields, using the
service role key.

## Gotchas already handled

- **RLS recursion** on membership policies — solved with
  `security definer` helpers (`is_workspace_member`, `is_workspace_admin`,
  `is_project_member`, `is_project_admin`).
- **Invite linking** — a trigger on `auth.users` claims the invited row
  by email on first sign-in.
- **Caps** — enforced by triggers, not just the UI, so two simultaneous
  invites can't both slip past.
- **CSV export** — goes through the `export_raid_log` RPC which checks
  the plan server-side. Hiding the button isn't the only thing stopping a
  Free workspace.
- **Last admin** — a trigger refuses to demote or delete the only one.
