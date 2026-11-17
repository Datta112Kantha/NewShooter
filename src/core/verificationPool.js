'use strict';

class VerificationPool {
  constructor() {
    /** @type {Array<{phone: string, url: string, status: 'available'|'in_use'|'verified'|'permanent_error', assignedTo: string|null, errorMessage: string|null, verifiedAt: string|null}>} */
    this.items = [];
  }

  /**
   * Parse lines of format:
   *   phone|url  OR  phone\turl  OR  phone,url  OR  phone url
   */
  parseInput(rawString) {
    if (!rawString || typeof rawString !== 'string') return [];
    const lines = rawString
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const parsed = [];
    for (const line of lines) {
      let parts;
      if (line.includes('|')) {
        parts = line.split('|');
      } else if (line.includes('\t')) {
        parts = line.split('\t');
      } else if (line.includes(',')) {
        parts = line.split(',');
      } else {
        parts = line.split(/\s+/);
      }

      if (parts.length < 2) continue;
      const phone = parts[0].trim();
      const url = parts.slice(1).join(line.includes('|') ? '|' : ' ').trim();
      if (!phone || !url) continue;

      parsed.push({
        phone,
        url,
        status: 'available',
        assignedTo: null,
        errorMessage: null,
        verifiedAt: null
      });
    }
    return parsed;
  }

  syncFromString(rawString) {
    const incoming = this.parseInput(rawString);
    const existingByPhone = new Map();
    for (const item of this.items) {
      existingByPhone.set(item.phone, item);
    }

    const updated = [];
    let added = 0;
    let preserved = 0;

    for (const entry of incoming) {
      const prev = existingByPhone.get(entry.phone);
      if (prev) {
        updated.push({
          ...prev,
          url: entry.url
        });
        preserved++;
      } else {
        updated.push(entry);
        added++;
      }
    }

    const removed = this.items.length - preserved;
    this.items = updated;
    return {
      total: this.items.length,
      added,
      preserved,
      removed: Math.max(0, removed)
    };
  }

  getNextAvailable(accountEmail) {
    if (!accountEmail) return null;
    const alreadyAssigned = this.items.find(
      (item) => item.status === 'in_use' && item.assignedTo === accountEmail
    );
    if (alreadyAssigned) return alreadyAssigned;

    const free = this.items.find((item) => item.status === 'available');
    if (!free) return null;

    free.status = 'in_use';
    free.assignedTo = accountEmail;
    free.errorMessage = null;
    return free;
  }

  markVerified(phone) {
    const item = this.items.find((it) => it.phone === phone);
    if (!item) return false;
    item.status = 'verified';
    item.errorMessage = null;
    item.verifiedAt = new Date().toISOString();
    return true;
  }

  markPermanentError(phone, errorMessage) {
    const item = this.items.find((it) => it.phone === phone);
    if (!item) return false;
    item.status = 'permanent_error';
    item.errorMessage = errorMessage || 'Permanent verification error';
    return true;
  }

  release(phone) {
    const item = this.items.find((it) => it.phone === phone);
    if (!item) return false;
    if (item.status === 'verified' || item.status === 'permanent_error') return false;
    item.status = 'available';
    item.assignedTo = null;
    return true;
  }

  releaseByEmail(email) {
    let count = 0;
    for (const item of this.items) {
      if (item.assignedTo === email && item.status === 'in_use') {
        item.status = 'available';
        item.assignedTo = null;
        count++;
      }
    }
    return count;
  }

  resetByEmail(email) {
    let count = 0;
    for (const item of this.items) {
      if (item.assignedTo === email && item.status !== 'verified') {
        item.status = 'available';
        item.assignedTo = null;
        item.errorMessage = null;
        count++;
      }
    }
    return count;
  }

  resetPermanentErrors() {
    let count = 0;
    for (const item of this.items) {
      if (item.status === 'permanent_error') {
        item.status = 'available';
        item.assignedTo = null;
        item.errorMessage = null;
        count++;
      }
    }
    return count;
  }

  getStats() {
    const stats = { total: this.items.length, available: 0, in_use: 0, verified: 0, permanent_error: 0 };
    for (const item of this.items) {
      if (item.status in stats) stats[item.status]++;
    }
    return stats;
  }

  clear() {
    this.items = [];
  }

  toJSON() {
    return this.items.map((item) => ({ ...item }));
  }

  toInputString() {
    return this.items.map((item) => `${item.phone}|${item.url}`).join('\n');
  }

  static fromJSON(json) {
    const pool = new VerificationPool();
    if (Array.isArray(json)) {
      pool.items = json.map((item) => ({
        phone: String(item.phone || ''),
        url: String(item.url || ''),
        status: ['available', 'in_use', 'verified', 'permanent_error'].includes(item.status)
          ? item.status
          : 'available',
        assignedTo: item.assignedTo || null,
        errorMessage: item.errorMessage || null,
        verifiedAt: item.verifiedAt || null
      })).filter((item) => item.phone && item.url);
    }
    return pool;
  }
}

module.exports = { VerificationPool };
