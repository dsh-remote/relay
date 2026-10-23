/**
 * summary 落盘 — M2「状态摘要可留存」的中继侧判据（REVIEW-offline-continuity §5.1）。
 *
 * 评审的零知识切分：「**内容**零知识（中继不可解密）＋ **状态**可留存（最后活动时间 /
 * 进度摘要 / 待审批数）」。摘要就是那条可留存的面 —— 但正因它**明文**落盘，
 * 落盘边界必须是白名单：形状不对（含自由文本键）的摘要**整条不进盘**，
 * 读回来时也一样（state.json 不是信任边界：它可能被人手改过）。
 *
 * 判据出口的另一半（「盘上出现摘要字段且不含内容明文」的探针审计）在
 * `e2e/relay-summary-audit.test.mjs`；这里钉的是序列化/恢复/消毒的纯逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayState } from '../dist/src/state.js'
import { readStateFile, restoreState, snapshotState, writeStateFile } from '../dist/src/persist.js'

const DIGEST = { at: 1_761_200_000_000, running: true, steps: 12, pending: 1 }

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'drc-summary-'))
}

function captureLog() {
  const lines = []
  return {
    log: {
      info: (m, f) => lines.push([m, f]),
      warn: (m, f) => lines.push([m, f]),
      error: (m, f) => lines.push([m, f]),
    },
    lines,
  }
}

function stateWith(summary) {
  const state = new RelayState()
  state.conversations.set('c_aaaaaaaaaaaa', {
    hostId: 'h1',
    clients: new Set(['inst-1']),
    seqHost: 3,
    upCount: 2,
    lastActivityAt: 1234,
    ...(summary === undefined ? {} : { summary }),
  })
  return state
}

test('摘要随会话落盘：盘上出现摘要字段，键集就是白名单那四个', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    assert.equal(writeStateFile(p, snapshotState(stateWith(DIGEST), 999), log), true)

    const raw = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(raw.conversations.length, 1)
    const onDisk = raw.conversations[0].summary
    assert.ok(onDisk, '判据出口：中继盘上必须出现摘要字段')
    assert.deepEqual(onDisk, DIGEST, '落盘的是状态摘要本体（数字/布尔），一个字都不能多')
    assert.deepEqual(Object.keys(onDisk).sort(), ['at', 'pending', 'running', 'steps'], '键集 = 白名单')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('恢复回来还是那份摘要（重启后中继仍然答得出"最后已知"）', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    writeStateFile(p, snapshotState(stateWith(DIGEST), 999), log)

    const state = new RelayState()
    restoreState(p, state, log, 1000)
    const conv = state.conversations.get('c_aaaaaaaaaaaa')
    assert.ok(conv, '会话本体要回来')
    assert.deepEqual(conv.summary, DIGEST, '摘要跟着会话一起恢复')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('可选字段可省：只报 at/running 的摘要也照存照回', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    const minimal = { at: 5, running: false }
    writeStateFile(p, snapshotState(stateWith(minimal), 999), log)
    const state = new RelayState()
    restoreState(p, state, log, 1000)
    assert.deepEqual(state.conversations.get('c_aaaaaaaaaaaa').summary, minimal)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('加载消毒：state.json 不是信任边界 —— 带自由文本键的摘要整条丢掉', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    // 模拟一份被人手改过的状态文件：摘要里混进了任务文本（零知识红线）。
    const hostile = {
      version: 2,
      savedAt: 999,
      conversations: [
        {
          conversationId: 'c_aaaaaaaaaaaa',
          hostId: 'h1',
          clients: ['inst-1'],
          seqHost: 3,
          upCount: 2,
          lastActivityAt: 1234,
          summary: { ...DIGEST, title: '正在写周报' },
        },
      ],
      hostTokens: [],
    }
    writeFileSync(p, JSON.stringify(hostile))

    const state = new RelayState()
    restoreState(p, state, log, 1000)
    const conv = state.conversations.get('c_aaaaaaaaaaaa')
    assert.ok(conv, '会话本身还在（坏的是摘要，不是会话）')
    assert.equal(conv.summary, undefined, '带自由文本键的摘要整条不进内存 —— 漏进去就是零知识破口')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('加载消毒：类型不对（steps 为负 / at 为串）的摘要同样整条丢掉', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    for (const bad of [
      { ...DIGEST, steps: -1 },
      { ...DIGEST, at: 'now' },
      { ...DIGEST, running: 'yes' },
    ]) {
      writeFileSync(
        p,
        JSON.stringify({
          version: 2,
          savedAt: 999,
          conversations: [
            {
              conversationId: 'c_aaaaaaaaaaaa',
              hostId: 'h1',
              clients: ['inst-1'],
              seqHost: 3,
              upCount: 2,
              lastActivityAt: 1234,
              summary: bad,
            },
          ],
          hostTokens: [],
        }),
      )
      const state = new RelayState()
      restoreState(p, state, log, 1000)
      assert.equal(
        state.conversations.get('c_aaaaaaaaaaaa').summary,
        undefined,
        `坏形状的摘要不许进内存：${JSON.stringify(bad)}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有摘要的老盘（v2 之前留下的）照常读：summary 缺席不是错误', () => {
  const dir = tmpDir()
  try {
    const p = join(dir, 'state.json')
    const { log } = captureLog()
    writeStateFile(p, snapshotState(stateWith(undefined), 999), log)
    const state = new RelayState()
    // restoreState 返回的是**恢复的会话条数**（0 = 没有状态文件/读坏了），不是丢失数。
    assert.equal(restoreState(p, state, log, 1000), 1, '老盘照常恢复（summary 缺席不是错误）')
    assert.equal(state.conversations.get('c_aaaaaaaaaaaa').summary, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
