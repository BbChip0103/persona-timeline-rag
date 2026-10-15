import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocate, readOnlyPool, reviewRoot, run, selectDatabaseReview, type Queryable } from './review-sample';

test('kind synthetic review uses an emptyDir root', () => {
  expect(reviewRoot('/app', { PTR_MAINTENANCE_SYNTHETIC_ONLY: '1' })).toBe('/tmp/ptr-maintenance-review-root');
  expect(reviewRoot('/app', {})).toBe('/app');
});

// Pass-through wrapper so one test can make the sheet write fail (node:fs/promises properties cannot be spied on).
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, writeFile: jest.fn(actual.writeFile) };
});

// Synthetic data only: every text below is invented for the test.
const S = {
  user: 'SENTINEL_USER_TEXT_q1', reply: 'SENTINEL_REPLY_TEXT_r1', owner: 'SENTINEL_OWNER_o1', person: 'SENTINEL_PERSON_p1',
  persona: 'SENTINEL_PERSONA_x1', turn: 'SENTINEL_TURN_t1', url: 'https://example.invalid/SENTINEL_URL_u1', s8Text: 'SENTINEL_S8_TEXT_s1',
  s8Reply: 'SENTINEL_S8_REPLY_s2', error: 'SENTINEL_ERROR_e1', quote: 'SENTINEL_EVIDENCE_QUOTE_q2',
};
const OWNER = (n: number) => `local-${n.toString(16).padStart(40, '0')}`;
const NOW = new Date('2026-10-10T03:00:00Z');
const RESEARCH_URL = 'postgresql://ptr_split_owner:pw@127.0.0.1:58432/ptr_split_research';

