import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  Search, Plus, X, Mail, Trash2, Download, MessageSquare, ArrowUpDown,
  Users, FolderPlus, Activity, ClipboardList, ShieldCheck, AlertCircle, Send,
  UserCheck, CheckCircle2, Info, LogOut, Lock, CreditCard, Zap, ExternalLink, Sprout,
  Bell, Save, Link2, Undo2, Clock, AtSign, Eye,
} from "lucide-react";
import { supabase } from "./lib/supabase";
import * as api from "./lib/api";
import { friendly } from "./lib/errors";

/* ── tokens ───────────────────────────────────────────── */
const C = {
  paper: "#E9EDF1", surface: "#FFFFFF", ink: "#16202B", muted: "#6B7A89",
  rule: "#D6DEE6", late: "#A8271F", soon: "#8A6100", good: "#2E6B4F", accent: "#12525C",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const TYPES = { risk: "RISK", action: "ACTION", issue: "ISSUE", dependency: "DEPEND", decision: "DECIDE" };
const PRIORITY = {
  critical: { label: "Critical", tick: "#A8271F", rank: 4 },
  high: { label: "High", tick: "#C2620E", rank: 3 },
  medium: { label: "Medium", tick: "#A98A00", rank: 2 },
  low: { label: "Low", tick: "#94A3B0", rank: 1 },
};
const STATUS = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };

const DUE_SOON_DAYS = 7;
const SNOOZE_DAYS = 3;
const UNDO_MS = 7000;

/* §3 — two SKUs plus one optional add-on, not three tiers */
const PLAN_BASE = {
  free: { key: "free", label: "Free", price: "$0",     projects: 1, seats: 5,  perProject: 5,  projectAdmins: 1, csv: false },
  paid: { key: "paid", label: "Paid", price: "$15/mo", projects: 2, seats: 20, perProject: 10, projectAdmins: 2, csv: true  },
};
const EXPANSION = { label: "Expansion add-on", price: "+$9/mo", projects: 1, seats: 10 };

/* effective_limits = base + (add-on active ? expansion : 0)  — §3.4 */
function effectiveLimits(plan, hasExpansion) {
  const b = PLAN_BASE[plan] ?? PLAN_BASE.free;
  const on = plan === "paid" && !!hasExpansion;
  return {
    ...b,
    projects: b.projects + (on ? EXPANSION.projects : 0),
    seats: b.seats + (on ? EXPANSION.seats : 0),
    expansion: on,
    label: on ? `${b.label} + Expansion` : b.label,
    price: on ? "$24/mo" : b.price,
  };
}

/* §2.4/§3.5 — sell via Payment Links, manage via Stripe's hosted portal.
   Replace these with your real Stripe URLs before launch.               */
const STRIPE = {
  paid: "https://buy.stripe.com/REPLACE_paid_15_monthly",
  paidAnnual: "https://buy.stripe.com/REPLACE_paid_150_annual",
  expansion: "https://buy.stripe.com/REPLACE_expansion_9_monthly",
  portal: "https://billing.stripe.com/p/login/REPLACE_portal",
};
const openStripe = (url) => window.open(url, "_blank", "noopener,noreferrer");

/* §3.5 — the model supports one add-on, not stacking. A workspace on
   Paid + Expansion that outgrows 3 projects / 30 seats has no self-serve
   path left, so it gets a real conversation rather than a dead button.  */
const SALES_EMAIL = "hello@raidlog.app";

