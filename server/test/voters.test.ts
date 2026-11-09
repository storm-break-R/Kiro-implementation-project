import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/auditLog.js';
import { EligibleVoter } from '../src/models/eligibleVoter.js';
import { VerificationCode } from '../src/models/verificationCode.js';
import { isAdult, parseIsoDate } from '../src/utils/age.js';
import { hashCode, hashNationalId } from '../src/utils/crypto.js';
import { csvCell, toCsv } from '../src/utils/csv.js';
import {
  bearer,
  buildTestApp,
  createEvent,
  enrolledAdmin,
  type Session,
  type TestContext,
} from './helpers/app.js';
import { clearCollections, connectTestDb, disconnectTestDb } from './helpers/db.js';
import { User } from '../src/models/user.js';

let ctx: TestContext;
let admin: Session;
let eventId: string;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearCollections();
  ctx = buildTestApp();
  admin = (await enrolledAdmin(ctx)).session;
  const adminUser = (await User.findOne({ role: 'admin' }))!;
  eventId = (await createEvent(adminUser._id, { status: 'draft' }))._id.toString();
});

const CSV = [
  'name,nationalId,dateOfBirth,email',
  'Alice Adams,AB-1001,1990-05-17,alice@example.com',
  'Bob Brown,BB1002,1985-12-01,',
  'Carl Child,CC1003,2015-01-01,carl@example.com',
].join('\n');

const importCsv = (csv: string | Buffer, id = eventId, token = admin) =>
  request(ctx.app)
    .post(`/api/admin/events/${id}/voters/import`)
    .set('Authorization', bearer(token))
    .attach('file', Buffer.from(csv), { filename: 'voters.csv', contentType: 'text/csv' });

const generate = (format: 'json' | 'csv' = 'json') =>
  request(ctx.app)
    .post(`/api/admin/events/${eventId}/codes/generate?format=${format}`)
    .set('Authorization', bearer(admin));

describe('utilities', () => {
  it('neutralizes spreadsheet formulas and quotes special characters', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('@sum')).toBe(`'@sum`);
    expect(csvCell('Doe, John')).toBe('"Doe, John"');
    expect(csvCell('plain')).toBe('plain');
    expect(toCsv(['a', 'b'], [['x', '=1']])).toBe("a,b\r\nx,'=1\r\n");
  });

  it('checks the 18th birthday exactly', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(isAdult(new Date('2008-06-15T00:00:00Z'), now)).toBe(true);
    expect(isAdult(new Date('2008-06-16T00:00:00Z'), now)).toBe(false);
    expect(isAdult(new Date('1990-01-01T00:00:00Z'), now)).toBe(true);
    // leap day birthday: turns 18 on Mar 1 in non-leap years
    expect(isAdult(new Date('2008-02-29T00:00:00Z'), new Date('2026-02-28T00:00:00Z'))).toBe(false);
    expect(isAdult(new Date('2008-02-29T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))).toBe(true);
  });

  it('parses only real calendar dates', () => {
    expect(parseIsoDate('2020-02-29')?.toISOString()).toBe('2020-02-29T00:00:00.000Z');
    expect(parseIsoDate('2021-02-29')).toBeNull();
    expect(parseIsoDate('01/02/2000')).toBeNull();
    expect(parseIsoDate('2000-13-01')).toBeNull();
  });
});

