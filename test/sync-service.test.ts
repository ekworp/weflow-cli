import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncStateStore, emptySyncState } from '../src/services/syncState.js'
import {
  SyncRangeRequiredError,
  computeWindow,
  dedupeMessages,
  deriveCoverage,
  messageIdentity,
  runSync,
} from '../src/services/syncService.js'
import type { ShardReport } from '../src/core/ntCore.js'
import type { Message } from '../src/types.js'

const TALKER = 'wxid_synthetic_contact'
const SOURCE = 'wechat-nt'

function message(localId: number, createTime: number, serverId = ''): Message {
  return {
    localId,
    serverId,
    localType: 1,
    createTime,
    isSend: 0,
    senderUsername: 'synthetic-sender',
    senderDisplay: 'synthetic-sender',
    content: 'synthetic content',
    rawContent: 'synthetic content',
    parsedContent: 'synthetic content',
  }
}

function report(overrides: Partial<ShardReport> = {}): ShardReport {
  return {
    scanned: 2,
    opened: 2,
    failed: 0,
    items: [
      { name: 'message_0.db', opened: true, hasTalkerTable: true, rowsForTalker: 10, reason: null },
      { name: 'message_1.db', opened: true, hasTalkerTable: true, rowsForTalker: 5, reason: null },
    ],
    ...overrides,
  }
}

function withStore(run: (store: SyncStateStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'weflow-syncsvc-'))
  return run(new SyncStateStore(join(dir, 'sync'), join(dir, 'jobs')))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('a nonzero serverId is the identity, and localId alone never is', () => {
  const withServer = messageIdentity(SOURCE, TALKER, message(7, 100, '999'))
  const sameIdOtherTime = messageIdentity(SOURCE, TALKER, message(7, 200, '999'))
  assert.equal(withServer, sameIdOtherTime, 'serverId wins regardless of localId/time')

  // A bare localId restarts in every shard, so it must not be the identity.
  const a = messageIdentity(SOURCE, TALKER, message(7, 100, '0'))
  const b = messageIdentity(SOURCE, TALKER, message(7, 200, '0'))
  assert.notEqual(a, b)
  assert.ok(a.includes('t:100'))
})

test('the same localId in two conversations is not the same identity', () => {
  const here = messageIdentity(SOURCE, TALKER, message(7, 100))
  const there = messageIdentity(SOURCE, 'wxid_synthetic_other', message(7, 100))
  assert.notEqual(here, there)
})

test('dedupe keeps the first of each identity and counts the rest', () => {
  const overlap = [
    message(1, 100, 's1'),
    message(2, 200, 's2'),
    message(1, 100, 's1'),  // re-read by the overlap window
    message(3, 300, 's3'),
    message(2, 200, 's2'),  // re-read again
  ]
  const { unique, duplicateCount } = dedupeMessages(overlap, SOURCE, TALKER)
  assert.equal(unique.length, 3)
  assert.equal(duplicateCount, 2)
})

test('the window backs up by the overlap from the last checkpoint', () => {
  const prior = {
    ...emptySyncState(TALKER),
    checkpoint: { newestCreateTime: 1_700_000_000, overlapSeconds: 300 },
  }
  const window = computeWindow(prior, { now: 1_700_001_000 })
  // A second-resolution timestamp is not a cursor, so the boundary is re-read.
  assert.equal(window.from, 1_700_000_000 - 300)
  assert.equal(window.to, 1_700_001_000)
})

test('a first run without a starting point refuses instead of guessing', () => {
  assert.throws(() => computeWindow(null, {}), SyncRangeRequiredError)
  // Saying either of these explicitly is enough.
  assert.equal(computeWindow(null, { since: 100 }).from, 100)
  assert.equal(computeWindow(null, { full: true }).from, null)
})

test('coverage names the difference between complete, unverified and partial', () => {
  assert.equal(deriveCoverage({ shards: report(), mayHaveMore: false }), 'complete')
  // A shard that never opened: the read is not wrong, but it is not knowable.
  assert.equal(deriveCoverage({
    shards: report({ scanned: 3, opened: 2, failed: 1 }), mayHaveMore: false,
  }), 'unverified')
  // A shard that opened and then faulted: its rows are only partly read.
  assert.equal(deriveCoverage({
    shards: report({
      items: [{ name: 'message_1.db', opened: true, hasTalkerTable: null,
                rowsForTalker: null, reason: 'READ_FAILED' }],
    }),
    mayHaveMore: false,
  }), 'partial')
  assert.equal(deriveCoverage({ shards: report(), mayHaveMore: true }), 'partial')
  // A backend that cannot report shards must not be read as "all read".
  assert.equal(deriveCoverage({ mayHaveMore: false }), 'unverified')
})

