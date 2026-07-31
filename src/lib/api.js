import { supabase } from "./supabase";

/* ============================================================
   Every read and write lives here, so the component stays about
   rendering. Anything that throws carries a database error whose
   message the UI maps through lib/errors.js.
   ============================================================ */

const rethrow = ({ data, error }) => { if (error) throw error; return data; };

/* ── auth ─────────────────────────────────────────────── */
export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export const signOut = () => supabase.auth.signOut();

export async function createWorkspace(name, displayName) {
  return rethrow(await supabase.rpc("create_workspace", {
    ws_name: name, display_name: displayName ?? null,
  }));
}

/* ── the whole workspace in one go ────────────────────── */
/* Small data (≤30 people, ≤3 projects), so one load beats a
   dozen round trips. Refetch after any mutation. */
export async function loadWorkspace() {
  const { data: memberRows, error: meErr } = await supabase
    .from("workspace_members").select("*").limit(1);
  if (meErr) throw meErr;
  if (!memberRows?.length) return null;          // signed in, no workspace yet

  const workspaceId = memberRows[0].workspace_id;

  const [ws, members, projects, projectMembers, items, comments, notifications, limits] =
    await Promise.all([
      supabase.from("workspaces").select("*").eq("id", workspaceId).single(),
      supabase.from("workspace_members").select("*").order("invited_at"),
      supabase.from("projects").select("*").order("created_at"),
      supabase.from("project_members").select("*"),
      supabase.from("raid_items").select("*").order("updated_at", { ascending: false }),
      supabase.from("raid_item_comments").select("*").order("created_at"),
      supabase.from("notifications").select("*").order("created_at", { ascending: false }),
      supabase.rpc("effective_limits", { ws: workspaceId }),
    ]);

  for (const r of [ws, members, projects, projectMembers, items, comments, notifications, limits]) {
    if (r.error) throw r.error;
  }

  const byItem = {};
  comments.data.forEach((c) => (byItem[c.raid_item_id] ||= []).push(c));

  const { data: { user } } = await supabase.auth.getUser();
  const me = members.data.find((m) => m.user_id === user?.id) ?? memberRows[0];
  const lim = limits.data?.[0] ?? {};

  return {
    workspace: ws.data,
    me,
    members: members.data,
    projects: projects.data,
    projectMembers: projectMembers.data,
    items: items.data.map((i) => ({ ...i, comments: byItem[i.id] ?? [] })),
    notifications: notifications.data,
    limits: {
      projects: lim.max_projects ?? 1,
      seats: lim.max_seats ?? 5,
      perProject: lim.max_per_project ?? 5,
      projectAdmins: lim.max_project_admins ?? 1,
      csv: lim.csv_export ?? false,
    },
  };
}

/* ── items ────────────────────────────────────────────── */
export async function createItem(workspaceId, form, openingComment, authorId) {
  const item = rethrow(await supabase.from("raid_items").insert({
    workspace_id: workspaceId,
    project_id: form.projectId,
    type: form.type,
    priority: form.priority,
    status: form.status,
    title: form.title.trim(),
    description: form.description,
    impact: form.impact,
    next_step: form.nextStep,
    final_resolution: form.finalResolution ?? "",
    owner_id: form.ownerId,
    due_date: form.dueDate,
  }).select().single());

  if (openingComment?.trim()) {
    await addComment(item.id, openingComment, authorId);
  }
  return item;
}

/* Only the fields the drawer can edit — the Save button sends this. */
export async function saveItem(itemId, draft) {
  return rethrow(await supabase.from("raid_items").update({
    title: draft.title,
    type: draft.type,
    priority: draft.priority,
    status: draft.status,
    description: draft.description,
    impact: draft.impact,
    next_step: draft.nextStep,
    final_resolution: draft.finalResolution,
    owner_id: draft.ownerId,
    due_date: draft.dueDate,
  }).eq("id", itemId).select().single());
  /* updated_at / updated_by are stamped by a trigger, not sent from here */
}

export async function deleteItem(itemId) {
  const { error } = await supabase.from("raid_items").delete().eq("id", itemId);
  if (error) throw error;
}

export async function markReminded(itemId) {
  return rethrow(await supabase.from("raid_items")
    .update({ last_reminder_sent_at: new Date().toISOString() })
    .eq("id", itemId).select().single());
}

export async function snoozeItem(itemId, days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return rethrow(await supabase.from("raid_items")
    .update({ snoozed_until: d.toISOString().slice(0, 10) })
    .eq("id", itemId).select().single());
}

/* ── comments (append only) ───────────────────────────── */
export async function addComment(itemId, text, authorId) {
  return rethrow(await supabase.from("raid_item_comments").insert({
    raid_item_id: itemId, author_id: authorId, comment_text: text.trim(),
  }).select().single());
}

/* ── notifications ────────────────────────────────────── */
export async function notify(entries) {
  if (!entries.length) return [];
  return rethrow(await supabase.from("notifications").insert(entries).select());
}

export async function markRead(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from("notifications").update({ read: true }).in("id", ids);
  if (error) throw error;
}

/* ── projects ─────────────────────────────────────────── */
export async function addProject(workspaceId, name) {
  return rethrow(await supabase.from("projects")
    .insert({ workspace_id: workspaceId, name: name.trim() }).select().single());
}

export async function deleteProject(projectId) {
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw error;
}

export async function setProjectRole(projectId, memberId, role, assignedBy) {
  if (role === "none") {
    const { error } = await supabase.from("project_members").delete()
      .eq("project_id", projectId).eq("workspace_member_id", memberId);
    if (error) throw error;
    return null;
  }
  return rethrow(await supabase.from("project_members").upsert({
    project_id: projectId,
    workspace_member_id: memberId,
    project_role: role,
    assigned_by: assignedBy,
    assigned_at: new Date().toISOString(),
  }, { onConflict: "project_id,workspace_member_id" }).select().single());
}

/* ── people ───────────────────────────────────────────── */
export async function inviteMember(workspaceId, email, name) {
  const clean = email.trim().toLowerCase();
  return rethrow(await supabase.from("workspace_members").insert({
    workspace_id: workspaceId,
    email: clean,
    name: name?.trim() || clean.split("@")[0],
    role: "user",
    state: "invited",
  }).select().single());
}

export async function setWorkspaceRole(memberId, role) {
  return rethrow(await supabase.from("workspace_members")
    .update({ role }).eq("id", memberId).select().single());
}

export async function removeMember(memberId) {
  const { error } = await supabase.from("workspace_members").delete().eq("id", memberId);
  if (error) throw error;
}

/* ── CSV export ───────────────────────────────────────── */
/* Goes through an RPC that checks the plan server-side, so hiding
   the button isn't the only thing standing in the way (§3.5). */
export async function exportLog() {
  return rethrow(await supabase.rpc("export_raid_log"));
}
