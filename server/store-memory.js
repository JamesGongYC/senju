// An in-memory store with the same shape as the Supabase one. Used by the tests, and
// handy for trying the hub locally: tokens are just "user:<id>".
import { slug } from '../src/skills.js';

export class MemoryStore {
  constructor() {
    this.users = new Map();      // id -> { id, name, email }
    this.teams = new Map();      // id -> { id, name, members: Set<userId> }
    this.keys = new Map();
    this.devices = new Map();
    this.sessions = new Map();
    this.messages = [];
    this.skills = new Map();     // `${teamId}/${name}` -> { name, description, body, revision, authorId, history: [] }
    this.memories = [];
  }

  addUser(id, name, teamId = null) { this.users.set(id, { id, name, email: `${id}@example.com` }); if (teamId) this.join(id, teamId); return `user:${id}`; }
  addTeam(id, name) { this.teams.set(id, { id, name, members: new Set() }); }
  join(userId, teamId) { this.teams.get(teamId).members.add(userId); }

  async verifyToken(token) { const m = /^user:(.+)$/.exec(String(token ?? '')); return m ? this.users.get(m[1]) ?? null : null; }
  async teamOf(userId) {
    const t = [...this.teams.values()].find((x) => x.members.has(userId));
    return t ? { id: t.id, name: t.name, members: [...t.members].map((id) => ({ id, name: this.users.get(id).name })) } : null;
  }
  async upsertDevice(d) { this.devices.set(d.id, d); }
  async getKey(userId) { return this.keys.get(userId) ?? null; }
  async setKey(userId, key) { this.keys.set(userId, key); }
  async createSession(s) { this.sessions.set(s.id, { ...s, status: 'running' }); }
  async endSession(id, patch) { Object.assign(this.sessions.get(id), patch); }
  async addMessage(m) { this.messages.push(m); }

  async listSkills(teamId) { return [...this.skills].filter(([k]) => k.startsWith(`${teamId}/`)).map(([, v]) => ({ name: v.name, description: v.description })); }
  async readSkill(teamId, name) { const v = this.skills.get(`${teamId}/${slug(name)}`); return v ? { name: v.name, description: v.description, body: v.body } : null; }
  async saveSkill(teamId, { name, description, body }, authorId, sessionId) {
    const id = slug(name);
    if (!id) throw new Error('A skill needs a name made of letters, digits and dashes.');
    if (String(body ?? '').trim().length < 40) throw new Error('The skill body is too short to be useful.');
    const key = `${teamId}/${id}`;
    const old = this.skills.get(key);
    const row = { name: id, description: String(description ?? '').trim(), body: String(body).trim(), revision: (old?.revision ?? 0) + 1, authorId, sessionId, history: old ? [...old.history, { revision: old.revision, authorId: old.authorId, body: old.body }] : [] };
    this.skills.set(key, row);
    return { name: id, description: row.description, created: !old, revision: row.revision };
  }

  async memoryNotes(teamId, userIds) {
    const name = (id) => this.users.get(id)?.name ?? 'someone';
    return this.memories
      .filter((m) => m.teamId === teamId && (m.scope === 'team' || userIds.includes(m.subjectId)))
      .map((m) => ({ scope: m.scope, subjectId: m.subjectId, subjectName: name(m.subjectId), authorName: name(m.authorId), note: m.note }));
  }
  async addMemory(m) { this.memories.push({ ...m, at: Date.now() }); }
}
