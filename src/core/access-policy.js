"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MODES = ["public", "invite", "staff"];
const unavailable = () => Object.assign(new Error("Access policy storage is unavailable. Try again shortly."), { status: 503, code: "ACCESS_POLICY_UNAVAILABLE" });

function validate(values) {
  return MODES.includes(values.mode) && typeof values.waitlistOpen === "boolean" && typeof values.testMode === "boolean";
}

class AccessPolicy {
  constructor({ dataDir, enabled, waitlistOpen, persistence }) {
    this.file = path.join(dataDir, "access-policy.json");
    this.persistence = persistence?.enabled ? persistence : null;
    this.state = { mode: enabled ? "invite" : "public", waitlistOpen, testMode: false, revision: 0, updatedAt: null };
    this.loaded = false;
    this.retryAfter = 0;
    this.loading = null;
    this.writing = Promise.resolve();
  }

  async ready() {
    if (this.loaded) return;
    if (!this.loading) {
      if (Date.now() < this.retryAfter) throw unavailable();
      this.loading = (async () => {
        try {
          const stored = this.persistence
            ? await this.persistence.loadAccessPolicy()
            : await fs.promises.readFile(this.file, "utf8").then(JSON.parse).catch(err => { if (err.code === "ENOENT") return null; throw err; });
          if (stored !== null) {
            if (!stored || !validate(stored) || !Number.isSafeInteger(stored.revision) || stored.revision < 1)
              throw new Error("Invalid access policy");
            this.state = { mode: stored.mode, waitlistOpen: stored.waitlistOpen, testMode: stored.testMode, revision: stored.revision, updatedAt: stored.updatedAt || null };
          }
          this.loaded = true;
        } catch {
          this.retryAfter = Date.now() + 5000;
          throw unavailable();
        }
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  decision({ staff = false, invited = false } = {}) {
    const { mode, waitlistOpen } = this.state;
    return {
      browse: staff || mode === "public" || (mode === "invite" && invited),
      waitlist: waitlistOpen,
      redeemInvite: mode !== "staff",
    };
  }

  update(input) {
    const task = this.writing.then(async () => {
      await this.ready();
      const { mode, waitlistOpen, testMode, revision } = input || {};
      if (!validate({ mode, waitlistOpen, testMode }) || !Number.isSafeInteger(revision))
        throw Object.assign(new Error("Choose a valid access mode and settings."), { status: 400, code: "ACCESS_POLICY_INVALID" });
      const previous = this.state;
      if (previous.revision !== revision)
        throw Object.assign(new Error("The policy changed. Refresh and review the current settings."), { status: 409, code: "ACCESS_POLICY_CONFLICT" });
      if (previous.mode === mode && previous.waitlistOpen === waitlistOpen && previous.testMode === testMode) return previous;
      const next = { mode, waitlistOpen, testMode, revision: revision + 1, updatedAt: new Date().toISOString() };
      try {
        if (this.persistence) await this.persistence.saveAccessPolicy(next);
        else {
          await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
          const tmp = `${this.file}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
          await fs.promises.rename(tmp, this.file);
        }
      } catch { throw unavailable(); }
      this.state = next;
      return next;
    });
    this.writing = task.catch(() => {});
    return task;
  }
}

module.exports = { AccessPolicy };