test('a completed run advances both timestamps and writes state plus a job', async () => {
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store,
      since: 1_700_000_000,
      now: 1_700_001_000,
      read: async () => ({
        messages: [message(1, 1_700_000_100, 's1'), message(2, 1_700_000_200, 's2')],
        shards: report(),
      }),
    })

    assert.equal(result.success, true)
    assert.equal(result.coverage, 'complete')
    assert.equal(result.partial, false)
    assert.equal(result.recordsReturned, 2)
    assert.ok(result.jobId)

    const state = store.read(SOURCE, TALKER)
    assert.equal(state?.lastAttempt, state?.lastSuccessfulRun)
    assert.equal(state?.checkpoint.newestCreateTime, 1_700_000_200)
    assert.equal(state?.shards.opened, 2)

    const job = store.readJob(result.jobId as string)
    assert.equal(job?.state, 'completed')
    assert.equal(job?.error, null)
  })
})

test('every recorded timestamp carries a local offset, not a bare Z', async () => {
  await withStore(async (store) => {
    await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({ messages: [message(1, 1_700_000_100, 's1')], shards: report() }),
    })
    const state = store.read(SOURCE, TALKER) as any
    // Mixing `...Z` with `...+08:00` in one file makes "which local day was
    // this?" unanswerable, and the contract asks for the offset form.
    for (const field of ['lastAttempt', 'lastSuccessfulRun', 'updatedAt',
                         'coveredFrom', 'coveredTo']) {
      assert.match(String(state[field]), /[+-]\d{2}:\d{2}$/,
        `${field} should carry a local offset, got ${state[field]}`)
    }
  })
})

test('a partial run records the attempt but never claims success', async () => {
  await withStore(async (store) => {
    // Establish a known-good baseline first.
    await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({ messages: [message(1, 1_700_000_100, 's1')], shards: report() }),
    })
    const baseline = store.read(SOURCE, TALKER)

    const result = await runSync(TALKER, {
      store, now: 1_700_002_000, limit: 1,
      read: async () => ({
        messages: [message(2, 1_700_000_200, 's2'), message(3, 1_700_000_300, 's3')],
        shards: report({
          items: [{ name: 'message_1.db', opened: true, hasTalkerTable: null,
                    rowsForTalker: null, reason: 'READ_FAILED' }],
        }),
      }),
    })

    assert.equal(result.success, false)
    assert.equal(result.code, 'SYNC_PARTIAL')
    assert.equal(result.partial, true)
    assert.equal(result.coverage, 'partial')

    const after = store.read(SOURCE, TALKER)
    // The attempt moved; the success did not. That separation is the whole
    // point - otherwise a partial run looks like a good one later.
    assert.notEqual(after?.lastAttempt, baseline?.lastAttempt)
    assert.equal(after?.lastSuccessfulRun, baseline?.lastSuccessfulRun)

    const job = store.readJob(result.jobId as string)
    assert.equal(job?.state, 'partial')
    assert.equal(job?.error, 'SYNC_PARTIAL')
    assert.equal(job?.resumeable, true)
    // Usable results are kept, not discarded, when a run is incomplete.
    assert.ok(after)
  })
})

test('a failed shard is surfaced as a warning naming the shard', async () => {
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({
        messages: [message(1, 1_700_000_100, 's1')],
        shards: report({
          scanned: 3, opened: 2, failed: 1,
          items: [
            { name: 'message_0.db', opened: false, hasTalkerTable: null,
              rowsForTalker: null, reason: 'KEY_REJECTED' },
            { name: 'message_1.db', opened: true, hasTalkerTable: true,
              rowsForTalker: 1, reason: null },
          ],
        }),
      }),
    })
    assert.equal(result.coverage, 'unverified')
    assert.ok(result.warnings.includes('shard-unverified:message_0.db'))
    assert.equal(result.shards?.failed, 1)
  })
})

