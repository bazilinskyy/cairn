'use strict';
// Your to-dos in Things 3 (Cultured Code), read straight from its database on this Mac, read-only, never written:
// the open ones and those done, for the coming trips' checks (is there a check-in to-do for that flight?) and for the
// trips your to-dos say you made ("trip to Gent", done in June 2023) that nothing else in Cairn knows. The database is
// found by itself (things_db "auto" in config) or given as a path; "" turns it off.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const GROUP = path.join(os.homedir(), 'Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac');

// Things keeps a day as one number: the year, month and day packed in bits (year << 16 | month << 12 | day << 7)
const day = n => (n ? `${n >> 16}-${String((n >> 12) & 15).padStart(2, '0')}-${String((n >> 7) & 31).padStart(2, '0')}` : null);
const unixDay = s => (s ? new Date(s * 1000).toISOString().slice(0, 10) : null);

function create({ db, log = console.log }) {
  function file() {
    const v = db();
    if (!v) return null;
    if (v !== 'auto') return fs.existsSync(v) ? v : null;
    try {
      const dir = fs.readdirSync(GROUP).find(d => d.startsWith('ThingsData-'));
      const f = dir && path.join(GROUP, dir, 'Things Database.thingsdatabase', 'main.sqlite');
      return f && fs.existsSync(f) ? f : null;
    } catch (_) { return null; }
  }
  const available = () => !!file();

  function query(sql) {
    const f = file();
    if (!f) return Promise.resolve([]);
    return new Promise(resolve => execFile('sqlite3', ['-readonly', '-json', `file:${f}?mode=ro`, sql], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
      (err, out) => { if (err) { log(`[things] ${err.message.split('\n')[0]}`); return resolve([]); } try { resolve(out.trim() ? JSON.parse(out) : []); } catch (_) { resolve([]); } }));
  }

  // The to-dos, open and done since `since` (YYYY-MM-DD), with their checklists: { uuid, title, notes, status (open,
  // done, canceled), project, start, deadline, done, checklist: [title] }
  async function todos({ since = '' } = {}) {
    const after = since ? Date.parse(since) / 1000 : 0;
    const rows = await query(`select t.uuid, t.title, coalesce(t.notes,'') notes, t.status, t.startDate, t.deadline, t.stopDate,
      coalesce(p.title,'') project from TMTask t left join TMTask p on p.uuid = t.project
      where t.type = 0 and t.trashed = 0 and (t.status = 0 or t.stopDate >= ${after})`);
    const items = await query(`select c.task, c.title from TMChecklistItem c join TMTask t on t.uuid = c.task
      where t.type = 0 and t.trashed = 0 and (t.status = 0 or t.stopDate >= ${after})`);
    const lists = new Map();
    items.forEach(c => { if (!lists.has(c.task)) lists.set(c.task, []); lists.get(c.task).push(c.title); });
    return rows.map(r => ({ uuid: r.uuid, title: r.title, notes: r.notes, status: ['open', 'open', 'canceled', 'done'][r.status] || 'open',
      project: r.project, start: day(r.startDate), deadline: day(r.deadline), done: unixDay(r.stopDate), checklist: lists.get(r.uuid) || [] }));
  }

  // "trip to X" to-dos marked done: [{ uuid, title, place, done }]
  async function doneTrips() {
    const rows = await query(`select uuid, title, stopDate from TMTask where type = 0 and trashed = 0 and status = 3
      and lower(title) like 'trip to %' order by stopDate`);
    return rows.map(r => ({ uuid: r.uuid, title: r.title, done: unixDay(r.stopDate),
      place: r.title.replace(/^trip to\s+/i, '').replace(/\s+(during|in|with|for|prize|before|after)\b.*$/i, '').trim() }))
      .filter(r => r.place && !/draw|prize/i.test(r.title));
  }

  return { available, todos, doneTrips };
}

module.exports = { create, day };
