(function (g) {
  'use strict';

  class VerificationPool {
    constructor() {
      this.items = [];
    }

    parseInput(rawString) {
      if (!rawString || typeof rawString !== 'string') return [];
      const lines = rawString.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
      const out = [];
      for (const line of lines) {
        let parts;
        if (line.includes('|')) parts = line.split('|');
        else if (line.includes('\t')) parts = line.split('\t');
        else if (line.includes(',')) parts = line.split(',');
        else parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const phone = parts[0].trim();
        const url = parts.slice(1).join(line.includes('|') ? '|' : ' ').trim();
        if (phone && url) {
          out.push({ phone, url, status: 'available', assignedTo: null, errorMessage: null, verifiedAt: null });
        }
      }
      return out;
    }

    syncFromString(rawString) {
      const incoming = this.parseInput(rawString);
      const map = new Map(this.items.map((it) => [it.phone, it]));
      const updated = [];
      let added = 0;
      let preserved = 0;
      for (const entry of incoming) {
        const prev = map.get(entry.phone);
        if (prev) {
          updated.push({ ...prev, url: entry.url });
          preserved++;
        } else {
          updated.push(entry);
          added++;
        }
      }
      const removed = Math.max(0, this.items.length - preserved);
      this.items = updated;
      return { total: this.items.length, added, preserved, removed };
    }

    getNextAvailable(email) {
      if (!email) return null;
      const cur = this.items.find((i) => i.status === 'in_use' && i.assignedTo === email);
      if (cur) return cur;
      const free = this.items.find((i) => i.status === 'available');
      if (!free) return null;
      free.status = 'in_use';
      free.assignedTo = email;
      free.errorMessage = null;
      return free;
    }

    markVerified(phone) {
      const item = this.items.find((i) => i.phone === phone);
      if (!item) return false;
      item.status = 'verified';
      item.errorMessage = null;
      item.verifiedAt = new Date().toISOString();
      return true;
    }

    markPermanentError(phone, errorMessage) {
      const item = this.items.find((i) => i.phone === phone);
      if (!item) return false;
      item.status = 'permanent_error';
      item.errorMessage = errorMessage || 'Error';
      return true;
    }

    releaseByEmail(email) {
      let count = 0;
      for (const i of this.items) {
        if (i.assignedTo === email && i.status === 'in_use') {
          i.status = 'available';
          i.assignedTo = null;
          count++;
        }
      }
      return count;
    }

    resetPermanentErrors() {
      let count = 0;
      for (const i of this.items) {
        if (i.status === 'permanent_error') {
          i.status = 'available';
          i.assignedTo = null;
          i.errorMessage = null;
          count++;
        }
      }
      return count;
    }

    getStats() {
      const stats = { total: this.items.length, available: 0, in_use: 0, verified: 0, permanent_error: 0 };
      for (const i of this.items) {
        if (i.status in stats) stats[i.status]++;
      }
      return stats;
    }

    toInputString() {
      return this.items.map((i) => `${i.phone}|${i.url}`).join('\n');
    }

    toJSON() {
      return this.items.map((i) => ({ ...i }));
    }

    static fromJSON(arr) {
      const pool = new VerificationPool();
      if (Array.isArray(arr)) pool.items = arr.map((i) => ({ ...i }));
      return pool;
    }
  }

  g.Verification = VerificationPool;
})(typeof self !== 'undefined' ? self : this);