function contactSales({ workspaceName, plan, hasExpansion, projects, seats, limits, hitting }) {
  const what = hitting === "projects" ? "a fourth project"
    : hitting === "seats" ? "more than 30 people"
    : "more room";
  const subject = `[RAID Log] Outgrowing Paid + Expansion — ${workspaceName}`;
  const body = `Hi,

We're on ${plan === "paid" && hasExpansion ? "Paid + Expansion" : plan} and have run out of room. We need ${what}.

Workspace:  ${workspaceName}
Projects:   ${projects} of ${limits.projects}
People:     ${seats} of ${limits.seats}
Needs:      ${what}

A bit about how we're using it:


Could you let us know what the options are?

Thanks`;
  window.open(`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
}

/* free → sell Paid · paid → sell Expansion · paid+expansion → talk to us */
function upgradePath(plan, hasExpansion) {
  if (plan === "free") return "paid";
  return hasExpansion ? "ceiling" : "expansion";
}

/* ── dates ────────────────────────────────────────────── */
const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const stamp = (days, hours = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
};
const nowISO = () => new Date().toISOString();
const today = () => shift(0);
const dayDelta = (date) => Math.round((new Date(date) - new Date(today())) / 86400000);
const deltaLabel = (n) => (n === 0 ? "TDY" : n < 0 ? `−${Math.abs(n)}d` : `+${n}d`);
const isLive = (s) => s !== "resolved" && s !== "closed";

/* relative time, for updated/created/reminded */
function ago(iso) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/* ── seed: four tenants, one per tier plus an over-limit one ── */
/* ── mail helpers ─────────────────────────────────────── */
function sendReminder(item, members, projectName) {
  const n = dayDelta(item.dueDate);
  const urgency = n < 0 ? `OVERDUE by ${Math.abs(n)} day(s)` : n === 0 ? "due TODAY" : `due in ${n} day(s)`;
  const to = members.find((m) => m.name === item.owner)?.email || "";
  const subject = `[RAID Log] Reminder: "${item.title}" is ${urgency}`;
  const body = `Hi ${item.owner},

This is a reminder about a RAID item assigned to you that is ${urgency}.

Project:   ${projectName}
Status:    ${STATUS[item.status]}
Priority:  ${PRIORITY[item.priority].label}
Due Date:  ${item.dueDate}

Please review and update the item in the RAID Log, or reach out if you need support closing it out.

— Sent from RAID Log`;
  window.open(`mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
}

function sendAssignmentEmail(item, ownerEmail, projectName, actor) {
  const subject = `[RAID Log] You've been assigned: "${item.title}"`;
  const body = `Hi,

${actor} has assigned a RAID item to you.

Item:      ${item.id} — ${item.title}
Project:   ${projectName}
Type:      ${TYPES[item.type]}
Priority:  ${PRIORITY[item.priority].label}
Due Date:  ${item.dueDate}

Next step: ${item.nextStep || "not recorded yet"}

Open the RAID Log to pick it up.

— Sent from RAID Log`;
  window.open(`mailto:${ownerEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
}

function sendMentionEmail(item, email, actor, text, projectName) {
  const subject = `[RAID Log] ${actor} mentioned you on "${item.title}"`;
  const body = `Hi,

${actor} mentioned you in a comment on a RAID item.

Item:      ${item.id} — ${item.title}
Project:   ${projectName}

"${text}"

Open the RAID Log to reply.

— Sent from RAID Log`;
  window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
}

function sendInvite(email) {
  const subject = "You've been added to the RAID Log";
  const body = `Hi,

You've been given access to our team's RAID Log, where we track risks, actions, issues, dependencies and decisions.

Open the link below and sign in with this email address — no password needed, you'll get a one-time sign-in link.

[ paste your RAID Log URL here ]

— Sent from RAID Log`;
  window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
}

/* Rows come from the export_raid_log RPC, which checks the plan
   server-side — the disabled button is only the polite half. */
function downloadCSV(rows, filename = "raid-log.csv") {
  const head = ["ID", "Type", "Project", "Priority", "Status", "Title", "Owner", "Due date", "Last updated", "Updated by"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = (rows ?? []).map((r) => [
    r.ref, r.type, r.project, r.priority, r.status, r.title,
    r.owner ?? "", r.due_date, (r.updated_at ?? "").slice(0, 10), r.updated_by ?? "",
  ].map(esc).join(","));
  const blob = new Blob([[head.map(esc).join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ── @mentions ────────────────────────────────────────── */
/* find member names that appear after an @ in the text, longest first */
function findMentions(text, members) {
  const names = members.map((m) => m.name).sort((a, b) => b.length - a.length);
  return members.filter((m) => text.includes("@" + m.name)).filter((m, i, arr) => arr.indexOf(m) === i);
}

function CommentBody({ text, members }) {
  const names = members.map((m) => m.name).sort((a, b) => b.length - a.length);
  const parts = [];
  let rest = text;
  let guard = 0;
  while (rest.length && guard++ < 200) {
    const hit = names
      .map((n) => ({ n, at: rest.indexOf("@" + n) }))
      .filter((x) => x.at !== -1)
      .sort((a, b) => a.at - b.at)[0];
    if (!hit) { parts.push({ t: rest }); break; }
    if (hit.at > 0) parts.push({ t: rest.slice(0, hit.at) });
    parts.push({ t: "@" + hit.n, mention: true });
    rest = rest.slice(hit.at + hit.n.length + 1);
  }
  return (
    <span>
      {parts.map((p, k) =>
        p.mention
          ? <span key={k} className="px-1 rounded" style={{ background: "#EDF3F1", color: C.accent, fontWeight: 500 }}>{p.t}</span>
          : <span key={k}>{p.t}</span>
      )}
    </span>
  );
}

const inputStyle = { background: C.surface, border: `1px solid ${C.rule}`, color: C.ink, borderRadius: 6 };
const errStyle = { ...inputStyle, borderColor: C.late };

/* ── atoms ────────────────────────────────────────────── */
function TypeTag({ type }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] tracking-[0.08em]"
      style={{ fontFamily: MONO, background: "#EDF1F4", color: C.muted, border: `1px solid ${C.rule}` }}>
      {TYPES[type]}
    </span>
  );
}

function Field({ label, required, error, children }) {
  return (
    <label className="block">
      <span className="flex items-baseline gap-1 mb-1">
        <span className="text-[11px] tracking-[0.06em] uppercase" style={{ color: C.muted, fontFamily: MONO }}>{label}</span>
        {required && <span className="text-[11px]" style={{ color: C.late }}>*</span>}
      </span>
      {children}
      {error && <span className="block text-[11px] mt-1" style={{ color: C.late }}>{error}</span>}
    </label>
  );
}

function Card({ title, subtitle, right, children }) {
  return (
    <section className="rounded-lg overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.rule}` }}>
      {(title || right) && (
        <div className="px-4 py-3 flex items-start justify-between gap-3" style={{ borderBottom: `1px solid ${C.rule}` }}>
          <div>
            {title && <div className="text-[11px] tracking-[0.1em] uppercase" style={{ fontFamily: MONO, color: C.muted }}>{title}</div>}
            {subtitle && <div className="text-[12px] mt-0.5" style={{ color: C.muted }}>{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/* The upgrade path is a Stripe Payment Link, not an in-app checkout (§2.4/§3.5).
   "want" is either "paid" (Free hitting a wall) or "expansion" (Paid hitting one). */
function UpgradeNotice({ message, want, isWsAdmin, onDismiss, onSeeBilling, salesContext, hitting }) {
  /* at the ceiling there's nothing left to sell, so the CTA is a conversation */
  const ceiling = want === "ceiling";
  const tint = ceiling ? C.soon : C.accent;
  const cta = ceiling
    ? { label: "Talk to us about more room", icon: Mail }
    : want === "expansion"
      ? { label: `Add Expansion — ${EXPANSION.price}`, url: STRIPE.expansion, icon: ExternalLink }
      : { label: `Upgrade to Paid — ${PLAN_BASE.paid.price}`, url: STRIPE.paid, icon: ExternalLink };
  const Icon = cta.icon;

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md mb-3"
      style={{ background: ceiling ? "#FBF4E6" : "#EDF3F1", border: `1px solid ${tint}33` }}>
      {ceiling ? <Sprout size={14} color={tint} className="shrink-0 mt-0.5" /> : <Zap size={14} color={tint} className="shrink-0 mt-0.5" />}
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] leading-relaxed">{message}</div>
        {isWsAdmin ? (
          <>
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                onClick={() => (ceiling ? contactSales({ ...salesContext, hitting }) : openStripe(cta.url))}
                className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-md font-medium"
                style={{ background: tint, color: "#fff" }}>
                <Icon size={12} /> {cta.label}
              </button>
              <button onClick={onSeeBilling} className="text-[12px] px-2 py-1.5" style={{ color: tint }}>See billing</button>
              <button onClick={onDismiss} className="text-[12px] px-2 py-1.5" style={{ color: C.muted }}>Not now</button>
            </div>
            <div className="text-[11px] mt-1.5" style={{ color: C.muted }}>
              {ceiling
                ? `Opens an email to ${SALES_EMAIL} with your usage filled in. Nothing changes until we've spoken.`
                : "Payment opens in Stripe. Your limits lift once the payment is confirmed."}
            </div>
          </>
        ) : (
          <div className="flex gap-2 mt-2">
            <span className="text-[12px] px-2 py-1.5" style={{ color: C.muted }}>
              {ceiling ? "Your workspace admin can get in touch with us about this." : "Your workspace admin can arrange this."}
            </span>
            <button onClick={onDismiss} className="text-[12px] px-2 py-1.5" style={{ color: C.muted }}>Dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* owner typeahead — matters once a workspace has 20 seats */
function OwnerPicker({ value, members, onChange, error }) {
  const [query, setQuery] = useState("");
  const [openList, setOpenList] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpenList(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const hits = members.filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6);

  return (
    <div ref={box} className="relative">
      <input
        value={openList ? query : value || ""}
        placeholder="Type a name"
        onFocus={() => { setQuery(""); setOpenList(true); }}
        onChange={(e) => { setQuery(e.target.value); setOpenList(true); }}
        className="w-full px-2.5 py-2 text-[13px]" style={error ? errStyle : inputStyle} />
      {openList && (
        <div className="absolute left-0 right-0 top-full mt-1 rounded-md overflow-hidden z-20"
          style={{ background: C.surface, border: `1px solid ${C.rule}`, boxShadow: "0 6px 18px rgba(22,32,43,.12)" }}>
          {hits.length === 0 && <div className="px-2.5 py-2 text-[12px]" style={{ color: C.muted }}>No one matches.</div>}
          {hits.map((m) => (
            <button key={m.email} onClick={() => { onChange(m.name); setOpenList(false); }}
              className="w-full text-left px-2.5 py-2 text-[13px]" style={{ background: m.name === value ? "#F4F7F9" : C.surface }}>
              {m.name}
              <span className="ml-2 text-[11px]" style={{ fontFamily: MONO, color: C.muted }}>{m.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* undo toast */
function Toast({ toast, onUndo, onDismiss }) {
  if (!toast) return null;
  return (
    <div className="fixed left-1/2 bottom-6 z-[60] -translate-x-1/2 flex items-center gap-3 px-3.5 py-2.5 rounded-lg"
      style={{ background: C.ink, color: "#F4F7F9", boxShadow: "0 8px 24px rgba(22,32,43,.28)" }}>
      <span className="text-[13px]">{toast.message}</span>
      {toast.undo && (
        <button onClick={onUndo} className="flex items-center gap-1 text-[12px] px-2 py-1 rounded" style={{ background: "#2A3947" }}>
          <Undo2 size={12} /> Undo
        </button>
      )}
      <button onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}

/* relative time, e.g. "3h ago" — notifications only need coarse granularity */
function timeAgo(iso) {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ── notifications dropdown (anchored under the bell) ────── */
function NotificationPanel({ notes, items, projectName, onOpenItem, onMarkRead, onClose }) {
  const box = useRef(null);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", away);
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onClose]);

  const sorted = [...notes].sort((a, b) => new Date(b.at) - new Date(a.at));
  const unreadIds = notes.filter((n) => !n.read).map((n) => n.id);

  function openNote(n) {
    if (!n.read) onMarkRead([n.id]);
    if (n.itemId) onOpenItem(n.itemId);
    else onClose();
  }

  return (
    <div ref={box} className="absolute right-0 top-full mt-2 w-[320px] max-w-[85vw] rounded-lg overflow-hidden z-30"
      style={{ background: C.surface, border: `1px solid ${C.rule}`, boxShadow: "0 10px 28px rgba(22,32,43,.16)" }}>
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-2" style={{ borderBottom: `1px solid ${C.rule}` }}>
        <span className="text-[11px] tracking-[0.1em] uppercase" style={{ fontFamily: MONO, color: C.muted }}>Notifications</span>
        {unreadIds.length > 0 && (
          <button onClick={() => onMarkRead(unreadIds)} className="text-[11px]" style={{ color: C.accent }}>Mark all read</button>
        )}
      </div>
      <div className="max-h-[360px] overflow-y-auto">
        {sorted.length === 0 && (
          <div className="px-3.5 py-6 text-[12.5px] text-center" style={{ color: C.muted }}>You're all caught up.</div>
        )}
        {sorted.map((n) => {
          const related = items.find((it) => it.id === n.itemId);
          const proj = related ? projectName(related.projectId) : null;
          const Icon = n.type === "mention" ? AtSign : UserCheck;
          const verb = n.type === "mention" ? "mentioned you on" : "assigned you";
          return (
            <button key={n.id} onClick={() => openNote(n)}
              className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5"
              style={{ borderTop: `1px solid ${C.rule}`, background: n.read ? "transparent" : "#F4F7F9" }}>
              <Icon size={13} className="shrink-0 mt-0.5" color={n.read ? C.muted : C.accent} />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] leading-snug">
                  <span className="font-medium">{n.actor}</span> {verb}{n.itemId ? ` ${n.itemId}` : ""}
                  {proj ? <span style={{ color: C.muted }}> · {proj}</span> : null}
                </div>
                {n.snippet && (
                  <div className="text-[11.5px] mt-0.5 truncate" style={{ color: C.muted }}>“{n.snippet}”</div>
                )}
                <div className="text-[10.5px] mt-1" style={{ fontFamily: MONO, color: C.muted }}>{timeAgo(n.at)}</div>
              </div>
              {!n.read && <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: C.accent }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── plan-limit request modal — mirrors UpgradeNotice's want/ceiling logic,
   but as an interstitial when a create action is actually blocked (§3.5) ── */
function LimitRequestModal({ kind, attempted, workspaceName, plan, hasExpansion, limits, projectCount, seatCount, onClose }) {
  const want = upgradePath(plan, hasExpansion);
  const ceiling = want === "ceiling";
  const tint = ceiling ? C.soon : C.accent;
  const cta = ceiling
    ? { label: "Talk to us about more room", icon: Mail }
    : want === "expansion"
      ? { label: `Add Expansion — ${EXPANSION.price}`, url: STRIPE.expansion, icon: ExternalLink }
      : { label: `Upgrade to Paid — ${PLAN_BASE.paid.price}`, url: STRIPE.paid, icon: ExternalLink };
  const Icon = cta.icon;
  const kindLabel = kind === "projects" ? "project" : "seat";
  const cap = kind === "projects" ? limits.projects : limits.seats;
  const used = kind === "projects" ? projectCount : seatCount;
  const salesContext = { workspaceName, plan, hasExpansion, projects: projectCount, seats: seatCount, limits };
  const hitting = kind === "projects" ? "projects" : "seats";

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center px-4" style={{ background: "rgba(22,32,43,.45)" }}>
      <div className="w-full max-w-[400px] rounded-lg p-5" style={{ background: C.surface }}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="text-[14px] font-semibold">
            {kind === "projects" ? "Project limit reached" : "Seat limit reached"}
          </div>
          <button onClick={onClose} aria-label="Close"><X size={15} color={C.muted} /></button>
        </div>
        <div className="text-[13px] leading-relaxed mb-3" style={{ color: C.muted }}>
          {kind === "projects"
            ? <>Adding <span style={{ color: C.ink }}>“{attempted}”</span> would put {workspaceName} over its {cap}-project limit on {limits.label}.</>
            : <>Inviting <span style={{ color: C.ink }}>{attempted}</span> would put {workspaceName} over its {cap}-seat limit on {limits.label}.</>}
        </div>
        <div className="text-[11px] mb-4" style={{ fontFamily: MONO, color: C.muted }}>
          {used} of {cap} {kindLabel}s used
        </div>

        <button
          onClick={() => (ceiling ? contactSales({ ...salesContext, hitting }) : openStripe(cta.url))}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-md text-[13px] font-medium mb-2"
          style={{ background: tint, color: "#fff" }}>
          <Icon size={13} /> {cta.label}
        </button>
        <button onClick={onClose} className="w-full text-[12.5px] py-1.5" style={{ color: C.muted }}>Maybe later</button>
        <div className="text-[11px] mt-2 text-center" style={{ color: C.muted }}>
          {ceiling
            ? `Opens an email to ${SALES_EMAIL} with your usage filled in.`
            : "Payment opens in Stripe. Your limits lift once it's confirmed."}
        </div>
      </div>
    </div>
  );
}

/* ── first-run checklist for a workspace admin — same three
   conditions the parent uses to decide whether to show it at all ── */
function Onboarding({ ws, onGo }) {
  const steps = [
    { done: ws.projects.length > 0, label: "Create your first project", detail: "Projects group the risks, actions, issues, dependencies and decisions you're tracking.", go: "projects", icon: FolderPlus },
    { done: ws.members.length >= 2, label: "Invite your team", detail: "Bring in the people who'll own items and get reminders.", go: "team", icon: Users },
    { done: ws.items.length > 0, label: "Log your first item", detail: "Add a risk, action, issue, dependency or decision to the log.", go: "log", icon: ClipboardList },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card title="Get set up" subtitle={`${doneCount} of ${steps.length} done`}>
      {steps.map((s, idx) => {
        const StepIcon = s.icon;
        return (
          <div key={s.label} className="flex items-center gap-3 px-4 py-3"
            style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}` }}>
            {s.done
              ? <CheckCircle2 size={16} color={C.good} className="shrink-0" />
              : <StepIcon size={16} color={C.muted} className="shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium" style={{ color: s.done ? C.muted : C.ink, textDecoration: s.done ? "line-through" : "none" }}>
                {s.label}
              </div>
              <div className="text-[11.5px]" style={{ color: C.muted }}>{s.detail}</div>
            </div>
            {!s.done && (
              <button onClick={() => onGo(s.go)} className="text-[12px] px-2.5 py-1.5 rounded-md font-medium shrink-0"
                style={{ background: C.accent, color: "#fff" }}>
                Go
              </button>
            )}
          </div>
        );
      })}
    </Card>
  );
}

/* ── project health ───────────────────────────────────── */
function healthOf(items) {
  const live = items.filter((i) => isLive(i.status));
  const overdue = live.filter((i) => dayDelta(i.dueDate) < 0);
  const criticalOverdue = overdue.filter((i) => i.priority === "critical");
  const soon = live.filter((i) => { const n = dayDelta(i.dueDate); return n >= 0 && n <= DUE_SOON_DAYS; });
  /* stale is now measured off updatedAt, not guessed from comment count */
  const stale = live.filter((i) => dayDelta(i.dueDate) < 0 && (Date.now() - new Date(i.updatedAt)) / 86400000 > DUE_SOON_DAYS);
  const noNextStep = live.filter((i) => !i.nextStep?.trim());
  let label = "On track", color = C.good;
  if (live.length === 0) { label = "No signal"; color = C.muted; }
  else if (criticalOverdue.length > 0 || overdue.length >= 3) { label = "At risk"; color = C.late; }
  else if (overdue.length > 0 || soon.length > 0) { label = "Watch"; color = C.soon; }
  return { live, overdue, soon, stale, noNextStep, label, color };
}

function PressureStrip({ live }) {
  const MIN = -21, MAX = 30;
  const pos = (n) => ((Math.max(MIN, Math.min(MAX, n)) - MIN) / (MAX - MIN)) * 100;
  const todayPct = pos(0);
  return (
    <div className="relative h-7 rounded" style={{ background: "#F4F7F9", border: `1px solid ${C.rule}` }}>
      <div className="absolute inset-y-0" style={{ left: 0, width: `${todayPct}%`, background: "#FBEAE8" }} />
      <div className="absolute inset-y-0 w-px" style={{ left: `${todayPct}%`, background: C.ink, opacity: 0.5 }} />
      {live.map((i) => {
        const n = dayDelta(i.dueDate);
        const color = n < 0 ? C.late : n <= DUE_SOON_DAYS ? C.soon : C.muted;
        return (
          <span key={i.id} title={`${i.title} · due ${i.dueDate}`} className="absolute rounded-full"
            style={{ left: `calc(${pos(n)}% - 3px)`, top: "50%", marginTop: -3, width: 6, height: 6,
              background: color, border: i.priority === "critical" ? `1.5px solid ${C.ink}` : "none" }} />
        );
      })}
      <span className="absolute text-[9px] left-1 top-0.5" style={{ fontFamily: MONO, color: C.muted }}>−21d</span>
      <span className="absolute text-[9px] right-1 top-0.5" style={{ fontFamily: MONO, color: C.muted }}>+30d</span>
    </div>
  );
}

/* legend, because the dots rely on tooltips that don't exist on touch */
function StripLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-4 py-2.5 text-[11px]"
      style={{ color: C.muted, borderBottom: `1px solid ${C.rule}`, background: "#F4F7F9" }}>
      <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ background: C.late }} /> past due</span>
      <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ background: C.soon }} /> within {DUE_SOON_DAYS} days</span>
      <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ background: C.muted }} /> later</span>
      <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ border: `1.5px solid ${C.ink}` }} /> critical</span>
      <span className="flex items-center gap-1.5"><span className="w-px h-3" style={{ background: C.ink, opacity: .5 }} /> today</span>
    </div>
  );
}

/* ── validation (§4.2: everything but Final Resolution) ── */
const REQUIRED = [
  ["title", "Title"], ["projectId", "Project"], ["type", "Type"], ["priority", "Priority"],
  ["status", "Status"], ["description", "Description"], ["impact", "Impact"],
  ["nextStep", "Next step"], ["owner", "Owner"], ["dueDate", "Due date"], ["comment", "Opening comment"],
];

function validate(form) {
  const errs = {};
  REQUIRED.forEach(([k, label]) => {
    if (!String(form[k] ?? "").trim()) errs[k] = `${label} is required`;
  });
  return errs;
}

/* ══════════════════════════════════════════════════════
   ROOT — loads one workspace from Supabase and writes back
   through lib/api.js. Caps and permissions are enforced by
   RLS and triggers; what follows only decides what to show.
   ══════════════════════════════════════════════════════ */
export default function RaidLogApp() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [data, setData] = useState(null);        // null = signed in, no workspace
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState("log");
  const [open, setOpen] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState(null);
  const [bellOpen, setBellOpen] = useState(false);
  const toastTimer = useRef(null);

  /* ── session ── */
  useEffect(() => {
    supabase.auth.getSession().then(({ data: d }) => {
      setSession(d.session);
      if (!d.session) setBooting(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) { setData(null); setBooting(false); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  /* ── workspace ── */
  const refresh = useCallback(async () => {
    try {
      setLoadError("");
      const next = await api.loadWorkspace();
      setData(next);
      if (next && open) {
        const fresh = next.items.find((i) => i.id === open.id);
        setOpen(fresh ?? null);
      }
      return next;
    } catch (e) {
      setLoadError(friendly(e, "Couldn't load your workspace."));
      return null;
    } finally {
      setBooting(false);
    }
  }, [open]);

  useEffect(() => { if (session) { setBooting(true); refresh(); } }, [session?.user?.id]);

  /* ── derived ── */
  const ws = data?.workspace ?? null;
  const me = data?.me ?? null;
  const members = data?.members ?? [];
  const isWsAdmin = me?.role === "admin";
  const limits = data?.limits ?? { projects: 1, seats: 5, perProject: 5, projectAdmins: 1, csv: false };

  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
  const memberByName = useMemo(() => Object.fromEntries(members.map((m) => [m.name, m])), [members]);

  const projectRoleFor = useCallback((projectId) => {
    if (!me) return null;
    if (isWsAdmin) return "admin";
    const row = (data?.projectMembers ?? []).find(
      (pm) => pm.project_id === projectId && pm.workspace_member_id === me.id);
    return row?.project_role ?? null;
  }, [data, me, isWsAdmin]);

  const myProjects = (data?.projects ?? []).filter((p) => projectRoleFor(p.id) !== null);
  const myAdminProjects = (data?.projects ?? []).filter((p) => projectRoleFor(p.id) === "admin");
  const myProjectIds = myProjects.map((p) => p.id);
  const projectName = (id) => data?.projects.find((p) => p.id === id)?.name ?? "—";

  /* shape rows the way the presentational components already expect */
  const view_items = useMemo(() => (data?.items ?? [])
    .filter((i) => myProjectIds.includes(i.project_id))
    .map((i) => ({
      ...i,
      projectId: i.project_id,
      nextStep: i.next_step,
      finalResolution: i.final_resolution,
      dueDate: i.due_date,
      remindedAt: i.last_reminder_sent_at,
      snoozedUntil: i.snoozed_until,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      createdBy: memberById[i.created_by]?.name ?? "—",
      updatedBy: memberById[i.updated_by]?.name ?? "—",
      owner: memberById[i.owner_id]?.name ?? "Unassigned",
      ownerId: i.owner_id,
      id: i.ref,
      rowId: i.id,
      comments: (i.comments ?? []).map((c) => ({
        author: memberById[c.author_id]?.name ?? "—",
        text: c.comment_text,
        at: c.created_at,
      })),
    })), [data, myProjectIds.join(","), memberById]);

  const myNotifications = (data?.notifications ?? []).map((n) => ({
    ...n,
    itemId: (data.items.find((i) => i.id === n.raid_item_id) || {}).ref,
    actor: memberById[n.actor_id]?.name ?? "Someone",
    at: n.created_at,
  }));
  const unread = myNotifications.filter((n) => !n.read).length;

  const canEdit = (item) => projectRoleFor(item.projectId) !== null;
  const canDelete = (item) => projectRoleFor(item.projectId) === "admin";

  /* ── toast ── */
  const flash = (message, extra = {}) => setToast({ message, ...extra });
  useEffect(() => {
    if (!toast) return;
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), toast.undo ? UNDO_MS : 4000);
    return () => clearTimeout(toastTimer.current);
  }, [toast]);

  /* ── mutations ── */
  async function run(fn, okMessage) {
    try {
      const out = await fn();
      await refresh();
      if (okMessage) flash(okMessage);
      return out;
    } catch (e) {
      flash(friendly(e));
      throw e;
    }
  }

  async function handleSave(refId, draft) {
    const row = view_items.find((i) => i.id === refId);
    if (!row) return;
    const ownerId = memberByName[draft.owner]?.id ?? row.ownerId;
    const changedOwner = ownerId !== row.ownerId;
    await run(async () => {
      await api.saveItem(row.rowId, { ...draft, ownerId });
      if (changedOwner && ownerId && ownerId !== me.id) {
        await api.notify([{
          workspace_id: ws.id, recipient_id: ownerId, actor_id: me.id,
          raid_item_id: row.rowId, type: "assigned",
        }]);
      }
    }, changedOwner ? `Saved. ${draft.owner} notified.` : "Changes saved.");
  }

  async function handleCreate(form) {
    const ownerId = memberByName[form.owner]?.id ?? me.id;
    await run(async () => {
      const item = await api.createItem(ws.id, { ...form, ownerId }, form.comment, me.id);
      const notes = [];
      if (ownerId !== me.id) {
        notes.push({ workspace_id: ws.id, recipient_id: ownerId, actor_id: me.id,
                     raid_item_id: item.id, type: "assigned" });
      }
      findMentions(form.comment || "", members)
        .filter((m) => m.id !== me.id)
        .forEach((m) => notes.push({
          workspace_id: ws.id, recipient_id: m.id, actor_id: me.id,
          raid_item_id: item.id, type: "mention", snippet: form.comment.trim().slice(0, 140),
        }));
      await api.notify(notes);
    }, "Item logged.");
  }

  async function handleComment(item, text) {
    await run(async () => {
      await api.addComment(item.rowId, text, me.id);
      const mentioned = findMentions(text, members).filter((m) => m.id !== me.id);
      await api.notify(mentioned.map((m) => ({
        workspace_id: ws.id, recipient_id: m.id, actor_id: me.id,
        raid_item_id: item.rowId, type: "mention", snippet: text.trim().slice(0, 140),
      })));
      if (mentioned.length) flash(`${mentioned.map((m) => m.name).join(", ")} notified.`);
    });
  }

  async function handleRemind(item) {
    await run(() => api.markReminded(item.rowId));
    sendReminder(item, members, projectName(item.projectId));
  }

  const handleSnooze = (item) => run(() => api.snoozeItem(item.rowId, SNOOZE_DAYS), `Snoozed ${SNOOZE_DAYS} days.`);

  async function handleDelete(item) {
    setConfirm(null); setOpen(null);
    await run(() => api.deleteItem(item.rowId), `${item.id} deleted.`);
  }

  /* ── gates ── */
  if (booting) return <Splash label="Loading your workspace…" />;
  if (!session) return <SignIn />;
  if (loadError) return <Splash label={loadError} error onRetry={refresh} />;
  if (!data) return <Bootstrap email={session.user.email} onDone={refresh} onSignOut={() => api.signOut()} />;

  const NAV = isWsAdmin
    ? [
        { id: "log", label: "Log", icon: ClipboardList },
        { id: "status", label: "Delivery status", icon: Activity },
        { id: "projects", label: "Projects", icon: FolderPlus },
        { id: "team", label: "Team", icon: Users },
        { id: "billing", label: "Billing", icon: CreditCard },
      ]
    : [
        { id: "mine", label: "My work", icon: UserCheck },
        { id: "log", label: "All items", icon: ClipboardList },
        ...(myAdminProjects.length > 0 ? [{ id: "projectTeam", label: "Project team", icon: Users }] : []),
      ];

  const planLabel = ws.plan === "paid" ? (ws.has_expansion_addon ? "Paid + Expansion" : "Paid") : "Free";

  const shared = {
    ws, items: view_items, projects: myProjects, projectName, members,
    me: me.name, myEmail: me.email, limits, plan: ws.plan,
    hasExpansion: ws.has_expansion_addon, workspaceName: ws.name,
    canEdit, canDelete, isWsAdmin,
    onOpen: setOpen, onRemind: handleRemind, onSnooze: handleSnooze,
    onCreate: handleCreate, onUpgrade: () => setView("billing"), onGoTo: setView,
    onExport: async (filename) => {
      try {
        const rows = await api.exportLog();
        downloadCSV(rows, filename);
      } catch (e) { flash(friendly(e)); }
    },
  };

  const needsOnboarding = isWsAdmin &&
    (data.projects.length === 0 || members.length < 2 || data.items.length === 0);

  return (
    <div className="w-full min-h-screen" style={{ background: C.paper, color: C.ink, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style>{`
        .row:hover, .wl:hover { background: #F4F7F9; }
        input:focus, select:focus, textarea:focus { outline: 2px solid ${C.accent}; outline-offset: -1px; }
        @media (prefers-reduced-motion: no-preference) { .row, .wl { transition: background .12s ease; } }
      `}</style>

      <header style={{ borderBottom: `1px solid ${C.rule}`, background: C.surface }}>
        <div className="max-w-[1180px] mx-auto px-5 pt-3.5 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2.5 min-w-0">
            <span className="text-[15px] font-semibold tracking-[-0.01em] truncate">{ws.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
              style={{ fontFamily: MONO, background: ws.plan === "free" ? "#F4F7F9" : "#EDF3F1", color: ws.plan === "free" ? C.muted : C.accent }}>
              {planLabel}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="relative">
              <button onClick={() => setBellOpen((v) => !v)} className="flex items-center gap-1 px-2 py-1.5 rounded-md relative"
                style={{ color: unread ? C.accent : C.muted }} aria-label={`${unread} unread notifications`}>
                <Bell size={15} />
                {unread > 0 && (
                  <span className="absolute -top-0.5 right-0 min-w-[15px] h-[15px] px-1 rounded-full flex items-center justify-center text-[9px] font-semibold"
                    style={{ background: C.late, color: "#fff", fontFamily: MONO }}>{unread}</span>
                )}
              </button>
              {bellOpen && (
                <NotificationPanel notes={myNotifications} items={view_items} projectName={projectName}
                  onOpenItem={(ref) => { const it = view_items.find((i) => i.id === ref); if (it) { setOpen(it); setBellOpen(false); } }}
                  onMarkRead={(ids) => run(() => api.markRead(ids))} onClose={() => setBellOpen(false)} />
              )}
            </div>
            <span className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
              style={{ fontFamily: MONO, background: isWsAdmin ? "#EDF3F1" : "#F4F7F9", color: isWsAdmin ? C.accent : C.muted }}>
              {isWsAdmin ? <ShieldCheck size={11} /> : <UserCheck size={11} />}
              {isWsAdmin ? "Workspace admin" : "User"}
            </span>
            <span className="text-[12px] hidden md:block" style={{ color: C.muted }}>{me.name}</span>
            <button onClick={() => api.signOut()} className="flex items-center gap-1 text-[12px] px-2 py-1 rounded" style={{ color: C.muted }}>
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>
        <nav className="max-w-[1180px] mx-auto px-5 flex gap-1 mt-2.5 overflow-x-auto">
          {NAV.map((n) => {
            const on = view === n.id; const Icon = n.icon;
            return (
              <button key={n.id} onClick={() => setView(n.id)} className="flex items-center gap-1.5 px-3 py-2 text-[13px] whitespace-nowrap"
                style={{ color: on ? C.ink : C.muted, fontWeight: on ? 600 : 400, borderBottom: `2px solid ${on ? C.accent : "transparent"}` }}>
                <Icon size={14} /> {n.label}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="max-w-[1180px] mx-auto px-5 py-5">
        {needsOnboarding && view !== "billing" && (
          <Onboarding ws={{ projects: data.projects, members, items: data.items }} onGo={setView} />
        )}

        {view === "mine" && <MyWorkView {...shared} onGoToAll={() => setView("log")} />}
        {view === "log" && <LogView {...shared} />}
        {view === "projectTeam" && myAdminProjects.length > 0 && (
          <ProjectTeamView adminProjects={myAdminProjects} members={members}
            projectMembers={data.projectMembers} limits={limits} items={view_items}
            projectName={projectName}
            onSetRole={(pid, mid, role) => run(() => api.setProjectRole(pid, mid, role, me.id))} />
        )}
        {view === "status" && isWsAdmin && <StatusView {...shared} />}
        {view === "projects" && isWsAdmin && (
          <ProjectsView projects={data.projects} items={view_items} members={members}
            projectMembers={data.projectMembers} limits={limits} plan={ws.plan}
            hasExpansion={ws.has_expansion_addon} workspaceName={ws.name}
            onAdd={(name) => run(() => api.addProject(ws.id, name))}
            onDelete={(id) => run(() => api.deleteProject(id))}
            onSetRole={(pid, mid, role) => run(() => api.setProjectRole(pid, mid, role, me.id))}
            onUpgrade={() => setView("billing")} />
        )}
        {view === "team" && isWsAdmin && (
          <TeamView members={members} items={view_items} myEmail={me.email}
            projectMembers={data.projectMembers} limits={limits} plan={ws.plan}
            hasExpansion={ws.has_expansion_addon} workspaceName={ws.name}
            projectCount={data.projects.length}
            onInvite={(email, name) => run(() => api.inviteMember(ws.id, email, name))}
            onSetRole={(id, role) => run(() => api.setWorkspaceRole(id, role))}
            onRemove={(id) => run(() => api.removeMember(id))}
            onUpgrade={() => setView("billing")} />
        )}
        {view === "billing" && isWsAdmin && (
          <BillingView ws={ws} limits={limits} projectCount={data.projects.length} seatCount={members.length} />
        )}
      </div>

      {open && (
        <Detail item={open} members={members} projectName={projectName(open.projectId)}
          canEdit={canEdit(open)} canDelete={canDelete(open)} me={me.name}
          onClose={() => setOpen(null)} onSave={handleSave} onComment={handleComment}
          onRemind={handleRemind} onSnooze={handleSnooze} onDelete={() => setConfirm(open)}
          onCopied={() => flash("Link copied.")} />
      )}

      {confirm && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center px-4" style={{ background: "rgba(22,32,43,.45)" }}>
          <div className="w-full max-w-[360px] rounded-lg p-5" style={{ background: C.surface }}>
            <div className="text-[14px] font-semibold mb-1.5">Are you sure?</div>
            <div className="text-[13px] mb-4" style={{ color: C.muted }}>
              “{confirm.title}” and its whole comment history will be removed. This can't be undone.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className="px-3 py-2 text-[13px]" style={{ color: C.muted }}>Keep it</button>
              <button onClick={() => handleDelete(confirm)} className="px-3.5 py-2 rounded-md text-[13px] font-medium"
                style={{ background: C.late, color: "#fff" }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <Toast toast={toast} onUndo={() => {}} onDismiss={() => setToast(null)} />
    </div>
  );
}

/* ══ SPLASH ═══════════════════════════════════════════ */
function Splash({ label, error, onRetry }) {
  return (
    <div className="w-full min-h-screen flex items-center justify-center px-4"
      style={{ background: C.paper, color: C.ink, fontFamily: "system-ui, sans-serif" }}>
      <div className="text-center">
        <div className="text-[15px] font-semibold mb-1">RAID Log</div>
        <div className="text-[13px] mb-3" style={{ color: error ? C.late : C.muted }}>{label}</div>
        {onRetry && (
          <button onClick={onRetry} className="text-[13px] px-3 py-2 rounded-md" style={inputStyle}>Try again</button>
        )}
      </div>
    </div>
  );
}

/* ══ SIGN IN — magic link, no passwords ═══════════════ */
function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");   // idle | sending | sent
  const [error, setError] = useState("");

  async function submit() {
    const e = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setError("Enter a full email address."); return; }
    setState("sending"); setError("");
    try { await api.sendMagicLink(e); setState("sent"); }
    catch (err) { setError(friendly(err, "Couldn't send the link.")); setState("idle"); }
  }

  return (
    <div className="w-full min-h-screen flex items-center justify-center px-4"
      style={{ background: C.paper, color: C.ink, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style>{`input:focus { outline: 2px solid ${C.accent}; outline-offset: -1px; }`}</style>
      <div className="w-full max-w-[380px]">
        <div className="mb-5">
          <div className="text-[19px] font-semibold tracking-[-0.01em] mb-1">RAID Log</div>
          <div className="text-[13px]" style={{ color: C.muted }}>
            Risks, actions, issues, dependencies and decisions, in one place your team can actually find.
          </div>
        </div>

        <div className="rounded-lg p-5" style={{ background: C.surface, border: `1px solid ${C.rule}` }}>
          {state === "sent" ? (
            <div className="text-center py-4">
              <CheckCircle2 size={22} color={C.good} className="mx-auto mb-2.5" />
              <div className="text-[14px] font-semibold mb-1">Check your inbox</div>
              <div className="text-[13px] leading-relaxed mb-3" style={{ color: C.muted }}>
                We've sent a sign-in link to <span style={{ fontFamily: MONO }}>{email.trim()}</span>.
                It works once and expires shortly.
              </div>
              <button onClick={() => { setState("idle"); setEmail(""); }} className="text-[12px]" style={{ color: C.accent }}>
                Use a different address
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Field label="Email" required>
                <input value={email} onChange={(e) => { setEmail(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="name@company.com" autoComplete="email" autoFocus
                  className="w-full px-2.5 py-2 text-[13px]" style={error ? errStyle : inputStyle} />
              </Field>
              {error && (
                <div className="flex items-start gap-1.5 text-[12px]" style={{ color: C.late }}>
                  <AlertCircle size={13} className="shrink-0 mt-0.5" /> {error}
                </div>
              )}
              <button onClick={submit} disabled={state === "sending"}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-md text-[13px] font-medium"
                style={{ background: state === "sending" ? C.rule : C.accent, color: "#fff" }}>
                <Lock size={14} /> {state === "sending" ? "Sending…" : "Email me a sign-in link"}
              </button>
              <div className="text-[11.5px] leading-relaxed" style={{ color: C.muted }}>
                No password to remember. If nobody has invited this address yet, you'll start
                a new workspace on the Free plan.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══ BOOTSTRAP — signed in, no workspace yet ══════════ */
function Bootstrap({ email, onDone, onSignOut }) {
  const [name, setName] = useState("");
  const [display, setDisplay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (!name.trim()) return;
    setBusy(true); setError("");
    try { await api.createWorkspace(name, display); await onDone(); }
    catch (e) { setError(friendly(e, "Couldn't create the workspace.")); setBusy(false); }
  }

  return (
    <div className="w-full min-h-screen flex items-center justify-center px-4"
      style={{ background: C.paper, color: C.ink, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style>{`input:focus { outline: 2px solid ${C.accent}; outline-offset: -1px; }`}</style>
      <div className="w-full max-w-[380px]">
        <div className="mb-5">
          <div className="text-[19px] font-semibold tracking-[-0.01em] mb-1">Name your workspace</div>
          <div className="text-[13px]" style={{ color: C.muted }}>
            No one has invited <span style={{ fontFamily: MONO }}>{email}</span> to an existing log, so this starts a new one.
          </div>
        </div>
        <div className="rounded-lg p-5" style={{ background: C.surface, border: `1px solid ${C.rule}` }}>
          <div className="flex flex-col gap-3">
            <Field label="Workspace name" required>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                onKeyDown={(e) => e.key === "Enter" && create()}
                placeholder="Usually your company or team name"
                className="w-full px-2.5 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Your name">
              <input value={display} onChange={(e) => setDisplay(e.target.value)}
                placeholder="Shown on items you own"
                className="w-full px-2.5 py-2 text-[13px]" style={inputStyle} />
            </Field>
            {error && <div className="text-[12px]" style={{ color: C.late }}>{error}</div>}
            <div className="flex items-start gap-2 p-2.5 rounded-md text-[12px] leading-relaxed" style={{ background: "#EDF3F1", color: C.accent }}>
              <ShieldCheck size={14} className="shrink-0 mt-0.5" />
              <span>You'll be this workspace's admin, on the Free plan: 1 project and 5 people.</span>
            </div>
            <button onClick={create} disabled={!name.trim() || busy}
              className="py-2.5 rounded-md text-[13px] font-medium"
              style={{ background: name.trim() && !busy ? C.accent : C.rule, color: "#fff" }}>
              {busy ? "Creating…" : "Create workspace"}
            </button>
            <button onClick={onSignOut} className="text-[12px] py-1" style={{ color: C.muted }}>Use a different email</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══ EXPORT BUTTON ════════════════════════════════════ */
function ExportButton({ limits, filename = "raid-log.csv", onExport, onBlocked }) {
  if (limits.csv) {
    return (
      <button onClick={() => onExport(filename)} title="Download the whole log as CSV"
        className="flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px]" style={inputStyle}>
        <Download size={14} /> Export all
      </button>
    );
  }
  return (
    <button onClick={onBlocked} title="CSV export comes with the Paid plan"
      className="flex items-center gap-1.5 h-9 px-3 rounded-md text-[13px]" style={{ ...inputStyle, color: C.muted, borderStyle: "dashed" }}>
      <Lock size={13} /> Export all
    </button>
  );
}

/* ══ ITEM FORM — validates every required field ════════ */
function ItemForm({ projects, members, me, onCancel, onSubmit }) {
  const [form, setForm] = useState({
    type: "risk", projectId: projects[0]?.id ?? "", priority: "medium", status: "open",
    title: "", description: "", impact: "", nextStep: "", comment: "", finalResolution: "",
    owner: me, dueDate: shift(7),
  });
  const [errors, setErrors] = useState({});
  const [tried, setTried] = useState(false);
  const set = (k, v) => { setForm({ ...form, [k]: v }); if (tried) setErrors(validate({ ...form, [k]: v })); };

  const mentioned = findMentions(form.comment, members).filter((m) => m.name !== me);
  const ownerIsSomeoneElse = form.owner && form.owner !== me;

  function submit() {
    const errs = validate(form);
    setErrors(errs); setTried(true);
    if (Object.keys(errs).length) return;
    onSubmit(form);
  }

  return (
    <div className="rounded-lg p-4 mb-3" style={{ background: C.surface, border: `1px solid ${C.rule}` }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[13px] font-semibold">New item</span>
        <button onClick={onCancel} aria-label="Close"><X size={15} color={C.muted} /></button>
      </div>

      <div className="mb-3">
        <Field label="Title" required error={errors.title}>
          <input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="One line, plainly stated"
            className="w-full px-2.5 py-2 text-[13px]" style={errors.title ? errStyle : inputStyle} />
        </Field>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Field label="Type" required>
          <select value={form.type} onChange={(e) => set("type", e.target.value)} className="w-full px-2 py-2 text-[13px]" style={inputStyle}>
            {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Project" required error={errors.projectId}>
          <select value={form.projectId} onChange={(e) => set("projectId", e.target.value)} className="w-full px-2 py-2 text-[13px]" style={errors.projectId ? errStyle : inputStyle}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Priority" required>
          <select value={form.priority} onChange={(e) => set("priority", e.target.value)} className="w-full px-2 py-2 text-[13px]" style={inputStyle}>
            {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Owner" required error={errors.owner}>
          <OwnerPicker value={form.owner} members={members} onChange={(v) => set("owner", v)} error={errors.owner} />
        </Field>
        <Field label="Due date" required error={errors.dueDate}>
          <input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)}
            className="w-full px-2 py-2 text-[13px]" style={errors.dueDate ? errStyle : inputStyle} />
        </Field>
        <Field label="Status" required>
          <select value={form.status} onChange={(e) => set("status", e.target.value)} className="w-full px-2 py-2 text-[13px]" style={inputStyle}>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        {[["description", "Description"], ["impact", "Impact"], ["nextStep", "Next step"]].map(([k, l]) => (
          <Field key={k} label={l} required error={errors[k]}>
            <textarea rows={2} value={form[k]} onChange={(e) => set(k, e.target.value)}
              className="w-full px-2.5 py-2 text-[13px]" style={errors[k] ? errStyle : inputStyle} />
          </Field>
        ))}
      </div>

      <div className="mb-3">
        <Field label="Opening comment" required error={errors.comment}>
          <MentionInput value={form.comment} onChange={(v) => set("comment", v)} members={members}
            placeholder="Where this stands today. Type @ to tag someone." rows={2} error={errors.comment} />
        </Field>
      </div>

      {(ownerIsSomeoneElse || mentioned.length > 0) && (
        <div className="flex items-start gap-2 mb-3 px-2.5 py-2 rounded-md text-[12px]" style={{ background: "#EDF3F1", color: C.accent }}>
          <Bell size={13} className="shrink-0 mt-0.5" />
          <span>
            On save we'll notify{" "}
            {[ownerIsSomeoneElse ? `${form.owner} (assigned)` : null, ...mentioned.map((m) => `${m.name} (mentioned)`)]
              .filter(Boolean).join(", ")}.
          </span>
        </div>
      )}

      {tried && Object.keys(errors).length > 0 && (
        <div className="flex items-start gap-1.5 mb-3 text-[12px]" style={{ color: C.late }}>
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          {Object.keys(errors).length} field{Object.keys(errors).length === 1 ? "" : "s"} still needed. Everything except Final resolution is required.
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-2 text-[13px]" style={{ color: C.muted }}>Cancel</button>
        <button onClick={submit} className="px-3.5 py-2 rounded-md text-[13px] font-medium" style={{ background: C.accent, color: "#fff" }}>Add to log</button>
      </div>
    </div>
  );
}

/* ══ MENTION INPUT ════════════════════════════════════ */
function MentionInput({ value, onChange, members, placeholder, rows = 1, error, onSubmitKey }) {
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const wrap = useRef(null);

  useEffect(() => {
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setPicker(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  function handle(next) {
    onChange(next);
    const at = next.lastIndexOf("@");
    if (at === -1) { setPicker(false); return; }
    const after = next.slice(at + 1);
    /* keep the picker open while the fragment could still be part of a name */
    if (after.length <= 20 && !after.includes("\n")) { setQuery(after); setPicker(true); }
    else setPicker(false);
  }

  function pick(m) {
    const at = value.lastIndexOf("@");
    onChange(value.slice(0, at) + "@" + m.name + " ");
    setPicker(false);
    ref.current?.focus();
  }

  const hits = members.filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 5);

  return (
    <div ref={wrap} className="relative">
      <textarea ref={ref} rows={rows} value={value} placeholder={placeholder}
        onChange={(e) => handle(e.target.value)}
        onKeyDown={(e) => {
          if (picker && e.key === "Escape") { setPicker(false); e.stopPropagation(); }
          if (onSubmitKey && e.key === "Enter" && !e.shiftKey && !picker) { e.preventDefault(); onSubmitKey(); }
        }}
        className="w-full px-2.5 py-2 text-[13px] resize-y" style={error ? errStyle : inputStyle} />
      {picker && hits.length > 0 && (
        <div className="absolute left-0 right-0 bottom-full mb-1 rounded-md overflow-hidden z-30"
          style={{ background: C.surface, border: `1px solid ${C.rule}`, boxShadow: "0 -6px 18px rgba(22,32,43,.12)" }}>
          <div className="px-2.5 py-1.5 text-[10px] tracking-[0.1em] uppercase" style={{ fontFamily: MONO, color: C.muted, borderBottom: `1px solid ${C.rule}` }}>
            Tag a teammate
          </div>
          {hits.map((m) => (
            <button key={m.email} onClick={() => pick(m)} className="w-full text-left px-2.5 py-1.5 text-[13px] flex items-center gap-2">
              <AtSign size={12} color={C.accent} className="shrink-0" />
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* §4.3 priority as a colour-coded badge */
function PriorityBadge({ priority }) {
  const p = PRIORITY[priority];
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap"
      style={{ background: `${p.tick}18`, color: p.tick }}>
      {p.label}
    </span>
  );
}

function DueStamp({ item, align = "right" }) {
  const n = dayDelta(item.dueDate);
  const live = isLive(item.status);
  const late = live && n < 0;
  const soon = live && n >= 0 && n <= DUE_SOON_DAYS;
  return (
    <div style={{ textAlign: align }}>
      <div className="text-[12px]" style={{ fontFamily: MONO, color: late ? C.late : soon ? C.soon : C.muted }}>{item.dueDate}</div>
      {live && (late || soon) && (
        <div className="text-[11px] mt-0.5" style={{ fontFamily: MONO, color: late ? C.late : C.soon }}>{deltaLabel(n)}</div>
      )}
    </div>
  );
}

/* ══ ITEM ROW — table row on desktop, stacked card on mobile (§4.3) ══ */
function ItemRow({ item, idx, projectName, onOpen, showOwner }) {
  const n = dayDelta(item.dueDate);
  const live = isLive(item.status);
  const late = live && n < 0;
  const soon = live && n >= 0 && n <= DUE_SOON_DAYS;
  const snoozed = item.snoozedUntil && dayDelta(item.snoozedUntil) >= 0;
  /* §4.4 the same overdue / due-soon signal shows on the log row */
  const edge = late ? C.late : soon ? C.soon : PRIORITY[item.priority].tick;

  const SnoozeTag = () => snoozed ? (
    <span className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1" style={{ fontFamily: MONO, background: "#F4F7F9", color: C.muted }}>
      <Clock size={9} /> snoozed
    </span>
  ) : null;

  return (
    <>
      {/* desktop row */}
      <div onClick={() => onOpen(item)} className="row hidden sm:flex gap-3 px-4 py-3 cursor-pointer"
        style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}`, opacity: live ? 1 : 0.6 }}>
        <span className="w-[3px] rounded-full shrink-0" style={{ background: edge }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <TypeTag type={item.type} />
            <PriorityBadge priority={item.priority} />
            <span className="text-[13px] font-medium">{item.title}</span>
            <SnoozeTag />
          </div>
          <div className="text-[11px] flex flex-wrap gap-x-2.5 gap-y-1" style={{ color: C.muted }}>
            <span style={{ fontFamily: MONO }}>{item.id}</span>
            <span>{projectName(item.projectId)}</span>
            {showOwner && <span>{item.owner}</span>}
            <span>{STATUS[item.status]}</span>
            <span>{item.updatedBy} · {ago(item.updatedAt)}</span>
            {!item.nextStep?.trim() && live && <span style={{ color: C.late }}>Needs a next step</span>}
          </div>
        </div>
        <DueStamp item={item} />
      </div>

      {/* mobile card */}
      <div onClick={() => onOpen(item)} className="sm:hidden px-4 py-3 cursor-pointer"
        style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}`, borderLeft: `3px solid ${edge}`, opacity: live ? 1 : 0.6 }}>
        <div className="flex items-start justify-between gap-2 mb-2">
          <span className="text-[13.5px] font-medium leading-snug">{item.title}</span>
          <PriorityBadge priority={item.priority} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <TypeTag type={item.type} />
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ fontFamily: MONO, background: "#F4F7F9", color: C.muted }}>
            {STATUS[item.status]}
          </span>
          <SnoozeTag />
        </div>
        <div className="flex items-end justify-between gap-2">
          <div className="text-[11px] min-w-0" style={{ color: C.muted }}>
            <div className="truncate">{projectName(item.projectId)}{showOwner ? ` · ${item.owner}` : ""}</div>
            <div style={{ fontFamily: MONO }}>{item.id} · {ago(item.updatedAt)}</div>
            {!item.nextStep?.trim() && live && <div style={{ color: C.late }}>Needs a next step</div>}
          </div>
          <DueStamp item={item} />
        </div>
      </div>
    </>
  );
}

/* ══ DETAIL DRAWER — edits go into a draft, Save commits ══ */
function Detail({ item, members, projectName, canEdit, canDelete, me, onClose, onSave, onComment, onRemind, onSnooze, onDelete, onCopied }) {
  const [draft, setDraft] = useState(item);
  const [comment, setComment] = useState("");
  const [copied, setCopied] = useState(false);
  const panel = useRef(null);

  /* re-sync when a different item is opened, or after a save */
  useEffect(() => { setDraft(item); }, [item.id, item.updatedAt]);

  const dirty = ["status", "priority", "owner", "dueDate", "type", "title", "description", "impact", "nextStep", "finalResolution"]
    .some((k) => (draft[k] ?? "") !== (item[k] ?? ""));

  /* closing with unsaved work asks once, inline — no blocking dialog,
     since confirm() is unreliable inside sandboxed frames */
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    const esc = (e) => {
      if (e.key !== "Escape") return;
      if (dirty) { setConfirmClose(true); return; }
      onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [dirty, onClose]);

  const set = (k, v) => setDraft({ ...draft, [k]: v });
  const ownerChanged = draft.owner !== item.owner;
  const mentioned = findMentions(comment, members).filter((m) => m.name !== me);
  const snoozed = item.snoozedUntil && dayDelta(item.snoozedUntil) >= 0;

  function copyLink() {
    const link = `${window.location.origin || "https://raidlog.app"}/#item=${item.id}`;
    try {
      navigator.clipboard?.writeText(link);
      setCopied(true); onCopied();
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — nothing useful to do */ }
  }

  function tryClose() {
    if (dirty) { setConfirmClose(true); return; }
    onClose();
  }

  const ro = { ...inputStyle, background: "#F4F7F9", color: C.muted };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" style={{ background: "rgba(22,32,43,.35)" }} onClick={tryClose}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={`${item.id} detail`}
        onClick={(e) => e.stopPropagation()} className="w-full max-w-[460px] h-full overflow-y-auto"
        style={{ background: C.surface, borderLeft: `1px solid ${C.rule}` }}>

        {confirmClose && (
          <div className="sticky top-0 z-10 px-4 py-3 flex flex-wrap items-center gap-2"
            style={{ background: "#FBF4E6", borderBottom: `1px solid ${C.rule}` }}>
            <span className="text-[12.5px] flex-1 min-w-[160px]" style={{ color: C.soon }}>
              You have unsaved changes.
            </span>
            <button onClick={() => { onSave(item.id, draft); setConfirmClose(false); }}
              className="text-[12px] px-2.5 py-1.5 rounded-md font-medium" style={{ background: C.accent, color: "#fff" }}>
              Save and close
            </button>
            <button onClick={onClose} className="text-[12px] px-2.5 py-1.5 rounded-md" style={{ ...inputStyle, color: C.late }}>
              Discard
            </button>
            <button onClick={() => setConfirmClose(false)} className="text-[12px] px-2 py-1.5" style={{ color: C.muted }}>
              Keep editing
            </button>
          </div>
        )}

        <div className="p-6 pb-3">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <TypeTag type={item.type} />
              {snoozed && (
                <span className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1" style={{ fontFamily: MONO, background: "#F4F7F9", color: C.muted }}>
                  <Clock size={9} /> until {item.snoozedUntil}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={copyLink} className="p-1.5 rounded" title="Copy a link to this item" style={{ color: copied ? C.good : C.muted }}>
                {copied ? <CheckCircle2 size={15} /> : <Link2 size={15} />}
              </button>
              <button onClick={tryClose} aria-label="Close"><X size={17} color={C.muted} /></button>
            </div>
          </div>

          <div className="text-[11px] mb-1" style={{ fontFamily: MONO, color: C.muted }}>{item.id} · {projectName}</div>
          {canEdit ? (
            <textarea rows={2} value={draft.title} onChange={(e) => set("title", e.target.value)}
              className="w-full text-[17px] font-semibold leading-snug mb-2 px-2 py-1 resize-none"
              style={{ ...inputStyle, borderColor: draft.title !== item.title ? C.accent : C.rule }} />
          ) : (
            <h2 className="text-[17px] font-semibold leading-snug mb-2">{item.title}</h2>
          )}

          {/* audit line — created / last updated */}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] mb-4" style={{ color: C.muted }}>
            <span>Created by {item.createdBy} · {ago(item.createdAt)}</span>
            <span style={{ fontWeight: 500, color: C.ink }}>Last updated by {item.updatedBy} · {ago(item.updatedAt)}</span>
          </div>

          {!canEdit && (
            <div className="flex items-start gap-2 mb-4 p-2.5 rounded-md text-[12px]" style={{ background: "#F4F7F9", color: C.muted }}>
              <Eye size={13} className="shrink-0 mt-0.5" />
              <span>You're not on {projectName}, so this is read-only.</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            <Field label="Status">
              <select value={draft.status} disabled={!canEdit} onChange={(e) => set("status", e.target.value)}
                className="w-full px-2 py-1.5 text-[13px]" style={canEdit ? inputStyle : ro}>
                {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={draft.priority} disabled={!canEdit} onChange={(e) => set("priority", e.target.value)}
                className="w-full px-2 py-1.5 text-[13px]" style={canEdit ? inputStyle : ro}>
                {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Owner">
              {canEdit
                ? <OwnerPicker value={draft.owner} members={members} onChange={(v) => set("owner", v)} />
                : <input value={item.owner} readOnly className="w-full px-2.5 py-2 text-[13px]" style={ro} />}
            </Field>
            <Field label="Due date">
              <input type="date" value={draft.dueDate} disabled={!canEdit} onChange={(e) => set("dueDate", e.target.value)}
                className="w-full px-2 py-1.5 text-[13px]" style={canEdit ? inputStyle : ro} />
            </Field>
          </div>

          {/* §9.2 is unresolved, so we prompt rather than auto-setting Status */}
          {canEdit && draft.finalResolution?.trim() && isLive(draft.status) && (
            <div className="flex items-start gap-2 mb-3.5 px-2.5 py-2 rounded-md text-[12px]" style={{ background: "#FBF4E6", color: C.soon }}>
              <Info size={13} className="shrink-0 mt-0.5" />
              <span className="flex-1">There's a final resolution here but the status is still {STATUS[draft.status].toLowerCase()}.</span>
              <button onClick={() => set("status", "resolved")} className="shrink-0 text-[11.5px] px-2 py-1 rounded font-medium"
                style={{ background: C.soon, color: "#fff" }}>
                Set resolved
              </button>
            </div>
          )}

          {[["description", "Description"], ["impact", "Impact"], ["nextStep", "Next step"], ["finalResolution", "Final resolution"]].map(([k, l]) => (
            <div className="mb-3.5" key={k}>
              <Field label={l}>
                {canEdit ? (
                  <textarea rows={2} value={draft[k] || ""} onChange={(e) => set(k, e.target.value)}
                    placeholder={k === "finalResolution" ? "Fill in once this is resolved or closed" : "Not recorded yet"}
                    className="w-full px-2.5 py-2 text-[13px]"
                    style={{ ...inputStyle, borderColor: (draft[k] ?? "") !== (item[k] ?? "") ? C.accent : (!draft[k]?.trim() && k === "nextStep" ? C.late : C.rule) }} />
                ) : (
                  <div className="text-[13px] leading-relaxed">{item[k]?.trim() || "—"}</div>
                )}
              </Field>
            </div>
          ))}

          {/* save bar */}
          {canEdit && (
            <div className="sticky bottom-0 pt-3 pb-1" style={{ background: C.surface }}>
              {ownerChanged && (
                <div className="flex items-start gap-2 mb-2 px-2.5 py-2 rounded-md text-[12px]" style={{ background: "#EDF3F1", color: C.accent }}>
                  <Bell size={13} className="shrink-0 mt-0.5" />
                  <span>Saving will notify {draft.owner} that this is now theirs.</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button onClick={() => onSave(item.id, draft)} disabled={!dirty}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-md text-[13px] font-medium"
                  style={{ background: dirty ? C.accent : C.rule, color: "#fff", cursor: dirty ? "pointer" : "not-allowed" }}>
                  <Save size={14} /> {dirty ? "Save changes" : "Saved"}
                </button>
                {dirty && (
                  <button onClick={() => setDraft(item)} className="px-3 py-2.5 rounded-md text-[13px]" style={{ ...inputStyle, color: C.muted }}>
                    Discard
                  </button>
                )}
              </div>
              {dirty && (
                <div className="text-[11px] mt-1.5 text-center" style={{ color: C.soon }}>
                  Unsaved changes — the outlined fields are the ones you've touched.
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 mt-4 mb-1">
            <button onClick={() => onRemind(item)} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-[13px]" style={{ ...inputStyle, color: C.accent }}>
              <Mail size={14} /> {item.owner === me ? "Email myself" : "Send reminder"}
            </button>
            {canEdit && !snoozed && (
              <button onClick={() => onSnooze(item)} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-[13px]" style={{ ...inputStyle, color: C.muted }}
                title={`Hide from the watchlist for ${SNOOZE_DAYS} days`}>
                <Clock size={14} /> Snooze
              </button>
            )}
            {canDelete && (
              <button onClick={onDelete} className="px-3 rounded-md" style={{ ...inputStyle, color: C.late }} aria-label="Delete item">
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {item.remindedAt && (
            <div className="text-[11px] mb-3" style={{ color: C.muted, fontFamily: MONO }}>reminder sent {ago(item.remindedAt)}</div>
          )}
          {!canDelete && canEdit && (
            <div className="flex items-start gap-2 mb-3 p-2.5 rounded-md text-[12px]" style={{ background: "#F4F7F9", color: C.muted }}>
              <Info size={13} className="shrink-0 mt-0.5" />
              <span>You can edit anything here. Only a project admin on {projectName} can delete it.</span>
            </div>
          )}
        </div>

        {/* comments — append only, with @mentions */}
        <div className="px-6 pb-6 pt-4" style={{ borderTop: `1px solid ${C.rule}` }}>
          <div className="flex items-center gap-1.5 text-[13px] font-medium mb-3">
            <MessageSquare size={14} /> Comments
            <span className="text-[11px] font-normal" style={{ color: C.muted }}>({item.comments.length})</span>
          </div>
          {item.comments.length === 0 && <div className="text-[12px] mb-3" style={{ color: C.muted }}>No comments yet. Add the first one below.</div>}
          <div className="flex flex-col gap-2 mb-3">
            {item.comments.map((c, k) => (
              <div key={k} className="p-2.5 rounded-md text-[13px] leading-relaxed" style={{ background: "#F4F7F9" }}>
                <div className="flex justify-between text-[11px] mb-1" style={{ color: C.muted }}>
                  <span style={{ color: C.ink, fontWeight: 500 }}>{c.author}</span>
                  <span style={{ fontFamily: MONO }}>{ago(c.at)}</span>
                </div>
                <CommentBody text={c.text} members={members} />
              </div>
            ))}
          </div>

          {canEdit ? (
            <>
              <MentionInput value={comment} onChange={setComment} members={members} rows={2}
                placeholder="Add a comment. Type @ to tag a teammate and they'll be notified."
                onSubmitKey={() => { if (comment.trim()) { onComment(item, comment); setComment(""); } }} />
              <div className="flex items-center gap-2 mt-2">
                {mentioned.length > 0 && (
                  <span className="flex items-center gap-1 text-[11.5px] flex-1 min-w-0" style={{ color: C.accent }}>
                    <AtSign size={12} className="shrink-0" />
                    <span className="truncate">{mentioned.map((m) => m.name).join(", ")} will be notified</span>
                  </span>
                )}
                <button onClick={() => { if (comment.trim()) { onComment(item, comment); setComment(""); } }}
                  disabled={!comment.trim()}
                  className="ml-auto px-3.5 py-1.5 rounded-md text-[13px] font-medium shrink-0"
                  style={{ background: comment.trim() ? C.accent : C.rule, color: "#fff", cursor: comment.trim() ? "pointer" : "not-allowed" }}>
                  Post
                </button>
              </div>
            </>
          ) : (
            <div className="text-[12px]" style={{ color: C.muted }}>Only people on this project can comment.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══ WATCHLIST (shared by both log views) ═════════════ */
function Watchlist({ items, projectName, showOwner, onOpen, onRemind, onSnooze, emptyNote }) {
  const active = items.filter((i) => !(i.snoozedUntil && dayDelta(i.snoozedUntil) >= 0));
  const snoozedCount = items.length - active.length;
  const list = active.sort((a, b) => dayDelta(a.dueDate) - dayDelta(b.dueDate));
  return (
    <>
      {list.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <CheckCircle2 size={18} color={C.good} className="mx-auto mb-1.5" />
          <div className="text-[12.5px]" style={{ color: C.muted }}>{emptyNote}</div>
        </div>
      ) : list.map((i, idx) => {
        const n = dayDelta(i.dueDate), late = n < 0;
        const prev = idx > 0 ? dayDelta(list[idx - 1].dueDate) : null;
        const crosses = prev !== null && prev < 0 && n >= 0;
        return (
          <React.Fragment key={i.id}>
            {crosses && (
              <div className="flex items-center gap-2 px-4 py-1.5" style={{ background: "#F4F7F9" }}>
                <span className="text-[10px] tracking-[0.14em]" style={{ fontFamily: MONO, color: C.muted }}>TODAY</span>
                <span className="flex-1 h-px" style={{ background: C.rule }} />
              </div>
            )}
            <div className="wl flex cursor-pointer" style={{ borderTop: `1px solid ${C.rule}` }} onClick={() => onOpen(i)}>
              <div className="w-[52px] shrink-0 flex items-center justify-center py-3"
                style={{ background: late ? "#FBEAE8" : "#FBF4E6", borderRight: `1px solid ${C.rule}` }}>
                <span className="text-[15px] font-semibold leading-none" style={{ fontFamily: MONO, color: late ? C.late : C.soon }}>{deltaLabel(n)}</span>
              </div>
              <div className="flex-1 min-w-0 px-3 py-2.5">
                <div className="text-[13px] font-medium leading-snug mb-1">{i.title}</div>
                {/* §4.4 each panel row carries title, project, owner, priority, due date */}
                <div className="flex items-center gap-1.5 flex-wrap mb-1">
                  <PriorityBadge priority={i.priority} />
                  <span className="text-[11px]" style={{ fontFamily: MONO, color: late ? C.late : C.soon }}>{i.dueDate}</span>
                </div>
                <div className="text-[11px] mb-2 truncate" style={{ color: C.muted }}>
                  {showOwner ? `${i.owner} · ` : ""}{projectName(i.projectId)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button onClick={(e) => { e.stopPropagation(); onRemind(i); }}
                    className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
                    style={{ border: `1px solid ${C.rule}`, color: C.accent, background: C.surface }}>
                    <Mail size={11} /> Remind
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); onSnooze(i); }}
                    className="flex items-center gap-1 text-[11px] px-2 py-1 rounded"
                    style={{ border: `1px solid ${C.rule}`, color: C.muted, background: C.surface }}>
                    <Clock size={11} /> {SNOOZE_DAYS}d
                  </button>
                  {i.remindedAt && <span className="text-[10px]" style={{ fontFamily: MONO, color: C.muted }}>sent {ago(i.remindedAt)}</span>}
                </div>
              </div>
            </div>
          </React.Fragment>
        );
      })}
      {snoozedCount > 0 && (
        <div className="px-4 py-2 text-[11px] flex items-center gap-1.5" style={{ borderTop: `1px solid ${C.rule}`, color: C.muted, background: "#F4F7F9" }}>
          <Clock size={11} /> {snoozedCount} snoozed and hidden
        </div>
      )}
    </>
  );
}

/* ══ MY WORK ══════════════════════════════════════════ */
function MyWorkView({ items, projects, projectName, members, me, limits, isWsAdmin, onOpen, onRemind, onSnooze, onCreate, onGoToAll, onUpgrade, onExport, onQuickStatus }) {
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [notice, setNotice] = useState("");

  const mine = items.filter((i) => i.owner === me);
  const live = mine.filter((i) => isLive(i.status));
  const done = mine.filter((i) => !isLive(i.status));
  const watch = live.filter((i) => dayDelta(i.dueDate) <= DUE_SOON_DAYS);
  const overdueCount = live.filter((i) => dayDelta(i.dueDate) < 0).length;

  const hay = (i) => [i.title, i.description, i.impact, i.nextStep, ...i.comments.map((c) => c.text)].join(" ").toLowerCase();
  const shown = (showDone ? mine : live)
    .filter((i) => !query.trim() || hay(i).includes(query.toLowerCase()))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  /* quick status flips go through the same save path as the drawer */
  const setStatus = (item, status) => onCreate && onQuickStatus?.(item, status);

  if (projects.length === 0) {
    return (
      <Card>
        <div className="py-16 px-6 text-center">
          <div className="text-[14px] font-medium mb-1.5">You're not on any projects yet</div>
          <div className="text-[13px]" style={{ color: C.muted }}>A workspace admin needs to add you to a project first.</div>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      <aside className="w-full lg:w-[310px] shrink-0 flex flex-col gap-5">
        {watch.length > 0 && (
          <Card title="On your plate" subtitle={overdueCount > 0 ? `${overdueCount} already past due` : `Due within ${DUE_SOON_DAYS} days`}>
            <Watchlist items={watch} projectName={projectName} onOpen={onOpen} onRemind={onRemind} onSnooze={onSnooze}
              emptyNote={`Nothing of yours is due in the next ${DUE_SOON_DAYS} days.`} />
          </Card>
        )}
        <Card title="Your numbers">
          <div className="p-4 flex flex-col gap-2.5">
            {[["Live items", live.length, C.ink], ["Past due", overdueCount, overdueCount ? C.late : C.muted],
              ["Critical", live.filter((i) => i.priority === "critical").length, C.late],
              ["Resolved or closed", done.length, C.good]].map(([l, n, col]) => (
              <div key={l} className="flex items-center justify-between">
                <span className="text-[13px]">{l}</span>
                <span className="text-[15px] font-semibold" style={{ fontFamily: MONO, color: col }}>{n}</span>
              </div>
            ))}
          </div>
        </Card>
      </aside>

      <main className="flex-1 min-w-0 w-full">
        <div className="flex flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2 px-3 h-9 rounded-md flex-1 min-w-[200px]" style={inputStyle}>
            <Search size={14} color={C.muted} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your items and comments"
              className="flex-1 bg-transparent text-[13px] outline-none" />
          </div>
          <ExportButton limits={limits} onExport={onExport} onBlocked={() => setNotice("csv")} />
          <button onClick={() => setComposing((v) => !v)}
            className="flex items-center gap-1.5 h-9 px-3.5 rounded-md text-[13px] font-medium"
            style={{ background: C.accent, color: "#fff" }}>
            <Plus size={15} /> New item
          </button>
        </div>

        {notice === "csv" && (
          <UpgradeNotice want="paid" isWsAdmin={isWsAdmin} onSeeBilling={onUpgrade} onDismiss={() => setNotice("")}
            message="CSV export comes with the Paid plan. It downloads the whole log in one file — handy for status decks." />
        )}

        {composing && (
          <ItemForm projects={projects} members={members} me={me}
            onCancel={() => setComposing(false)}
            onSubmit={(form) => { onCreate(form); setComposing(false); }} />
        )}

        <Card title="Assigned to you" subtitle={showDone ? `All ${mine.length} items` : `${live.length} live · newest changes first`}
          right={<button onClick={() => setShowDone((v) => !v)} className="h-8 px-2.5 rounded-md text-[12px]" style={inputStyle}>
            {showDone ? "Hide finished" : "Show finished"}</button>}>
          {shown.length === 0 ? (
            <div className="py-14 px-6 text-center">
              <div className="text-[13px] font-medium mb-1">{query ? "Nothing matches that search" : "Nothing assigned to you"}</div>
              <div className="text-[13px] mb-4" style={{ color: C.muted }}>
                {query ? "Try a shorter search term." : "Log something you're carrying, or look through your projects."}
              </div>
              {!query && <button onClick={onGoToAll} className="text-[13px] px-3 py-2 rounded-md" style={inputStyle}>Browse all items</button>}
            </div>
          ) : shown.map((i, idx) => <ItemRow key={i.id} item={i} idx={idx} projectName={projectName} onOpen={onOpen} />)}
        </Card>
      </main>
    </div>
  );
}

/* ══ LOG ══════════════════════════════════════════════ */
function LogView({ items, projects, projectName, members, me, limits, isWsAdmin, onOpen, onRemind, onSnooze, onCreate, onUpgrade, onGoTo, onExport }) {
  const [query, setQuery] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [filters, setFilters] = useState({ projectId: "all", type: "all", priority: "all", status: "all", owner: "all" });
  const [sortBy, setSortBy] = useState("updated");
  const [composing, setComposing] = useState(false);
  const [notice, setNotice] = useState("");

  const watch = items.filter((i) => isLive(i.status) && dayDelta(i.dueDate) <= DUE_SOON_DAYS);
  const hay = (i) => [i.title, i.description, i.impact, i.nextStep, ...i.comments.map((c) => c.text)].join(" ").toLowerCase();

  const visible = useMemo(() => {
    const out = items.filter((i) => {
      if (mineOnly && i.owner !== me) return false;
      if (filters.projectId !== "all" && i.projectId !== filters.projectId) return false;
      if (filters.type !== "all" && i.type !== filters.type) return false;
      if (filters.priority !== "all" && i.priority !== filters.priority) return false;
      if (filters.status !== "all" && i.status !== filters.status) return false;
      if (filters.owner !== "all" && i.owner !== filters.owner) return false;
      if (query.trim() && !hay(i).includes(query.toLowerCase())) return false;
      return true;
    });
    out.sort((a, b) =>
      sortBy === "priority" ? PRIORITY[b.priority].rank - PRIORITY[a.priority].rank
      : sortBy === "dueDate" ? new Date(a.dueDate) - new Date(b.dueDate)
      : new Date(b.updatedAt) - new Date(a.updatedAt));
    return out;
  }, [items, filters, query, sortBy, mineOnly, me]);

  const SORTS = { updated: "Last updated", priority: "Priority", dueDate: "Due date" };

  /* §4.1 — creation is blocked until both a project and an invited person exist */
  const setupIncomplete = projects.length === 0 || members.length < 2;
  if (setupIncomplete) {
    const missing = [projects.length === 0 ? "a project" : null, members.length < 2 ? "one invited person" : null].filter(Boolean);
    return (
      <Card>
        <div className="py-16 px-6 text-center">
          <div className="text-[14px] font-medium mb-1.5">Add at least one project and one user to get started</div>
          <div className="text-[13px] mb-4" style={{ color: C.muted }}>
            Still needed: {missing.join(" and ")}. Items need a project to sit under and someone to own them.
          </div>
          <div className="flex justify-center gap-2">
            {projects.length === 0 && (
              <button onClick={() => onGoTo?.("projects")} className="text-[13px] px-3 py-2 rounded-md" style={inputStyle}>Add a project</button>
            )}
            {members.length < 2 && (
              <button onClick={() => onGoTo?.("team")} className="text-[13px] px-3 py-2 rounded-md" style={inputStyle}>Invite someone</button>
            )}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      {watch.length > 0 && (
        <aside className="w-full lg:w-[310px] shrink-0 rounded-lg overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.rule}` }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${C.rule}` }}>
            <div className="text-[11px] tracking-[0.1em] uppercase" style={{ fontFamily: MONO, color: C.muted }}>Watchlist</div>
            <div className="text-[12px] mt-0.5" style={{ color: C.muted }}>
              {watch.filter((i) => dayDelta(i.dueDate) < 0).length} overdue · {watch.filter((i) => dayDelta(i.dueDate) >= 0).length} due within {DUE_SOON_DAYS} days
            </div>
          </div>
          <Watchlist items={watch} projectName={projectName} showOwner onOpen={onOpen} onRemind={onRemind} onSnooze={onSnooze}
            emptyNote={`Every live item is more than ${DUE_SOON_DAYS} days out.`} />
        </aside>
      )}

      <main className="flex-1 min-w-0 w-full">
        <div className="flex flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2 px-3 h-9 rounded-md flex-1 min-w-[200px]" style={inputStyle}>
            <Search size={14} color={C.muted} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, detail and comments"
              className="flex-1 bg-transparent text-[13px] outline-none" />
          </div>
          {/* §4.3 — exports the whole log, not the filtered view */}
          <ExportButton limits={limits} onExport={onExport} onBlocked={() => setNotice("csv")} />
          <button onClick={() => setComposing((v) => !v)}
            className="flex items-center gap-1.5 h-9 px-3.5 rounded-md text-[13px] font-medium"
            style={{ background: C.accent, color: "#fff" }}>
            <Plus size={15} /> New item
          </button>
        </div>

        {notice === "csv" && (
          <UpgradeNotice want="paid" isWsAdmin={isWsAdmin} onSeeBilling={onUpgrade} onDismiss={() => setNotice("")}
            message="CSV export comes with the Paid plan. It downloads the entire log — every project, every item, with who last touched each one." />
        )}

        {composing && (
          <ItemForm projects={projects} members={members} me={me}
            onCancel={() => setComposing(false)} onSubmit={(form) => { onCreate(form); setComposing(false); }} />
        )}

        <div className="flex flex-wrap gap-2 mb-3">
          {[
            ["projectId", "Project", projects.map((p) => [p.id, p.name])],
            ["type", "Type", Object.entries(TYPES)],
            ["priority", "Priority", Object.entries(PRIORITY).map(([k, v]) => [k, v.label])],
            ["status", "Status", Object.entries(STATUS)],
            ["owner", "Owner", members.map((m) => [m.name, m.name])],
          ].map(([key, label, opts]) => (
            <select key={key} value={filters[key]} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
              className="h-8 px-2 rounded-md text-[12px]" style={{ ...inputStyle, color: filters[key] === "all" ? C.muted : C.ink }}>
              <option value="all">{label}: any</option>
              {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="h-8 px-2 rounded-md text-[12px]" style={inputStyle}>
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>Sort: {v}</option>)}
          </select>
          <button onClick={() => setMineOnly((v) => !v)} className="flex items-center gap-1 h-8 px-2.5 rounded-md text-[12px]"
            style={{ ...inputStyle, background: mineOnly ? "#EDF3F1" : C.surface, color: mineOnly ? C.accent : C.muted, borderColor: mineOnly ? C.accent : C.rule }}>
            <UserCheck size={12} /> Mine only
          </button>
        </div>

        <div className="rounded-lg overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.rule}` }}>
          {visible.length === 0 ? (
            <div className="py-16 text-center">
              <div className="text-[13px] font-medium mb-1">No items match</div>
              <div className="text-[12px]" style={{ color: C.muted }}>Clear a filter, or widen the search.</div>
            </div>
          ) : visible.map((i, idx) => <ItemRow key={i.id} item={i} idx={idx} projectName={projectName} onOpen={onOpen} showOwner />)}
        </div>
      </main>
    </div>
  );
}

/* ══ PROJECT MEMBERSHIP EDITOR (§2.2/§2.3) ════════════
   Used by the workspace admin on the Projects tab, and by a
   project admin on their own project from "Project team".      */
function ProjectMemberEditor({ project, members, projectMembers, limits, onSetRole }) {
  const roleFor = (id) => projectMembers.find(
    (pm) => pm.project_id === project.id && pm.workspace_member_id === id)?.project_role ?? "none";
  const onThis = projectMembers.filter((pm) => pm.project_id === project.id);
  const adminCount = onThis.filter((pm) => pm.project_role === "admin").length;
  /* workspace admins are on every project, so they count here too */
  const seatsUsed = onThis.length + members.filter((m) => m.role === "admin").length;
  const atSeatCap = seatsUsed >= limits.perProject;
  const assignable = members.filter((m) => m.role !== "admin");

  return (
    <div className="px-4 pb-4" style={{ background: "#F4F7F9" }}>
      <div className="flex items-baseline justify-between py-2.5 gap-2 flex-wrap">
        <span className="text-[11px] tracking-[0.06em] uppercase" style={{ fontFamily: MONO, color: C.muted }}>Who's on this project</span>
        <span className="flex gap-2.5 text-[11px]" style={{ fontFamily: MONO }}>
          <span style={{ color: atSeatCap ? C.soon : C.muted }}>{seatsUsed}/{limits.perProject} people</span>
          <span style={{ color: adminCount >= limits.projectAdmins ? C.soon : C.muted }}>{adminCount}/{limits.projectAdmins} admins</span>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {assignable.length === 0 && (
          <div className="text-[12px] px-2.5 py-2 rounded-md" style={{ background: C.surface, border: `1px solid ${C.rule}`, color: C.muted }}>
            No one to assign yet — invite people to the workspace first.
          </div>
        )}
        {assignable.map((m) => {
          const role = roleFor(m.id);
          return (
            <div key={m.id} className="flex items-center gap-2 px-2.5 py-2 rounded-md"
              style={{ background: C.surface, border: `1px solid ${role === "none" ? C.rule : C.accent}33` }}>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] truncate">{m.name}</span>
                {m.state === "invited" && <span className="block text-[10px]" style={{ fontFamily: MONO, color: C.soon }}>not signed in yet</span>}
              </span>
              <select value={role} onChange={(e) => onSetRole(project.id, m.id, e.target.value)}
                className="h-7 px-2 rounded-md text-[12px] shrink-0" style={inputStyle}>
                <option value="none">Not on project</option>
                <option value="member">Project member</option>
                <option value="admin">Project admin</option>
              </select>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] mt-2.5 leading-relaxed" style={{ color: C.muted }}>
        Anyone on a project can create and edit any item on it. Only project admins can delete.
        Workspace admins act as project admin everywhere, so they aren't listed here — but they do
        count towards the {limits.perProject}-person project cap.
      </div>
    </div>
  );
}

/* ══ PROJECT TEAM — a project admin managing their own project ══ */
function ProjectTeamView({ adminProjects, members, projectMembers, limits, items, projectName, onSetRole }) {
  const [expanded, setExpanded] = useState(adminProjects[0]?.id ?? null);

  if (adminProjects.length === 0) {
    return (
      <Card>
        <div className="py-16 px-6 text-center">
          <div className="text-[14px] font-medium mb-1.5">You're not a project admin anywhere</div>
          <div className="text-[13px]" style={{ color: C.muted }}>
            Project admins can manage who's on their project. A workspace admin can promote you.
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      <aside className="w-full lg:w-[310px] shrink-0 flex flex-col gap-5">
        <Card title="What you can do here" >
          <div className="p-4 text-[12.5px] leading-relaxed" style={{ color: C.muted }}>
            You're a project admin on {adminProjects.length === 1 ? "one project" : `${adminProjects.length} projects`}, so you can add
            and remove people there and set whether each is a member or an admin — up to {limits.projectAdmins} admin
            {limits.projectAdmins === 1 ? "" : "s"} per project on {limits.label}.
            <div className="mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${C.rule}` }}>
              Inviting new people into the workspace, creating projects and billing all stay with the workspace admin.
            </div>
          </div>
        </Card>
      </aside>

      <main className="flex-1 min-w-0 w-full flex flex-col gap-3">

        <Card title="Your projects" subtitle="Click one to manage who's on it">
          {adminProjects.map((p, idx) => {
            const mine = items.filter((i) => i.projectId === p.id);
            const h = healthOf(mine);
            const on = expanded === p.id;
            const assigned = projectMembers.filter((pm) => pm.project_id === p.id);
            return (
              <div key={p.id} style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}` }}>
                <div className="row flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setExpanded(on ? null : p.id)}>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium">{p.name}</div>
                    <div className="text-[11px]" style={{ color: C.muted }}>{assigned.length} assigned · {mine.length} items</div>
                  </div>
                  <span className="text-[11px] px-2 py-1 rounded shrink-0"
                    style={{ fontFamily: MONO, color: h.color, background: h.color === C.muted ? "#F4F7F9" : `${h.color}14` }}>{h.label}</span>
                  <span className="text-[11px] shrink-0" style={{ fontFamily: MONO, color: C.muted }}>{on ? "−" : "+"}</span>
                </div>
                {on && (
                  <ProjectMemberEditor project={p} members={members} projectMembers={projectMembers}
                    limits={limits} onSetRole={onSetRole} />
                )}
              </div>
            );
          })}
        </Card>
      </main>
    </div>
  );
}

/* ══ DELIVERY STATUS ══════════════════════════════════ */
function StatusView({ items, projects, projectName, members, limits, isWsAdmin, onOpen, onRemind, onUpgrade, onExport }) {
  const [notice, setNotice] = useState("");
  const rows = projects.map((p) => ({ p, h: healthOf(items.filter((i) => i.projectId === p.id)) }));

  const load = members.filter((m) => m.state === "active").map((m) => {
    const mine = items.filter((i) => i.owner === m.name && isLive(i.status));
    return { m, total: mine.length, critical: mine.filter((i) => i.priority === "critical").length, overdue: mine.filter((i) => dayDelta(i.dueDate) < 0).length };
  }).sort((a, b) => b.total - a.total);
  const maxLoad = Math.max(1, ...load.map((l) => l.total));

  const staleDays = (i) => Math.floor((Date.now() - new Date(i.updatedAt)) / 86400000);
  const attention = items.filter((i) => isLive(i.status) && (
    (dayDelta(i.dueDate) < 0 && staleDays(i) > DUE_SOON_DAYS) || !i.nextStep?.trim()
  )).sort((a, b) => dayDelta(a.dueDate) - dayDelta(b.dueDate));

  const reasonFor = (i) => (!i.nextStep?.trim() ? "No next step recorded" : `Overdue, untouched for ${staleDays(i)} days`);

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      <aside className="w-full lg:w-[310px] shrink-0 flex flex-col gap-5">
        <Card title="Portfolio" subtitle={`${projects.length} of ${limits.projects} projects · ${items.filter((i) => isLive(i.status)).length} live items`}>
          <div className="p-4 flex flex-col gap-2.5">
            {[["At risk", rows.filter((r) => r.h.label === "At risk").length, C.late],
              ["Watch", rows.filter((r) => r.h.label === "Watch").length, C.soon],
              ["On track", rows.filter((r) => r.h.label === "On track").length, C.good],
              ["No signal", rows.filter((r) => r.h.label === "No signal").length, C.muted]].map(([l, n, col]) => (
              <div key={l} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-[13px]"><span className="w-2 h-2 rounded-full" style={{ background: col }} /> {l}</span>
                <span className="text-[15px] font-semibold" style={{ fontFamily: MONO, color: col }}>{n}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Owner load" subtitle="Live items held per person">
          <div className="p-4 flex flex-col gap-3">
            {load.map(({ m, total, critical, overdue }) => (
              <div key={m.email}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[13px]">{m.name}</span>
                  <span className="text-[12px]" style={{ fontFamily: MONO, color: C.muted }}>{total}</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "#EDF1F4" }}>
                  <div className="h-full rounded-full" style={{ width: `${(total / maxLoad) * 100}%`, background: critical > 1 ? C.late : C.accent }} />
                </div>
                {(critical > 0 || overdue > 0) && (
                  <div className="text-[11px] mt-1" style={{ color: critical > 1 ? C.late : C.muted }}>
                    {critical > 0 && `${critical} critical`}{critical > 0 && overdue > 0 && " · "}{overdue > 0 && `${overdue} overdue`}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      </aside>

      <main className="flex-1 min-w-0 w-full flex flex-col gap-5">
        {notice === "csv" && (
          <UpgradeNotice want="paid" isWsAdmin={isWsAdmin} onSeeBilling={onUpgrade} onDismiss={() => setNotice("")}
            message="The decision log is a CSV export, which comes with the Paid plan. It's usually what steering committees ask for." />
        )}

        <Card title="Project delivery" subtitle="Each dot is a live item, placed by due date"
          right={
            limits.csv ? (
              <button onClick={() => onExport("decision-log.csv")}
                className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px]" style={inputStyle}>
                <Download size={12} /> Export log
              </button>
            ) : (
              <button onClick={() => setNotice("csv")} className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px]"
                style={{ ...inputStyle, color: C.muted, borderStyle: "dashed" }}>
                <Lock size={12} /> Decision log
              </button>
            )
          }>
          <StripLegend />
          {rows.map(({ p, h }, idx) => (
            <div key={p.id} className="px-4 py-4" style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}` }}>
              <div className="flex items-start justify-between gap-3 mb-2.5">
                <div>
                  <div className="text-[13px] font-medium">{p.name}</div>
                  <div className="text-[11px]" style={{ color: C.muted }}>{h.live.length} live</div>
                </div>
                <span className="text-[11px] px-2 py-1 rounded shrink-0"
                  style={{ fontFamily: MONO, color: h.color, background: h.color === C.muted ? "#F4F7F9" : `${h.color}14` }}>{h.label}</span>
              </div>
              <PressureStrip live={h.live} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]" style={{ color: C.muted }}>
                <span style={{ color: h.overdue.length ? C.late : C.muted }}>{h.overdue.length} overdue</span>
                <span style={{ color: h.soon.length ? C.soon : C.muted }}>{h.soon.length} due within {DUE_SOON_DAYS}d</span>
                {h.stale.length > 0 && <span style={{ color: C.late }}>{h.stale.length} untouched</span>}
                {h.noNextStep.length > 0 && <span>{h.noNextStep.length} without a next step</span>}
                {h.live.length === 0 && <span>Nothing logged — check the log is being used</span>}
              </div>
            </div>
          ))}
        </Card>

        <Card title="Needs attention" subtitle="Items that have gone quiet or have nowhere to go next">
          {attention.length === 0 ? (
            <div className="py-10 text-center">
              <div className="text-[13px] font-medium mb-1">Everything has a next step</div>
              <div className="text-[12px]" style={{ color: C.muted }}>No live item is stale or unactioned right now.</div>
            </div>
          ) : attention.map((i, idx) => (
            <div key={i.id} onClick={() => onOpen(i)} className="row flex items-center gap-3 px-4 py-3 cursor-pointer"
              style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}` }}>
              <AlertCircle size={15} color={C.late} className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium">{i.title}</div>
                <div className="text-[11px]" style={{ color: C.muted }}>{projectName(i.projectId)} · {i.owner} · {reasonFor(i)}</div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); onRemind(i); }}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded shrink-0"
                style={{ border: `1px solid ${C.rule}`, color: C.accent, background: C.surface }}>
                <Mail size={11} /> Remind
              </button>
            </div>
          ))}
        </Card>
      </main>
    </div>
  );
}

/* ══ PROJECTS ═════════════════════════════════════════ */
function ProjectsView({ projects, items, members, projectMembers, limits, plan, hasExpansion, workspaceName, onAdd, onDelete, onSetRole, onUpgrade }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(projects[0]?.id ?? null);

  const atCap = projects.length >= limits.projects;
  const [limitModal, setLimitModal] = useState(null);   // { attempted } when the cap is hit
  /* free → Paid · paid → Expansion · paid+expansion → talk to us (§3.5) */
  const want = upgradePath(plan, hasExpansion);
  const salesContext = { workspaceName, plan, hasExpansion, projects: projects.length, seats: members.length, limits };
  const exists = (n) => projects.some((p) => p.name.toLowerCase() === n.trim().toLowerCase());

  async function add() {
    const n = name.trim();
    if (!n) return;
    if (exists(n)) { setError(`“${n}” is already on the list.`); return; }
    /* over the cap → interrupt with the request modal, keep what they typed */
    if (atCap) { setLimitModal({ attempted: n }); return; }
    try { await onAdd(n); setName(""); setError(""); }
    catch { /* the toast already said it */ }
  }

  const adminCountOn = (pid) => projectMembers.filter((pm) => pm.project_id === pid && pm.project_role === "admin").length;

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      <aside className="w-full lg:w-[310px] shrink-0 flex flex-col gap-5">
        <Card title="Add a project" subtitle={`${projects.length} of ${limits.projects} used on ${limits.label}`}>
          <div className="p-4 flex flex-col gap-3">
            <Field label="Project name" required>
              <input value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && add()} placeholder="e.g. Warehouse Fit-out"
                className="w-full px-2.5 py-2 text-[13px]" style={error ? errStyle : inputStyle} />
            </Field>
            {error && <div className="text-[12px]" style={{ color: C.late }}>{error}</div>}
            <button onClick={add} className="flex items-center justify-center gap-1.5 py-2 rounded-md text-[13px] font-medium"
              style={{ background: C.accent, color: "#fff" }}>
              <Plus size={14} /> Add project
            </button>
            {atCap && (
              <div className="text-[11px] leading-relaxed" style={{ color: C.soon }}>
                You're at the {limits.projects}-project limit for {limits.label}. Adding another opens a request.
              </div>
            )}
          </div>
        </Card>

      </aside>

      <main className="flex-1 min-w-0 w-full flex flex-col gap-3">

        <Card title="Projects" subtitle={`${projects.length} of ${limits.projects} · click one to manage who's on it`}>
          {projects.length === 0 ? (
            <div className="py-14 px-6 text-center">
              <div className="text-[13px] font-medium mb-1">No projects yet</div>
              <div className="text-[13px]" style={{ color: C.muted }}>Add one on the left. Nothing can be logged until a project exists.</div>
            </div>
          ) : projects.map((p, idx) => {
            const mine = items.filter((i) => i.projectId === p.id);
            const h = healthOf(mine);
            const on = expanded === p.id;
            const assigned = projectMembers.filter((pm) => pm.project_id === p.id);
            return (
              <div key={p.id} style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}` }}>
                <div className="row flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setExpanded(on ? null : p.id)}>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium">{p.name}</div>
                    <div className="text-[11px]" style={{ color: C.muted }}>
                      {assigned.length} assigned · {adminCountOn(p.id)}/{limits.projectAdmins} project admins · {mine.length} items
                    </div>
                  </div>
                  <span className="text-[11px] px-2 py-1 rounded shrink-0"
                    style={{ fontFamily: MONO, color: h.color, background: h.color === C.muted ? "#F4F7F9" : `${h.color}14` }}>{h.label}</span>
                  <button onClick={(e) => { e.stopPropagation(); if (mine.length === 0) onDelete(p.id); }}
                    disabled={mine.length > 0} title={mine.length > 0 ? "Remove its items first" : "Delete project"}
                    className="p-1.5 rounded shrink-0" style={{ color: mine.length > 0 ? C.rule : C.late, cursor: mine.length > 0 ? "not-allowed" : "pointer" }}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {on && (
                  <ProjectMemberEditor project={p} members={members} projectMembers={projectMembers}
                    limits={limits} onSetRole={onSetRole} />
                )}
              </div>
            );
          })}
        </Card>
      </main>

      {limitModal && (
        <LimitRequestModal kind="projects" attempted={limitModal.attempted}
          workspaceName={workspaceName} plan={plan} hasExpansion={hasExpansion} limits={limits}
          projectCount={projects.length} seatCount={members.length}
          onClose={() => setLimitModal(null)} />
      )}
    </div>
  );
}

/* ══ TEAM ═════════════════════════════════════════════ */
function TeamView({ members, items, myEmail, projectMembers, limits, plan, hasExpansion, workspaceName, projectCount = 0, onInvite, onSetRole, onRemove, onUpgrade }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [guard, setGuard] = useState("");
  const used = members.length;
  const seatsLeft = limits.seats - used;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const adminCount = members.filter((m) => m.role === "admin").length;
  const lastAdmin = (m) => m.role === "admin" && adminCount === 1;
  const [limitModal, setLimitModal] = useState(null);

  async function invite() {
    const e = email.trim().toLowerCase();
    if (!valid.test(e)) { setError("Enter a full email address, like name@company.com."); return; }
    if (members.some((m) => m.email === e)) { setError("That address is already on the team."); return; }
    if (seatsLeft <= 0) { setLimitModal({ attempted: e }); return; }
    try {
      await onInvite(e, name);
      sendInvite(e);
      setEmail(""); setName(""); setError("");
    } catch { /* toast already shown */ }
  }

  /* The database enforces the last-admin rule too; these checks just
     give a nicer message before the round trip. */
  function changeRole(m, next) {
    if (lastAdmin(m) && next !== "admin") { setGuard("A workspace needs at least one admin. Promote someone else first."); return; }
    setGuard("");
    onSetRole(m.id, next).catch(() => {});
  }

  function remove(m) {
    if (lastAdmin(m)) { setGuard("You can't remove the only admin — the workspace would have no one to manage it."); return; }
    if (m.email === myEmail) { setGuard("You can't remove yourself. Ask another admin to do it."); return; }
    setGuard("");
    onRemove(m.id).catch(() => {});
  }

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      <aside className="w-full lg:w-[310px] shrink-0 flex flex-col gap-5">
        <Card title="Invite someone" subtitle={`${Math.max(0, seatsLeft)} of ${limits.seats} seats free on ${limits.label}`}>
          <div className="p-4 flex flex-col gap-3">
            <Field label="Email address" required>
              <input value={email} onChange={(e) => { setEmail(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && invite()} placeholder="name@company.com"
                className="w-full px-2.5 py-2 text-[13px]" style={error ? errStyle : inputStyle} />
            </Field>
            <Field label="Display name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional"
                className="w-full px-2.5 py-2 text-[13px]" style={inputStyle} />
            </Field>
            {error && <div className="text-[12px]" style={{ color: C.late }}>{error}</div>}
            <button onClick={invite} className="flex items-center justify-center gap-1.5 py-2 rounded-md text-[13px] font-medium"
              style={{ background: C.accent, color: "#fff" }}>
              <Send size={14} /> Send invite
            </button>
            {seatsLeft <= 0 && (
              <div className="text-[11px] leading-relaxed" style={{ color: C.soon }}>
                All {limits.seats} seats on {limits.label} are taken. Inviting another opens a request.
              </div>
            )}
            <div className="text-[11px] leading-relaxed" style={{ color: C.muted }}>
              Everyone joins as a workspace user. Put them on projects, and set project admin or member, from the Projects tab.
            </div>
          </div>
        </Card>


        <Card title="Seats">
          <div className="p-4">
            <div className="flex gap-1 mb-2 flex-wrap">
              {Array.from({ length: limits.seats }).map((_, k) => (
                <span key={k} className="h-2 rounded-full" style={{ flex: "1 0 8px", background: k < used ? (members[k]?.state === "invited" ? C.soon : C.accent) : "#EDF1F4" }} />
              ))}
            </div>
            <div className="text-[11px]" style={{ color: C.muted }}>
              {members.filter((m) => m.state === "active").length} active · {members.filter((m) => m.state === "invited").length} awaiting first sign-in
            </div>
          </div>
        </Card>
      </aside>

      <main className="flex-1 min-w-0 w-full flex flex-col gap-3">

        <Card title="Team" subtitle={`${used} of ${limits.seats} seats · ${adminCount} workspace admin${adminCount === 1 ? "" : "s"}`}>
          {guard && (
            <div className="flex items-start gap-2 px-4 py-2.5 text-[12px]" style={{ background: "#FBEAE8", color: C.late, borderBottom: `1px solid ${C.rule}` }}>
              <AlertCircle size={13} className="shrink-0 mt-0.5" /> {guard}
            </div>
          )}
          {members.map((m, idx) => {
            const held = items.filter((i) => i.owner === m.name && isLive(i.status)).length;
            const isMe = m.email === myEmail;
            const onProjects = projectMembers.filter((pm) => pm.workspace_member_id === m.id).length;
            return (
              <div key={m.id} className="row flex items-center gap-2.5 px-4 py-3" style={{ borderTop: idx === 0 ? "none" : `1px solid ${C.rule}` }}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0"
                  style={{ background: "#EDF3F1", color: C.accent }}>
                  {m.name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase()}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    {m.name}{isMe && <span className="ml-1.5 text-[11px]" style={{ color: C.muted }}>you</span>}
                  </div>
                  <div className="text-[11px] truncate" style={{ fontFamily: MONO, color: C.muted }}>{m.email}</div>
                </div>
                <span className="text-[11px] hidden lg:block shrink-0" style={{ color: C.muted }}>
                  {m.role === "admin" ? "all projects" : `${onProjects} project${onProjects === 1 ? "" : "s"}`} · {held} live
                </span>
                {m.state === "invited" && (
                  <button onClick={() => sendInvite(m.email)} className="text-[11px] px-2 py-1 rounded shrink-0"
                    style={{ fontFamily: MONO, background: "#FBF4E6", color: C.soon }}>Resend</button>
                )}
                <select value={m.role} onChange={(e) => changeRole(m, e.target.value)}
                  className="h-8 px-2 rounded-md text-[12px] shrink-0" style={inputStyle}>
                  <option value="user">User</option>
                  <option value="admin">Workspace admin</option>
                </select>
                <button onClick={() => remove(m)} className="p-1.5 rounded shrink-0"
                  style={{ color: lastAdmin(m) || isMe ? C.rule : C.late }}
                  title={lastAdmin(m) ? "The only admin can't be removed" : isMe ? "You can't remove yourself" : "Remove from workspace"}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </Card>
      </main>

      {limitModal && (
        <LimitRequestModal kind="seats" attempted={limitModal.attempted}
          workspaceName={workspaceName} plan={plan} hasExpansion={hasExpansion} limits={limits}
          projectCount={projectCount} seatCount={members.length}
          onClose={() => setLimitModal(null)} />
      )}
    </div>
  );
}

/* ══ BILLING ══════════════════════════════════════════
   §3.5 is explicit: no custom billing management UI. Payment
   Links out to Stripe for buying, the hosted Customer Portal
   for everything else. This screen only shows where you stand.
   ══════════════════════════════════════════════════════ */
function BillingView({ ws, limits, projectCount, seatCount }) {
  const paid = ws.plan === "paid";
  const label = paid ? (ws.has_expansion_addon ? "Paid + Expansion" : "Paid") : "Free";
  const price = paid ? (ws.has_expansion_addon ? "$24/mo" : "$15/mo") : "$0";
  const atCeiling = paid && ws.has_expansion_addon &&
    (projectCount >= limits.projects || seatCount >= limits.seats);

  const usage = [
    { label: "Projects", used: projectCount, cap: limits.projects },
    { label: "People in the workspace", used: seatCount, cap: limits.seats },
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      <aside className="w-full lg:w-[310px] shrink-0 flex flex-col gap-5">
        <Card title="Current subscription">
          <div className="p-4">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-[16px] font-semibold">{label}</span>
              <span className="text-[13px]" style={{ fontFamily: MONO, color: C.muted }}>{price}</span>
            </div>
            <div className="text-[11px] mb-3" style={{ fontFamily: MONO, color: C.muted }}>
              status {ws.subscription_status}
            </div>
            {usage.map((u) => {
              const pct = Math.min(100, (u.used / Math.max(1, u.cap)) * 100);
              const full = u.used >= u.cap;
              return (
                <div key={u.label} className="mb-2.5">
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-[12.5px]">{u.label}</span>
                    <span className="text-[12px]" style={{ fontFamily: MONO, color: full ? C.soon : C.muted }}>
                      {u.used} / {u.cap}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "#EDF1F4" }}>
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: full ? C.soon : C.accent }} />
                  </div>
                </div>
              );
            })}
            <div className="flex items-center justify-between pt-2.5 mt-1" style={{ borderTop: `1px solid ${C.rule}` }}>
              <span className="text-[12.5px]">CSV export</span>
              <span className="text-[12px]" style={{ fontFamily: MONO, color: limits.csv ? C.good : C.muted }}>
                {limits.csv ? "included" : "not included"}
              </span>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[12.5px]">Reminder emails</span>
              <span className="text-[12px]" style={{ fontFamily: MONO, color: C.good }}>every plan</span>
            </div>
          </div>
        </Card>

        {paid && (
          <Card title="Manage">
            <div className="p-4 flex flex-col gap-2">
              <button onClick={() => openStripe(STRIPE.portal)}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-md text-[13px] font-medium"
                style={{ background: C.accent, color: "#fff" }}>
                <ExternalLink size={14} /> Manage subscription
              </button>
              <div className="text-[11px] leading-relaxed" style={{ color: C.muted }}>
                Opens Stripe's billing portal — card details, invoices, receipts, adding or dropping
                the Expansion add-on, and cancellation all live there.
              </div>
            </div>
          </Card>
        )}
      </aside>

      <main className="flex-1 min-w-0 w-full flex flex-col gap-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-lg p-4 flex flex-col" style={{ background: C.surface, border: `1px solid ${!paid ? C.accent : C.rule}` }}>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[14px] font-semibold">Free</span>
              {!paid && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ fontFamily: MONO, background: "#EDF3F1", color: C.accent }}>current</span>}
            </div>
            <div className="text-[19px] font-semibold mb-3" style={{ fontFamily: MONO }}>$0</div>
            <div className="flex flex-col gap-1.5 mb-4 text-[12.5px] flex-1">
              {["1 project", "5 people", "1 project admin", "Reminders and notifications"].map((l) => (
                <div key={l} className="flex items-start gap-1.5"><CheckCircle2 size={13} color={C.good} className="shrink-0 mt-0.5" /><span>{l}</span></div>
              ))}
              <div className="flex items-start gap-1.5" style={{ color: C.muted }}><X size={13} className="shrink-0 mt-0.5" /><span>No CSV export</span></div>
            </div>
            {!paid
              ? <button disabled className="py-2 rounded-md text-[13px]" style={{ ...inputStyle, color: C.muted }}>Current plan</button>
              : <button onClick={() => openStripe(STRIPE.portal)} className="py-2 rounded-md text-[13px]" style={inputStyle}>Cancel via Stripe</button>}
          </div>

          <div className="rounded-lg p-4 flex flex-col" style={{ background: C.surface, border: `1px solid ${paid ? C.accent : C.rule}` }}>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[14px] font-semibold">Paid</span>
              {paid && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ fontFamily: MONO, background: "#EDF3F1", color: C.accent }}>current</span>}
            </div>
            <div className="text-[19px] font-semibold mb-3" style={{ fontFamily: MONO }}>$15<span className="text-[13px]" style={{ color: C.muted }}>/mo</span></div>
            <div className="flex flex-col gap-1.5 mb-4 text-[12.5px] flex-1">
              {["2 projects", "20 people, up to 10 per project", "2 project admins per project", "CSV export of the whole log"].map((l) => (
                <div key={l} className="flex items-start gap-1.5"><CheckCircle2 size={13} color={C.good} className="shrink-0 mt-0.5" /><span>{l}</span></div>
              ))}
            </div>
            {paid ? (
              <button disabled className="py-2 rounded-md text-[13px]" style={{ ...inputStyle, color: C.muted }}>Current plan</button>
            ) : (
              <div className="flex flex-col gap-1.5">
                <button onClick={() => openStripe(STRIPE.paid)} className="flex items-center justify-center gap-1.5 py-2 rounded-md text-[13px] font-medium"
                  style={{ background: C.accent, color: "#fff" }}>
                  <ExternalLink size={13} /> Subscribe — $15/mo
                </button>
                <button onClick={() => openStripe(STRIPE.paidAnnual)} className="py-1.5 rounded-md text-[12px]" style={inputStyle}>
                  Or $150/year — two months free
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg p-4" style={{ background: C.surface, border: `1px solid ${ws.has_expansion_addon ? C.accent : C.rule}` }}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-[14px] font-semibold">Expansion add-on</span>
                <span className="text-[13px]" style={{ fontFamily: MONO, color: C.muted }}>{EXPANSION.price}</span>
                {ws.has_expansion_addon && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ fontFamily: MONO, background: "#EDF3F1", color: C.accent }}>active</span>}
              </div>
              <div className="text-[12.5px] leading-relaxed" style={{ color: C.muted }}>
                One toggle on top of Paid: a third project and ten more people. Still 10 maximum on any
                single project. Not available on Free.
              </div>
            </div>
            <div className="shrink-0">
              {!paid ? (
                <span className="text-[12px] px-2.5 py-2 rounded-md inline-block" style={{ ...inputStyle, color: C.muted }}>Needs Paid first</span>
              ) : ws.has_expansion_addon ? (
                <button onClick={() => openStripe(STRIPE.portal)} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-[13px]" style={inputStyle}>
                  <ExternalLink size={13} /> Remove in Stripe
                </button>
              ) : (
                <button onClick={() => openStripe(STRIPE.expansion)} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-[13px] font-medium"
                  style={{ background: C.accent, color: "#fff" }}>
                  <ExternalLink size={13} /> Add — {EXPANSION.price}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-lg p-4" style={{ background: atCeiling ? "#FBF4E6" : C.surface, border: `1px solid ${atCeiling ? `${C.soon}44` : C.rule}` }}>
          <div className="flex items-start gap-2.5">
            <Sprout size={15} color={atCeiling ? C.soon : C.muted} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold mb-1">
                {atCeiling ? "You've reached the largest plan" : "Outgrowing Paid + Expansion"}
              </div>
              <div className="text-[12.5px] leading-relaxed mb-2" style={{ color: atCeiling ? C.ink : C.muted }}>
                Paid plus the add-on tops out at 3 projects and 30 people, and the add-on can only be
                bought once — it doesn't stack. Tell us early if you expect to grow past that.
              </div>
              <button
                onClick={() => contactSales({
                  workspaceName: ws.name, plan: ws.plan, hasExpansion: ws.has_expansion_addon,
                  projects: projectCount, seats: seatCount, limits,
                  hitting: projectCount >= limits.projects ? "projects" : "seats",
                })}
                className="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-md font-medium"
                style={atCeiling ? { background: C.soon, color: "#fff" } : { ...inputStyle, color: C.ink }}>
                <Mail size={12} /> Email us about a bigger plan
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 p-3 rounded-lg text-[12px] leading-relaxed"
          style={{ background: C.surface, border: `1px solid ${C.rule}`, color: C.muted }}>
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Paying via a Payment Link doesn't switch the plan automatically yet — we set it once the
            payment lands, so allow a short delay.
          </span>
        </div>
      </main>
    </div>
  );
}

