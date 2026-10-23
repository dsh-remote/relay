/**
 * 版本分布 —— M4「关老兼容以版本分布为准」的数据面 + T+24h 观察窗的读数。
 *
 * `/healthz` 从此按版本计数活连接（hostVersions / clientVersions）：RELEASE-CADENCE §4
 * 第 6 项「版本上报：两端都能看到新版本号的量」与 §6「存量迁移降到个位数」都要它。
 * 零知识边界不动：版本是端点自报的**元数据**，不是内容；未上报的归 `unknown` 桶。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayState } from '../dist/src/state.js'

const fakeWs = () => ({})

test('counts 按版本计活连接：上报的分版本，没上报的归 unknown', () => {
  const state = new RelayState()
  state.attachHost('h1', fakeWs(), '甲', '0.5.0')
  state.attachHost('h2', fakeWs(), '乙', '0.5.0')
  state.attachHost('h3', fakeWs(), '丙', '3.2.14')
  state.attachHost('h4', fakeWs(), '丁', undefined)
  state.attachClient('c1', fakeWs(), '0.5.0')
  state.attachClient('c2', fakeWs(), undefined)

  const c = state.counts()
  assert.deepEqual(c.hostVersions, { '0.5.0': 2, '3.2.14': 1, unknown: 1 })
  assert.deepEqual(c.clientVersions, { '0.5.0': 1, unknown: 1 })
})

test('顶号/离线要跟着掉计数（活连接口径，不是累计）', () => {
  const state = new RelayState()
  state.attachHost('h1', fakeWs(), '甲', '0.5.0')
  assert.equal(state.counts().hostVersions['0.5.0'], 1)
  // 同 id 顶号换版本：旧连接被顶掉 ⇒ 按新版本算
  state.attachHost('h1', fakeWs(), '甲', '0.5.1')
  assert.deepEqual(state.counts().hostVersions, { '0.5.1': 1 })
  state.hostGone('h1', state.hosts.get('h1').ws)
  assert.deepEqual(state.counts().hostVersions, {})
})

test('版本串有界（healthz 是公网面）：超长/怪字符按形状归一', () => {
  const state = new RelayState()
  state.attachHost('h1', fakeWs(), '甲', 'x'.repeat(200))
  const keys = Object.keys(state.counts().hostVersions)
  assert.ok(keys[0].length <= 64, `版本键必须有界，实际 ${keys[0].length}`)
})