type Row = { id: string; owner_id: string; persona_id: string; review_status: string | null; finished_at: string; user_text: string; reply: unknown };
function reply(i: number, extra: Record<string, unknown> = {}) {
  const kinds = ['small_talk', 'timeline', 'clarification'];
  return { responseKind: kinds[i % 3], grounding: i % 4 === 0 ? 'source_bound_quotes' : 'unverified_model', content: `${S.reply} ${i}`,
    personId: S.person, evidence: [{ sourceUrl: S.url, quote: 'q' }], replyGuard: { revision: 'g1', action: i % 7 === 0 ? 'edited' : 'none' },
    ...(i % 9 === 0 ? { inputSafety: { decidedBy: 'rule', action: 'deflect', fired: [] } } : {}), ...extra };
}
function dbRows(personas = 4, perPersona = 20): Row[] {
  const rows: Row[] = [];
  for (let p = 0; p < personas; p++) for (let i = 0; i < perPersona; i++)
    rows.push({ id: `${S.turn}-${p}-${i}`, owner_id: i === 0 ? `local-${S.owner}` : OWNER(p * 100 + i), persona_id: `${S.persona}-${p}`, review_status: 'silver',
      finished_at: '2026-10-08T05:00:00Z', user_text: `${S.user} ${p}-${i}`, reply: reply(i) });
  return rows;
}
function fakePool(rows: Row[], opts: { readOnly?: string; fail?: boolean; personas?: string[]; database?: string; username?: string } = {}) {
  const calls: string[] = [];
  const pool: Queryable & { calls: string[]; ended: boolean } = {
    calls, ended: false,
    async query(sql: string) {
      calls.push(sql);
      if (opts.fail) { const e = new Error(`boom ${S.error}`) as Error & { code: string }; e.code = '42P01'; throw e; }
      if (/^SHOW default_transaction_read_only/i.test(sql)) return { rows: [{ default_transaction_read_only: opts.readOnly ?? 'on' }] };
      if (/current_database\(\)/.test(sql)) return { rows: [{ database: opts.database ?? 'ptr_split_research', username: opts.username ?? 'ptr_split_owner' }] };
      if (/FROM llm\.personas p/.test(sql)) return { rows: (opts.personas ?? [...new Set(rows.map(row => row.persona_id))].sort()).map(id => ({ id })) };
      return { rows };
    },
    async end() { pool.ended = true; },
  };
  return pool;
}
async function s8Dir(root: string, name = 'v99', labels = ['A', 'B', 'C', 'D']): Promise<string> {
  const dir = join(root, 'reports', 's8', name);
  await mkdir(dir, { recursive: true });
  const make = (kind: string, prefix: string) => ({ createdAt: '2026-10-07T01:00:00Z', summary: { kind },
    rows: [...labels, 'S-ko', 'S-en'].flatMap(persona => [1, 2, 3].map(q => ({ persona, question: `${prefix}-${q}`, turn: 1, text: `${S.s8Text} ${persona}${q}`,
      state: 'completed', content: `${S.s8Reply} ${persona}${q}`, replyGuard: { action: q === 2 ? 'replaced' : 'none' }, safety: null }))) });
  await writeFile(join(dir, 'run-disclosure.json'), JSON.stringify(make('disclosure', 'd-ko')));
  await writeFile(join(dir, 'run-background.json'), JSON.stringify(make('background', 'e')));
  await writeFile(join(dir, 'run-everyday.json'), JSON.stringify(make('everyday', 'f-en')));
  await writeFile(join(dir, 'run-injection.json'), JSON.stringify(make('injection', 'b')));
  await writeFile(join(dir, 'summary.json'), JSON.stringify(make('disclosure', 'd-en')));
  return dir;
}
async function harness(rows: Row[] = dbRows(), poolOpts: Parameters<typeof fakePool>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'review-sample-'));
  const out: string[] = [], err: string[] = [];
  const pool = fakePool(rows, poolOpts);
  const connected: string[] = [];
  const deps = { root, env: { PTR_LLM_MAINTENANCE_DATABASE_URL: RESEARCH_URL } as Record<string, string | undefined>, now: NOW, salt: Buffer.from('fixed-test-salt'),
    connect: (url: string) => { connected.push(url); return pool; }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  return { root, out, err, pool, connected, deps };
}
const sheetPath = (root: string, seed = 7) => join(root, 'reports', 'review', `2026-10-10-${seed}.private.md`);
const tracePath = (root: string, seed = 7) => join(root, 'reports', 'review', `2026-10-10-${seed}.trace.private.json`);
const rowsIn = (sheet: string) => sheet.split('\n').filter(line => /^### R\d+/.test(line));

describe('allocate', () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `common-${i}`, stratum: 'common' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `mid-${i}`, stratum: 'mid' })),
    { id: 'rare-0', stratum: 'rare' }, { id: 'rare2-0', stratum: 'rare2' },
  ];
  it('takes at least one from each nonempty stratum, rare strata first, and is reproducible by seed', () => {
    const picked = allocate(items, 6, 11);
    expect(picked).toHaveLength(6);
    expect(new Set(picked.map(p => p.stratum))).toEqual(new Set(['common', 'mid', 'rare', 'rare2']));
    expect(picked.slice(0, 2).map(p => p.stratum).sort()).toEqual(['rare', 'rare2']);
    expect(allocate([...items].reverse(), 6, 11).map(p => p.id)).toEqual(picked.map(p => p.id));
    const seeds = new Set([1, 2, 3, 4, 5].map(seed => allocate(items, 6, seed).map(p => p.id).join(',')));
    expect(seeds.size).toBeGreaterThan(1);
  });
  it('prefers rare strata when there are more strata than the quota, and never exceeds the pool', () => {
    const many = [...Array.from({ length: 8 }, (_, s) => Array.from({ length: s + 1 }, (_, i) => ({ id: `s${s}-${i}`, stratum: `s${s}` }))).flat()];
    // More strata than the quota: the rarest fill all but one slot, and the most common stratum always gets one.
    expect(allocate(many, 3, 1).map(p => p.stratum).sort()).toEqual(['s0', 's1', 's7']);
    for (const seed of [1, 2, 3]) expect(allocate(many, 6, seed).map(p => p.stratum).sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's7']);
    // No more strata than the quota: unchanged (every stratum once, then rarest first).
    expect(allocate(many.filter(p => ['s0', 's1', 's7'].includes(p.stratum)), 3, 1).map(p => p.stratum).sort()).toEqual(['s0', 's1', 's7']);
    expect(allocate(items.slice(0, 4), 6, 1)).toHaveLength(4);
  });
});