test('a shard the reader could not name anything in makes coverage partial', async () => {
  // SCHEMA_MISMATCH is not a fault after opening in the READ_FAILED sense, but
  // the rows are just as unread, so "complete" would be a false claim.
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({
        messages: [message(1, 1_700_000_100, 's1')],
        shards: report({
          items: [
            { name: 'message_0.db', opened: true, hasTalkerTable: true,
              rowsForTalker: 1, reason: null },
            { name: 'message_1.db', opened: true, hasTalkerTable: true,
              rowsForTalker: 4, reason: 'SCHEMA_MISMATCH', missingColumns: ['local_id'] },
          ],
        }),
      }),
    })
    assert.equal(result.coverage, 'partial')
    assert.equal(result.success, false)
    assert.ok(result.warnings.includes('shard-not-read:message_1.db:SCHEMA_MISMATCH'))
  })
})

test('a shard that lost an unread window makes coverage partial too', async () => {
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({
        messages: [message(1, 1_700_000_100, 's1')],
        shards: report({
          items: [
            { name: 'message_0.db', opened: true, hasTalkerTable: true,
              rowsForTalker: 1, reason: 'WINDOW_UNAVAILABLE' },
          ],
        }),
      }),
    })
    assert.equal(result.coverage, 'partial')
    assert.ok(result.warnings.includes('shard-not-read:message_0.db:WINDOW_UNAVAILABLE'))
  })
})

test('a shard read with columns missing still counts as complete, and says so', async () => {
  // The rows did come back; only fields were lost. That is a fidelity warning,
  // not a coverage failure, and conflating the two would make every sync on
  // such a database report itself as partial forever.
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({
        messages: [message(1, 1_700_000_100, 's1')],
        shards: report({
          items: [
            { name: 'message_0.db', opened: true, hasTalkerTable: true,
              rowsForTalker: 1, reason: null, missingColumns: ['server_id'] },
          ],
        }),
      }),
    })
    assert.equal(result.coverage, 'complete')
    assert.equal(result.success, true)
    assert.ok(result.warnings.includes('shard-columns-missing:message_0.db:server_id'))
  })
})

test('the window lower bound is offered to the reader as a pushdown hint', async () => {
  await withStore(async (store) => {
    const seen: Array<number | null> = []
    await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async (_who, _limit, from) => {
        seen.push(from)
        return { messages: [message(1, 1_700_000_100, 's1')] }
      },
    })
    assert.deepEqual(seen, [1_700_000_000])
  })
})

test('a resumed run offers the overlapped checkpoint, not the caller window', async () => {
  // Second run: the checkpoint from the first has to come back as the lower
  // bound, pulled back by the overlap so boundary messages are read again.
  await withStore(async (store) => {
    const first = await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({ messages: [message(1, 1_700_000_900, 's1')] }),
    })
    assert.equal(first.recordsReturned, 1)

    const seen: Array<number | null> = []
    await runSync(TALKER, {
      store, now: 1_700_002_000, overlapSeconds: 300,
      read: async (_who, _limit, from) => {
        seen.push(from)
        return { messages: [message(1, 1_700_000_900, 's1')] }
      },
    })
    assert.deepEqual(seen, [1_700_000_600])
  })
})

test('a backend without shard reporting is marked unverified, not complete', async () => {
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000,
      read: async () => ({ messages: [message(1, 1_700_000_100, 's1')] }),
    })
    assert.equal(result.coverage, 'unverified')
    assert.ok(result.warnings.includes('shard-report-unavailable'))
  })
})

test('only messages inside the window are counted as returned', async () => {
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store, since: 1_700_000_200, now: 1_700_001_000,
      read: async () => ({
        messages: [
          message(1, 1_700_000_100, 's1'),  // before the window
          message(2, 1_700_000_300, 's2'),
        ],
        shards: report(),
      }),
    })
    assert.equal(result.recordsRead, 2)
    assert.equal(result.recordsReturned, 1)
  })
})

test('write: false leaves no state behind', async () => {
  await withStore(async (store) => {
    const result = await runSync(TALKER, {
      store, since: 1_700_000_000, now: 1_700_001_000, write: false,
      read: async () => ({ messages: [message(1, 1_700_000_100, 's1')], shards: report() }),
    })
    assert.equal(result.jobId, null)
    assert.equal(store.read(SOURCE, TALKER), null)
  })
})