describe('voter list import', () => {
  it('imports valid rows, hashes national IDs, and flags under-18s', async () => {
    const res = await importCsv(CSV);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 3, skipped: 0, under18: 1, errors: [] });

    const rows = await EligibleVoter.find({ eventId }).lean();
    expect(rows).toHaveLength(3);
    const alice = rows.find((r) => r.fullName === 'Alice Adams')!;
    expect(alice.nationalIdHash).toBe(hashNationalId('AB1001', ctx.env.CODE_PEPPER));
    expect(alice.nationalIdLast4).toBe('1001');
    expect(JSON.stringify(rows)).not.toContain('AB1001');
  });

  it('reports row-level errors with row numbers and still imports the good rows', async () => {
    const csv = [
      'Name,National ID,DOB,Email',
      'Good One,GD0001,1990-01-01,good@example.com',
      ',NOID01,1990-01-01,',
      'Bad Date,BD0002,1990-02-31,',
      'Short Id,12,1990-01-01,',
      'Bad Email,BE0003,1990-01-01,not-an-email',
      'Dup Person,GD0001,1991-01-01,',
      'Future,FU0004,2999-01-01,',
    ].join('\n');
    const res = await importCsv(csv);
    expect(res.body.imported).toBe(1);
    const byRow = Object.fromEntries(res.body.errors.map((e: { row: number; message: string }) => [e.row, e.message]));
    expect(byRow[3]).toMatch(/name/);
    expect(byRow[4]).toMatch(/real date/);
    expect(byRow[5]).toMatch(/national ID/);
    expect(byRow[6]).toMatch(/email/);
    expect(byRow[7]).toMatch(/duplicate national ID/);
    expect(byRow[8]).toMatch(/plausible/);
    expect(await EligibleVoter.countDocuments({ eventId })).toBe(1);
  });

  it('rejects people already on the list when importing again', async () => {
    await importCsv(CSV);
    const again = await importCsv(CSV);
    expect(again.status).toBe(200);
    expect(again.body.imported).toBe(0);
    expect(again.body.errors).toHaveLength(3);
    expect(await EligibleVoter.countDocuments({ eventId })).toBe(3);
  });

  it('rejects malformed uploads', async () => {
    expect((await importCsv('a,b\n"unterminated,1')).status).toBe(400);
    expect((await importCsv('foo,bar\n1,2')).status).toBe(400);
    const none = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/voters/import`)
      .set('Authorization', bearer(admin));
    expect(none.status).toBe(400);
  });

  it('rejects uploads over the size limit', async () => {
    const res = await importCsv(Buffer.alloc(2 * 1024 * 1024 + 10, 'a'));
    expect(res.status).toBe(413);
  });

  it('refuses changes to a closed event', async () => {
    const adminUser = (await User.findOne({ role: 'admin' }))!;
    const closed = await createEvent(adminUser._id, { status: 'closed' });
    expect((await importCsv(CSV, closed._id.toString())).status).toBe(409);
  });

  it('requires an authenticated admin', async () => {
    const res = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/voters/import`)
      .attach('file', Buffer.from(CSV), 'v.csv');
    expect(res.status).toBe(401);
  });
});