describe('review-sample run', () => {
  let roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.map(r => rm(r, { recursive: true, force: true }))); roots = []; });
  async function go(argv: string[], h: Awaited<ReturnType<typeof harness>>) { roots.push(h.root); return run(argv, h.deps); }

  it('writes 8 rows per persona (DB 6 + S8 2) to a 0600 sheet in a 0700 directory and prints counts only', async () => {
    const h = await harness();
    await s8Dir(h.root);
    const code = await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99', '--s8', 'reports/s8/../s8/v99'], h);
    expect(code).toBe(0);
    const sheet = await readFile(sheetPath(h.root), 'utf8');
    const lines = rowsIn(sheet);
    expect(lines).toHaveLength(32);
    for (const p of ['P1', 'P2', 'P3', 'P4']) expect(lines.filter(l => l.includes(` ${p} `))).toHaveLength(6);
    for (const p of ['S8-A', 'S8-B', 'S8-C', 'S8-D']) expect(lines.filter(l => l.includes(` ${p} `))).toHaveLength(2);
    expect(lines.some(l => /S8-S/.test(l))).toBe(false);
    expect((await stat(sheetPath(h.root))).mode & 0o777).toBe(0o600);
    expect((await stat(join(h.root, 'reports', 'review'))).mode & 0o777).toBe(0o700);
    expect(h.out).toHaveLength(1);
    // s8Population 36 = 4 labels x 9 gate d/e/f rows: the directory given twice is read once.
    expect(JSON.parse(h.out[0]!)).toMatchObject({ rows: 32, db: 24, s8: 8, personas: 8, pruned: 0, dbSkipped: false, s8Population: 36 });
    expect(h.err).toEqual([]);
    expect(h.pool.ended).toBe(true);
  });

  it('keeps the full utterance and reply in the sheet only, and masks every identifier', async () => {
    const h = await harness();
    await s8Dir(h.root);
    await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99'], h);
    const sheet = await readFile(sheetPath(h.root), 'utf8');
    expect(sheet).toContain(S.user);
    expect(sheet).toContain(S.reply);
    expect(sheet).toContain(S.s8Reply);
    for (const hidden of [S.owner, 'local-0000', S.person, S.persona, S.turn, S.url, 'example.invalid', 'v99', 'run-disclosure']) expect(sheet).not.toContain(hidden);
    expect(sheet).toMatch(/id [0-9a-f]{10}\b/);
    expect(sheet).not.toMatch(/T\d{2}:\d{2}/);
  });

  it('puts bound evidence and exact quotes in the private operator sheet without exposing them on stdout', async () => {
    const rows = dbRows(1, 20).map(row => ({ ...row, reply: reply(1, { grounding: 'source_bound_quotes', evidence: [
      { sourceId: 'SENTINEL_SOURCE_id1', sourceUrl: S.url, origin: 'source_caption', postedAt: '2026-01-02', eventDate: null, quote: S.quote },
    ] }) }));
    const h = await harness(rows);
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(0);
    const sheet = await readFile(sheetPath(h.root), 'utf8');
    expect(sheet).toContain('**인용 근거**');
    expect(sheet).toContain(`> ${S.quote}`);
    expect(sheet).toContain('게시일 2026-01-02');
    expect(sheet).not.toContain('SENTINEL_SOURCE_id1');
    expect(sheet).not.toContain(S.url);
    expect([...h.out, ...h.err].join('\n')).not.toContain(S.quote);
  });

  it('writes a 0600 trace sidecar with the salt and the masked id -> turn id map, matching the sheet', async () => {
    const h = await harness();
    await s8Dir(h.root);
    expect(await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99'], h)).toBe(0);
    expect((await stat(tracePath(h.root))).mode & 0o777).toBe(0o600);
    const trace = JSON.parse(await readFile(tracePath(h.root), 'utf8')) as { sheet: string; salt: string; rows: { row: string; id: string; source: string; turnId?: string; s8?: string }[] };
    expect(trace.sheet).toBe('2026-10-10-7.private.md');
    expect(trace.salt).toBe(Buffer.from('fixed-test-salt').toString('hex'));
    const sheetIds = rowsIn(await readFile(sheetPath(h.root), 'utf8')).map(l => /id ([0-9a-f]{10})$/.exec(l)![1]);
    expect(trace.rows.map(r => r.id)).toEqual(sheetIds);
    expect(trace.rows.map(r => r.row)).toEqual(sheetIds.map((_, i) => `R${String(i + 1).padStart(2, '0')}`));
    const fixtureIds = new Set(dbRows().map(r => r.id));
    for (const row of trace.rows.filter(r => r.source === 'DB')) {
      expect(fixtureIds.has(row.turnId!)).toBe(true);
      expect(createHash('sha256').update(Buffer.from(trace.salt, 'hex')).update(`turn:${row.turnId}`).digest('hex').slice(0, 10)).toBe(row.id);
    }
    expect(trace.rows.filter(r => r.source === 'S8').every(r => /^v99\/run-[a-z]+\.json#[A-D]\/[def]-/.test(r.s8!))).toBe(true);
    expect(h.out.join('\n')).not.toContain(trace.salt);
  });

  it('removes the trace when the sheet write fails, so a retry is not blocked', async () => {
    const h = await harness();
    const actual = jest.requireActual<typeof fsp>('node:fs/promises');
    const mocked = fsp.writeFile as jest.MockedFunction<typeof fsp.writeFile>;
    mocked.mockImplementation(((file: string, ...rest: unknown[]) => String(file).endsWith('.private.md')
      ? Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })) : (actual.writeFile as (...a: unknown[]) => Promise<void>)(file, ...rest)) as typeof fsp.writeFile);
    try { expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(1); } finally { mocked.mockImplementation(actual.writeFile); }
    expect(h.err.join('\n')).toMatch(/failed ENOSPC/);
    expect(await readdir(join(h.root, 'reports', 'review'))).toEqual([]);
    h.err.length = 0;
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(0);
  });

  it('accepts versioned S8 run folders such as reports/s8/<rev>/everyday (gate f)', async () => {
    const h = await harness(dbRows(1, 5));
    const dir = join(h.root, 'reports', 's8', 'v12', 'everyday');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run0.json'), JSON.stringify({ createdAt: '2026-10-07T01:00:00Z', summary: { kind: 'everyday' },
      rows: ['A', 'S-ko'].flatMap(persona => [1, 2, 3].map(q => ({ persona, question: `f-ko-${q}`, turn: 1, text: `synthetic ${q}`, state: 'completed', content: `synthetic reply ${q}` }))) }));
    expect(await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v12/everyday'], h)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ s8: 2, s8Population: 3, rows: 2 });
    expect(rowsIn(await readFile(sheetPath(h.root), 'utf8')).every(l => l.includes(' S8-A '))).toBe(true);
  });

  it('never writes sentinel text, ids or error messages to stdout or stderr', async () => {
    const all = Object.values(S);
    const ok = await harness();
    await s8Dir(ok.root);
    await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99'], ok);
    const failing = await harness(dbRows(), { fail: true });
    expect(await go(['--since', '7d', '--seed', '7'], failing)).toBe(1);
    const badS8 = await harness();
    await mkdir(join(badS8.root, 'reports', 's8', 'bad'), { recursive: true });
    await writeFile(join(badS8.root, 'reports', 's8', 'bad', 'run-x.json'), `{"rows":[${JSON.stringify(S.s8Text)}`);
    expect(await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/bad'], badS8)).toBe(1);
    const printed = [...ok.out, ...ok.err, ...failing.out, ...failing.err, ...badS8.out, ...badS8.err].join('\n');
    for (const value of all) expect(printed).not.toContain(value);
    expect(printed).not.toMatch(/local-|ptr_research|pw@/);
    expect(failing.err.join('\n')).toMatch(/failed .*42P01/);
  });

  it('excludes turns served by the fake model (reply.serving), synthetic personas, non-local owners and empty replies', async () => {
    // reply.serving : real upstreams are kept; turns stored before O4 have no serving and stay eligible.
    const servings = [{ calls: 1, upstreams: ['primary'], secondaryCalls: 0 }, { calls: 2, upstreams: ['primary', 'secondary'], secondaryCalls: 1 },
      { calls: 1, upstreams: ['openrouter'], secondaryCalls: 0 }, undefined];
    const rows = dbRows(1, 25).map((row, i) => ({ ...row, user_text: `keep-${i}`, reply: reply(i, servings[i % 4] ? { serving: servings[i % 4] } : {}) }));
    const bad: Row[] = [
      { ...rows[0]!, id: 'b1', owner_id: 'lt-x', user_text: 'DROP-owner-lt' },
      { ...rows[0]!, id: 'b2', owner_id: 'owner_synthetic_a', user_text: 'DROP-owner-synth' },
      { ...rows[0]!, id: 'b3', review_status: 'synthetic', user_text: 'DROP-persona' },
      // Any call answered by the fake model (in-process, or the gateway's fake upstream) drops the turn.
      { ...rows[0]!, id: 'b4', reply: reply(1, { serving: { calls: 1, upstreams: ['fake'], secondaryCalls: 0 } }), user_text: 'DROP-serving-fake' },
      { ...rows[0]!, id: 'b5', reply: reply(1, { serving: { calls: 2, upstreams: ['primary', 'fake'], secondaryCalls: 0 } }), user_text: 'DROP-serving-mixed' },
      // A serving record that does not have the D21 shape fails closed.
      { ...rows[0]!, id: 'b8', reply: reply(1, { serving: { calls: 1 } }), user_text: 'DROP-serving-shape' },
      { ...rows[0]!, id: 'b9', reply: reply(1, { serving: 'primary' }), user_text: 'DROP-serving-string' },
      { ...rows[0]!, id: 'b10', reply: reply(1, { serving: { calls: 1, upstreams: [7], secondaryCalls: 0 } }), user_text: 'DROP-serving-number' },
      // Only known real upstreams count (fail-closed): `unknown` cannot be told apart from a fake one.
      { ...rows[0]!, id: 'b11', reply: reply(1, { serving: { calls: 1, upstreams: ['unknown'], secondaryCalls: 0 } }), user_text: 'DROP-serving-unknown' },
      { ...rows[0]!, id: 'b6', reply: reply(1, { content: '' }), user_text: 'DROP-empty' },
      { ...rows[0]!, id: 'b7', reply: null, user_text: 'DROP-null' },
    ];
    // 25 eligible rows plus the excluded ones, repeated so that a leak would almost surely be sampled.
    const h = await harness([...rows, ...Array.from({ length: 10 }, () => bad).flat().map((b, i) => ({ ...b, id: `${b.id}-${i}` }))]);
    expect(await go(['--since', '7d', '--seed', '3'], h)).toBe(0);
    const sheet = await readFile(sheetPath(h.root, 3), 'utf8');
    expect(sheet).not.toContain('DROP-');
    expect(JSON.parse(h.out[0]!)).toMatchObject({ population: 25, db: 6 });
  });

  it('samples S8 rows only when fewer than 20 eligible DB turns exist', async () => {
    const h = await harness(dbRows(2, 9));
    const dir = await s8Dir(h.root, 'v99', ['A']);
    await s8Dir(h.root, 'outside-target', ['B']);
    await symlink(join(h.root, 'reports', 's8', 'outside-target', 'run-disclosure.json'), join(dir, 'run-zz.json'));
    expect(await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99'], h)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ population: 18, db: 0, s8: 2, rows: 2, dbSkipped: true });
    const empty = await harness(dbRows(1, 5));
    expect(await go(['--since', '7d', '--seed', '7'], empty)).toBe(1);
    expect(empty.err.join('\n')).toMatch(/empty_sample/);
    await expect(readdir(join(empty.root, 'reports', 'review'))).resolves.toEqual([]);
  });

  it('is reproducible by seed', async () => {
    const a = await harness(), b = await harness(), c = await harness();
    for (const h of [a, b, c]) await s8Dir(h.root);
    await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99'], a);
    await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99'], b);
    await go(['--since', '7d', '--seed', '8', '--s8', 'reports/s8/v99'], c);
    const [sa, sb, sc] = await Promise.all([readFile(sheetPath(a.root), 'utf8'), readFile(sheetPath(b.root), 'utf8'), readFile(sheetPath(c.root, 8), 'utf8')]);
    expect(sa).toBe(sb);
    expect(rowsIn(sa).join('\n')).not.toBe(rowsIn(sc).join('\n'));
  });

  it('refuses to overwrite a sheet, and rejects S8 paths outside reports/s8 and malformed arguments', async () => {
    const h = await harness();
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(0);
    const before = await readFile(sheetPath(h.root), 'utf8');
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(1);
    expect(h.err.join('\n')).toMatch(/sheet_exists/);
    expect(await readFile(sheetPath(h.root), 'utf8')).toBe(before);
    const t = await harness();
    await mkdir(join(t.root, 'reports', 'review'), { recursive: true });
    await writeFile(tracePath(t.root), '{}', { mode: 0o600 });
    expect(await go(['--since', '7d', '--seed', '7'], t)).toBe(1);
    expect(t.err.join('\n')).toMatch(/sheet_exists/);
    expect(t.connected).toEqual([]);

    const p = await harness();
    await mkdir(join(p.root, 'elsewhere'), { recursive: true });
    await s8Dir(p.root);
    await symlink(join(p.root, 'elsewhere'), join(p.root, 'reports', 's8', 'link'));
    for (const bad of ['elsewhere', 'reports/s8/../../elsewhere', 'reports/s8/link', 'reports/s8', '/tmp'])
      expect(await go(['--since', '7d', '--seed', '7', '--s8', bad], p)).toBe(1);
    expect(p.err.every(line => /s8_path/.test(line))).toBe(true);
    for (const argv of [['--since', '7d'], ['--since', '7d', '--seed', '../x'], ['--since', '7d', '--seed', '-1'], ['--since', '7x', '--seed', '1'],
      ['--since', '0d', '--seed', '1'], ['--seed', '1'], ['--since', '7d', '--seed', '1', '--out', 'x']])
      expect(await go(argv, p)).toBe(1);
    expect(p.connected).toEqual([]);
  });

  it('labels personas from every real persona, so a persona without turns this week does not shift the labels', async () => {
    const rows = dbRows(2, 15);
    const h = await harness(rows, { personas: [`${S.persona}-0`, `${S.persona}-0a`, `${S.persona}-1`] });
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(0);
    const lines = rowsIn(await readFile(sheetPath(h.root), 'utf8'));
    expect(lines.filter(l => l.includes(' P1 '))).toHaveLength(6);
    expect(lines.filter(l => l.includes(' P2 '))).toHaveLength(0);
    expect(lines.filter(l => l.includes(' P3 '))).toHaveLength(6);
  });

  it('refuses to run while a sheet older than 90 days exists, unless --prune removes it', async () => {
    const h = await harness();
    const dir = join(h.root, 'reports', 'review');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'notes.txt'), 'not a sheet');
    await utimes(join(dir, 'notes.txt'), new Date('2026-01-01'), new Date('2026-01-01'));
    await writeFile(join(dir, '2026-07-01-1.private.md'), 'old', { mode: 0o600 });
    await writeFile(join(dir, '2026-07-01-1.trace.private.json'), '{}', { mode: 0o600 });
    await writeFile(join(dir, '2026-07-20-2.private.md'), 'recent enough', { mode: 0o600 });
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(1);
    expect(h.err.join('\n')).toMatch(/retention stale=2/);
    expect(h.connected).toEqual([]);
    expect(await go(['--since', '7d', '--seed', '7', '--prune'], h)).toBe(0);
    expect((await readdir(dir)).sort()).toEqual(['2026-07-20-2.private.md', '2026-10-10-7.private.md', '2026-10-10-7.trace.private.json', 'notes.txt']);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ pruned: 2 });
  });

  it('only connects to the explicit local split owner database and refuses a session that is not read-only', async () => {
    const wrong = await harness();
    wrong.deps.env = { DATABASE_URL: 'postgresql://ptr_loadtester:pw@127.0.0.1:56432/ptr_loadtest' };
    expect(await go(['--since', '7d', '--seed', '7'], wrong)).toBe(1);
    expect(wrong.err.join('\n')).toMatch(/database_url/);
    expect(wrong.connected).toEqual([]);
    const missing = await harness();
    missing.deps.env = {};
    expect(await go(['--since', '7d', '--seed', '7'], missing)).toBe(1);
    const writable = await harness(dbRows(), { readOnly: 'off' });
    expect(await go(['--since', '7d', '--seed', '7'], writable)).toBe(1);
    expect(writable.err.join('\n')).toMatch(/not_read_only/);
    expect(writable.pool.calls).toHaveLength(1);
    expect(writable.pool.ended).toBe(true);
  });

  it.each([
    {},
    { DATABASE_URL: RESEARCH_URL },
    { PTR_LLM_MAINTENANCE_DATABASE_URL: RESEARCH_URL.replace('ptr_split_owner', 'ptr_split_llm') },
    { PTR_LLM_MAINTENANCE_DATABASE_URL: RESEARCH_URL.replace('58432', '56432') },
    { PTR_LLM_MAINTENANCE_DATABASE_URL: RESEARCH_URL.replace('127.0.0.1', 'example.invalid') },
    { PTR_LLM_MAINTENANCE_DATABASE_URL: RESEARCH_URL.replace('ptr_split_research', 'ptr_split_other') },
    { PTR_LLM_MAINTENANCE_DATABASE_URL: `${RESEARCH_URL}?options=unsafe` },
    { PTR_LLM_MAINTENANCE_DATABASE_URL: 'not-a-url' },
  ])('refuses unauthorized maintenance targets before connecting: %j', async env => {
    const h = await harness();
    h.deps.env = env;
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(1);
    expect(h.connected).toEqual([]);
    expect(h.err).toEqual(['review-sample: database_url']);
    expect(h.err.join('')).not.toContain('pw');
  });

  it.each([
    { username: 'ptr_split_llm' },
    { database: 'ptr_split_test' },
    { username: 'ptr_researcher', database: 'ptr_research' },
  ])('refuses actual connection identity mismatch before content reads: %j', async identity => {
    const h = await harness(dbRows(), identity);
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(1);
    expect(h.err).toEqual(['review-sample: database_identity']);
    expect(h.pool.calls).toHaveLength(2);
    expect(h.pool.calls.join('\n')).not.toMatch(/app\.turns|llm\.personas/);
    expect(h.pool.ended).toBe(true);
  });

  it('queries only schema-qualified split content after both identity and read-only checks', async () => {
    const h = await harness();
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(0);
    expect(h.connected).toEqual([RESEARCH_URL]);
    expect(h.pool.calls[0]).toBe('SHOW default_transaction_read_only');
    expect(h.pool.calls[1]).toMatch(/current_database\(\).*current_user/);
    expect(h.pool.calls[2]).toMatch(/FROM app\.turns t JOIN app\.sessions s/);
    expect(h.pool.calls[2]).toMatch(/JOIN llm\.persona_versions v/);
    expect(h.pool.calls[3]).toMatch(/FROM llm\.personas p JOIN llm\.persona_versions v/);
    expect(h.pool.calls.join('\n')).not.toMatch(/(?:FROM|JOIN) (?:turns|sessions|personas|persona_versions)\b/);
  });

  it('accepts the explicitly selected synthetic split database without ambient URL fallback', async () => {
    const h = await harness(dbRows(), { database: 'ptr_split_test' });
    const url = RESEARCH_URL.replace('ptr_split_research', 'ptr_split_test');
    h.deps.env = { PTR_LLM_MAINTENANCE_DATABASE_URL: url, DATABASE_URL: 'not-used' };
    expect(await go(['--since', '7d', '--seed', '7'], h)).toBe(0);
    expect(h.connected).toEqual([url]);
  });

  it('shares bounded split selection without creating local export files', async () => {
    const h = await harness();
    const selected = await selectDatabaseReview(7, 7, h.deps);
    expect(selected).toHaveLength(24);
    expect(selected.every(row => row.finishedAt === '2026-10-08T05:00:00.000Z')).toBe(true);
    expect(h.pool.calls[2]).toMatch(/t.finished_at <= \$2/);
    expect(h.pool.calls[2]).toMatch(/NOT EXISTS.*app\.turn_outbox/);
    expect(h.pool.calls[2]).toMatch(/LIMIT 10001/);
    expect(await readdir(h.root)).toEqual([]);
  });

  it('fails closed when the source population exceeds the bounded scan', async () => {
    const h = await harness(Array.from({ length: 10001 }, (_, i) => ({ ...dbRows(1, 1)[0]!, id: `bounded-${i}` })));
    await expect(selectDatabaseReview(7, 7, h.deps)).rejects.toThrow('population_limit');
    expect(h.pool.ended).toBe(true);
  });

  it('explicit scheduler empty allowance reports a skipped review with no sheet or trace', async () => {
    const h = await harness([]);
    expect(await go(['--since', '7d', '--seed', '7', '--allow-empty'], h)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ rows: 0, db: 0, s8: 0, population: 0, dbSkipped: true, emptySample: true });
    expect(await readdir(join(h.root, 'reports', 'review'))).toEqual([]);
    const manual = await harness([]);
    expect(await go(['--since', '7d', '--seed', '7'], manual)).toBe(1);
    expect(manual.err).toEqual(['review-sample: empty_sample population=0']);
  });

  it('sends nothing over the network: no fetch call, no network or provider imports', async () => {
    const original = globalThis.fetch;
    const fetchStub = jest.fn(() => { throw new Error('network'); });
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    try {
      const h = await harness();
      await s8Dir(h.root);
      expect(await go(['--since', '7d', '--seed', '7', '--s8', 'reports/s8/v99'], h)).toBe(0);
    } finally { globalThis.fetch = original; }
    expect(fetchStub).not.toHaveBeenCalled();
    const source = await readFile(join(__dirname, 'review-sample.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(['node:crypto', 'node:fs/promises', 'node:path', 'pg', '@ptr/storage']));
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  });
});

const integration = process.env.RUN_STORAGE_DB_TESTS === '1' && !!process.env.PTR_LLM_MAINTENANCE_DATABASE_URL ? describe : describe.skip;
integration('review-sample read-only pool (Postgres)', () => {
  it('opens sessions with default_transaction_read_only=on, so writes fail', async () => {
    const pool = readOnlyPool(process.env.PTR_LLM_MAINTENANCE_DATABASE_URL!);
    try {
      const { rows } = await pool.query('SHOW default_transaction_read_only');
      expect(rows[0]).toEqual({ default_transaction_read_only: 'on' });
      await expect(pool.query('CREATE TEMP TABLE review_sample_probe(x int)')).rejects.toMatchObject({ code: '25006' });
    } finally { await pool.end(); }
  });
});
