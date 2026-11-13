// The real store: Supabase for sign-in, teams, memory and history.
// Uses the service role key, so it runs only on the server. Same shape as store-memory.js.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { slug } from '../src/skills.js';

const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

export class SupabaseStore {
  constructor({ url, serviceKey, encryptionSecret }) {
    if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    if (!encryptionSecret || encryptionSecret.length < 16) throw new Error('KEY_ENCRYPTION_SECRET must be at least 16 characters.');
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    this.key = crypto.scryptSync(encryptionSecret, 'cursor-swarm-api-keys', 32);
  }

  // ---- People --------------------------------------------------------------------------
  async verifyToken(token) {
    if (!token) return null;
    const { data, error } = await this.db.auth.getUser(token);
    if (error || !data?.user) return null;
    const profile = ok(await this.db.from('profiles').select('name').eq('id', data.user.id).maybeSingle());
    return { id: data.user.id, email: data.user.email, name: profile?.name ?? data.user.email?.split('@')[0] ?? 'Someone' };
  }

  async teamOf(userId) {
    const mine = ok(await this.db.from('team_members').select('team_id, teams(id, name)').eq('user_id', userId).order('joined_at').limit(1));
    const team = mine?.[0]?.teams;
    if (!team) return null;
    const members = ok(await this.db.from('team_members').select('user_id, profiles(name)').eq('team_id', team.id));
    return { id: team.id, name: team.name, members: members.map((m) => ({ id: m.user_id, name: m.profiles?.name ?? 'Someone' })) };
  }

  async upsertDevice({ id, userId, teamId, name, platform }) {
    ok(await this.db.from('devices').upsert({ id, user_id: userId, team_id: teamId, name, platform, last_seen: new Date().toISOString() }));
  }

  // ---- API keys: AES-256-GCM, so the database never holds a usable key ---------------------
  encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }
  decrypt(packed) {
    const [iv, tag, body] = packed.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
  async getKey(userId) {
    const row = ok(await this.db.from('user_secrets').select('anthropic_key_enc').eq('user_id', userId).maybeSingle());
    return row ? this.decrypt(row.anthropic_key_enc) : null;
  }
  async setKey(userId, key) {
    ok(await this.db.from('user_secrets').upsert({ user_id: userId, anthropic_key_enc: this.encrypt(key), updated_at: new Date().toISOString() }));
  }
  async deleteKey(userId) { ok(await this.db.from('user_secrets').delete().eq('user_id', userId)); }

  // ---- Sessions and chat ----------------------------------------------------------------------
  async createSession({ id, teamId, ownerId, goal }) {
    ok(await this.db.from('sessions').insert({ id, team_id: teamId, owner_id: ownerId, goal }));
  }
  async endSession(id, { status, summary, usage, billing = null, costMicro = null }) {
    ok(await this.db.from('sessions').update({ status, summary, usage, billing, cost_micro: costMicro, ended_at: new Date().toISOString() }).eq('id', id));
  }
  async addMessage({ sessionId, authorId, target, text }) {
    ok(await this.db.from('messages').insert({ session_id: sessionId, author_id: authorId, target, text }));
  }

  // ---- Skills: team memory, each revision attributed to one person -------------------------------
  async listSkills(teamId) {
    return ok(await this.db.from('memories').select('name, description').eq('team_id', teamId).eq('kind', 'skill').order('name'));
  }
  async readSkill(teamId, name) {
    const row = ok(await this.db.from('memories').select('name, description, body').eq('team_id', teamId).eq('kind', 'skill').eq('name', slug(name)).maybeSingle());
    return row ?? null;
  }
  async saveSkill(teamId, { name, description, body }, authorId, sessionId) {
    const id = slug(name);
    if (!id) throw new Error('A skill needs a name made of letters, digits and dashes.');
    const text = String(body ?? '').trim().slice(0, 8000);
    if (text.length < 40) throw new Error('The skill body is too short to be useful.');
    const desc = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const old = ok(await this.db.from('memories').select('id, revision, author_id, description, body').eq('team_id', teamId).eq('kind', 'skill').eq('name', id).maybeSingle());
    if (!old) {
      ok(await this.db.from('memories').insert({ kind: 'skill', scope: 'team', team_id: teamId, author_id: authorId, session_id: sessionId, name: id, description: desc, body: text }));
      return { name: id, description: desc, created: true, revision: 1 };
    }
    ok(await this.db.from('memory_revisions').insert({ memory_id: old.id, revision: old.revision, author_id: old.author_id, description: old.description, body: old.body }));
    ok(await this.db.from('memories').update({ description: desc, body: text, revision: old.revision + 1, author_id: authorId, session_id: sessionId, updated_at: new Date().toISOString() }).eq('id', old.id));
    return { name: id, description: desc, created: false, revision: old.revision + 1 };
  }

  // ---- Notes: what people said they want remembered ---------------------------------------------
  async memoryNotes(teamId, userIds) {
    const rows = ok(await this.db.from('memories')
      .select('scope, subject_id, body, subject:profiles!memories_subject_id_fkey(name), author:profiles!memories_author_id_fkey(name)')
      .eq('team_id', teamId).eq('kind', 'note').order('created_at').limit(200));
    return rows
      .filter((m) => m.scope === 'team' || userIds.includes(m.subject_id))
      .map((m) => ({ scope: m.scope, subjectId: m.subject_id, subjectName: m.subject?.name ?? 'Someone', authorName: m.author?.name ?? 'Someone', note: m.body }));
  }
  // ---- Billing: one balance per person, every change written to a ledger -----------------------
  async getBilling(userId) {
    const row = ok(await this.db.from('billing_accounts').select('stripe_customer_id, subscription_id, status, period_end, credits_micro').eq('user_id', userId).maybeSingle());
    return { credits: Number(row?.credits_micro ?? 0), status: row?.status ?? 'none', customerId: row?.stripe_customer_id ?? null, subscriptionId: row?.subscription_id ?? null, periodEnd: row?.period_end ?? null };
  }
  async setBilling(userId, { status, customerId, subscriptionId, periodEnd }) {
    const patch = { user_id: userId, updated_at: new Date().toISOString() };
    if (status !== undefined) patch.status = status;
    if (customerId !== undefined) patch.stripe_customer_id = customerId;
    if (subscriptionId !== undefined) patch.subscription_id = subscriptionId;
    if (periodEnd !== undefined) patch.period_end = periodEnd;
    ok(await this.db.from('billing_accounts').upsert(patch));
  }
  async userByCustomer(customerId) {
    const row = ok(await this.db.from('billing_accounts').select('user_id').eq('stripe_customer_id', customerId).maybeSingle());
    return row?.user_id ?? null;
  }
  // The balance change and its ledger line happen together in the database (see apply_credit in schema.sql).
  async applyCredit({ userId, deltaMicro, kind, sessionId = null, eventId = null, note = '' }) {
    return Number(ok(await this.db.rpc('apply_credit', { p_user: userId, p_delta: deltaMicro, p_kind: kind, p_session: sessionId, p_event: eventId, p_note: note })));
  }

  async addMemory({ scope, teamId, subjectId, authorId, sessionId, note }) {
    ok(await this.db.from('memories').insert({ kind: 'note', scope, team_id: teamId, subject_id: subjectId, author_id: authorId, session_id: sessionId, body: note }));
  }
}