describe('verification codes', () => {
  beforeEach(async () => {
    await importCsv(CSV);
  });

  it('issues one unique code per voter and stores only keyed hashes', async () => {
    const res = await generate();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.generated).toBe(3);

    const codes: string[] = res.body.codes.map((c: { code: string }) => c.code);
    expect(new Set(codes).size).toBe(3);
    codes.forEach((c) => expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){2}$/));

    const stored = await VerificationCode.find({ eventId }).lean();
    expect(stored).toHaveLength(3);
    const hashes = new Set(stored.map((s) => s.codeHash));
    codes.forEach((c) => expect(hashes.has(hashCode(c, ctx.env.CODE_PEPPER))).toBe(true));
    const dump = JSON.stringify(stored);
    codes.forEach((c) => expect(dump).not.toContain(c));
    expect(stored.every((s) => s.used === false)).toBe(true);
  });

  it('is idempotent: a second run only issues codes to new voters', async () => {
    await generate();
    expect((await generate()).body.generated).toBe(0);

    await importCsv('name,nationalId,dateOfBirth\nNew Person,NP0001,1991-01-01');
    const third = await generate();
    expect(third.body.generated).toBe(1);
    expect(third.body.codes[0].fullName).toBe('New Person');
    expect(await VerificationCode.countDocuments({ eventId })).toBe(4);
  });

  it('can return a CSV download, neutralizing formula injection in names', async () => {
    await importCsv('name,nationalId,dateOfBirth\n=cmd|calc,EV0001,1991-01-01');
    const res = await generate('csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('name,email,nationalIdLast4,verificationCode');
    expect(lines).toHaveLength(5);
    expect(res.text).toContain("'=cmd|calc");
  });

  it('regenerates a code for an unregistered voter and invalidates the old one', async () => {
    const first = await generate();
    const target = first.body.codes[0];
    const res = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/voters/${target.voterId}/code`)
      .set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    const fresh = res.body.codes[0].code;
    expect(fresh).not.toBe(target.code);

    expect(await VerificationCode.exists({ codeHash: hashCode(target.code, ctx.env.CODE_PEPPER) })).toBeNull();
    expect(await VerificationCode.exists({ codeHash: hashCode(fresh, ctx.env.CODE_PEPPER) })).not.toBeNull();
    expect(await VerificationCode.countDocuments({ eventId })).toBe(3);
  });

  it('gives a first code to a voter that has none via the same endpoint', async () => {
    const voter = (await EligibleVoter.findOne({ eventId }))!;
    const res = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/voters/${voter._id}/code`)
      .set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(await VerificationCode.countDocuments({ eventId })).toBe(1);
  });

  it('refuses to replace a used code or touch a registered voter', async () => {
    const issued = (await generate()).body.codes;
    const [a, b] = issued as Array<{ voterId: string }>;
    await VerificationCode.updateOne({ eligibleVoterId: a!.voterId }, { used: true });
    const usedRes = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/voters/${a!.voterId}/code`)
      .set('Authorization', bearer(admin));
    expect(usedRes.status).toBe(409);

    await EligibleVoter.updateOne({ _id: b!.voterId }, { userId: (await User.findOne())!._id });
    const regRes = await request(ctx.app)
      .post(`/api/admin/events/${eventId}/voters/${b!.voterId}/code`)
      .set('Authorization', bearer(admin));
    expect(regRes.status).toBe(409);
  });

  it('never writes plaintext codes to the audit log', async () => {
    const issued = (await generate()).body.codes as Array<{ code: string }>;
    const dump = JSON.stringify(await AuditLog.find().lean());
    issued.forEach((c) => expect(dump).not.toContain(c.code));
    expect(dump).toContain('codes.generated');
  });
});

describe('voter list management', () => {
  beforeEach(async () => {
    await importCsv(CSV);
  });

  it('lists voters with code and registration status, totals, search and paging', async () => {
    await generate();
    const all = await request(ctx.app)
      .get(`/api/admin/events/${eventId}/voters`)
      .set('Authorization', bearer(admin));
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.totals).toEqual({ eligible: 3, registered: 0, codesIssued: 3 });
    expect(all.body.voters[0]).toHaveProperty('codeStatus', 'unused');
    expect(JSON.stringify(all.body)).not.toContain('dateOfBirth');

    const search = await request(ctx.app)
      .get(`/api/admin/events/${eventId}/voters?q=alice`)
      .set('Authorization', bearer(admin));
    expect(search.body.voters.map((v: { fullName: string }) => v.fullName)).toEqual(['Alice Adams']);

    const page = await request(ctx.app)
      .get(`/api/admin/events/${eventId}/voters?limit=2&page=2`)
      .set('Authorization', bearer(admin));
    expect(page.body.voters).toHaveLength(1);
  });

  it('treats search text literally (no regex injection)', async () => {
    const res = await request(ctx.app)
      .get(`/api/admin/events/${eventId}/voters?q=${encodeURIComponent('.*')}`)
      .set('Authorization', bearer(admin));
    expect(res.body.total).toBe(0);
  });

  it('removes an unregistered voter together with their code', async () => {
    const issued = (await generate()).body.codes as Array<{ voterId: string }>;
    const res = await request(ctx.app)
      .delete(`/api/admin/events/${eventId}/voters/${issued[0]!.voterId}`)
      .set('Authorization', bearer(admin));
    expect(res.status).toBe(204);
    expect(await EligibleVoter.countDocuments({ eventId })).toBe(2);
    expect(await VerificationCode.countDocuments({ eventId })).toBe(2);
  });
});
