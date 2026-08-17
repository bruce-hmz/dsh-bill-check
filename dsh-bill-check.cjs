#!/usr/bin/env node
/**
 * dsh-bill-check — DeepSeek Harness 本地账单核查工具（7 天验证实验用）
 *
 * 原则（对齐 07-winner-prd.md）：
 *  - 零依赖、零网络、零凭证：只读 ~/.dsh/sessions 的 token 计量字段，从不读取/输出对话内容。
 *  - 未知费率一律显示"未计价"，绝不猜价。
 *
 * 用法：
 *   node dsh-bill-check.js                 # 汇总 + 模型分布 + 时段分布 + 异常检测
 *   node dsh-bill-check.js --csv out.csv   # 按日/模型导出对账明细
 *   node dsh-bill-check.js --currency cny  # 用人民币价目表（v4-pro 有官方人民币价；flash 需自补）
 *   node dsh-bill-check.js --days 7        # 只看最近 N 天
 *
 * 费率来源：
 *  - USD 现行价：api-docs.deepseek.com/quick_start/pricing（2026-08-17 抓取；高峰 UTC 01-04 / 06-10）
 *  - CNY v4-pro 旧价/新空闲价：DSH Discussions #1571 作者对账实测（旧价全天一口价；新高峰价=空闲价×2）
 *  - 可用 ~/.dsh/dsh-bill-check-prices.json 覆盖任意条目（结构见 README）
 */

'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// ---------- 费率表（每 1M tokens） ----------
const USD = {
  current: {
    'deepseek-v4-flash': { off: { hit: 0.007, miss: 0.22, out: 0.66 }, peak: { hit: 0.014, miss: 0.44, out: 1.32 } },
    'deepseek-v4-pro': { off: { hit: 0.022, miss: 0.66, out: 1.98 }, peak: { hit: 0.044, miss: 1.32, out: 3.96 } },
  },
}
const CNY = {
  // v4-pro 旧价来自 #1571 对账帖（¥：hit 0.025 / miss 3.00 / out 6.00，全天一口价）
  old: { 'deepseek-v4-pro': { any: { hit: 0.025, miss: 3.0, out: 6.0 } } },
  // 新空闲价来自 #1571（高峰 = 空闲 × 2）；v4-flash 官方人民币价未公开 → 未计价，可自补
  current: {
    'deepseek-v4-pro': { off: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9.0, out: 27.0 } },
  },
}
const ALIAS = { dsv4p: 'deepseek-v4-pro', 'deepseek-v4-pro-0813': 'deepseek-v4-pro', 'deepseek-v4-flash-0731': 'deepseek-v4-flash' }
const norm = (m) => ALIAS[m] || m

function loadUserPrices() {
  const f = path.join(os.homedir(), '.dsh', 'dsh-bill-check-prices.json')
  if (!fs.existsSync(f)) return null
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}
function priceFor(model, isPeak, currency, userPrices) {
  const m = norm(model || 'unknown')
  const scope = currency === 'cny' ? CNY.current : USD.current
  const t = scope[m] || (userPrices && userPrices[currency] && userPrices[currency][m])
  if (!t) return null
  return t.peak && t.off ? (isPeak ? t.peak : t.off) : t.any
}
function oldPriceFor(model, currency, userPrices) {
  const m = norm(model || 'unknown')
  const t = (currency === 'cny' ? CNY.old : {})[m] || (userPrices && userPrices.old && userPrices.old[m])
  return t ? t.any || t.off : null
}

// ---------- 会话日志读取 ----------
function decompress(file) {
  // 优先系统 zstd：Node 24 的 zlib.zstdDecompressSync 对本格式会静默截断，只作 ENOENT 兜底
  try {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const zlib = require('node:zlib')
    return zlib.zstdDecompressSync(fs.readFileSync(file))
  }
}

function listSessionFiles(root) {
  const out = []
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(root, ws.name)
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const f = path.join(wsDir, s.name, 'session.jsonl.zstd')
      if (fs.existsSync(f)) out.push({ file: f, dirName: s.name })
    }
  }
  return out
}

function parseSession(file) {
  const lines = decompress(file).toString('utf8').split('\n')
  const sess = { id: null, cwd: null, parentSession: null, origin: null, createdAt: null, preset: null, subagentModel: null, requests: [] }
  let currentModel = null
  for (const line of lines) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const t = e.type
    if (t === 'session') {
      sess.id = e.id; sess.cwd = e.cwd; sess.parentSession = e.parentSession || null
      sess.origin = e.origin || null; sess.createdAt = e.createdAt || null; sess.preset = e.agentPreset || null
    } else if (t === 'subagent/descriptor') {
      sess.subagentModel = e.data && e.data.agentModel
    } else if (t === 'request/context') {
      currentModel = e.data && e.data.model
    } else if (t === 'assistant/message') {
      const u = e.data && e.data.usage
      if (!u) continue
      sess.requests.push({
        time: e.time, model: currentModel, turn: e.data.turn, step: e.data.step,
        input: u.inputTokens || 0, cacheRead: u.cacheReadTokens || 0, output: u.outputTokens || 0,
      })
    }
  }
  return sess
}

// ---------- 计费 ----------
const isPeakHour = (ms) => { const h = new Date(ms).getUTCHours(); return (h >= 1 && h < 4) || (h >= 6 && h < 10) }

function costOf(req, currency, userPrices) {
  const p = priceFor(req.model, isPeakHour(req.time), currency, userPrices)
  if (!p) return { cost: null }
  return { cost: (req.input * p.miss + req.cacheRead * p.hit + req.output * p.out) / 1e6 }
}
function oldCostOf(req, currency, userPrices) {
  const p = oldPriceFor(req.model, currency, userPrices)
  if (!p) return { cost: null }
  return { cost: (req.input * p.miss + req.cacheRead * p.hit + req.output * p.out) / 1e6 }
}

const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n)) ? '未计价' : n.toFixed(d)
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)
const dayOf = (ms) => new Date(ms).toLocaleDateString('sv') // YYYY-MM-DD 本地时区

// ---------- 主流程 ----------
function main() {
  const args = process.argv.slice(2)
  const csvIdx = args.indexOf('--csv'); const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : null
  const curIdx = args.indexOf('--currency'); const currency = curIdx >= 0 ? args[curIdx + 1] : 'usd'
  const daysIdx = args.indexOf('--days'); const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : null
  const jsonIdx = args.indexOf('--json')
  const userPrices = loadUserPrices()
  const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
  if (!fs.existsSync(root)) { console.error(`找不到会话目录：${root}`); process.exit(1) }

  const sessions = listSessionFiles(root).map(({ file, dirName }) => {
    const s = parseSession(file)
    s.id = s.id || dirName
    return s
  })

  const cutoff = days ? Date.now() - days * 86400e3 : 0
  const allReq = []
  for (const s of sessions) for (const r of s.requests) if (r.time >= cutoff) allReq.push({ ...r, sess: s })

  // ---- 汇总 ----
  const cur = currency.toUpperCase()
  let total = 0, hasUnknown = false
  let inTok = 0, hitTok = 0, outTok = 0, peakTok = 0, peakReq = 0
  const byModel = {}, byDay = {}
  let oldTotal = 0, oldKnown = true
  for (const r of allReq) {
    const { cost } = costOf(r, currency, userPrices)
    if (cost === null) { hasUnknown = true; oldKnown = false } else {
      total += cost
      const oc = oldCostOf(r, currency, userPrices)
      if (oc.cost === null) oldKnown = false; else oldTotal += oc.cost
    }
    const m = norm(r.model) || 'unknown'
    byModel[m] ??= { reqs: 0, in: 0, hit: 0, out: 0, cost: 0, unpriced: false }
    byModel[m].reqs++; byModel[m].in += r.input; byModel[m].hit += r.cacheRead; byModel[m].out += r.output
    if (cost === null) byModel[m].unpriced = true; else byModel[m].cost += cost
    inTok += r.input; hitTok += r.cacheRead; outTok += r.output
    if (isPeakHour(r.time)) { peakTok += r.input + r.cacheRead + r.output; peakReq++ }
    const d = dayOf(r.time)
    byDay[d] ??= { cost: 0, reqs: 0, in: 0, hit: 0, out: 0 }
    byDay[d].cost += cost === null ? 0 : cost; byDay[d].reqs++; byDay[d].in += r.input; byDay[d].hit += r.cacheRead; byDay[d].out += r.output
  }

  // ---- 时段迁移节省：若高峰请求全部挪到空闲（价差） ----
  let shiftSaving = 0
  for (const r of allReq) {
    if (!isPeakHour(r.time)) continue
    const pPeak = priceFor(r.model, true, currency, userPrices), pOff = priceFor(r.model, false, currency, userPrices)
    if (!pPeak || !pOff) continue
    shiftSaving += (r.input * (pPeak.miss - pOff.miss) + r.cacheRead * (pPeak.hit - pOff.hit) + r.output * (pPeak.out - pOff.out)) / 1e6
  }

  // ---- 首请求占比（E05：首请求常按 cache-miss 全价） ----
  let firstCost = 0, firstKnown = true
  for (const s of sessions) {
    const rs = s.requests.filter((r) => r.time >= cutoff)
    if (!rs.length) continue
    const c = costOf(rs[0], currency, userPrices)
    if (c.cost === null) { firstKnown = false; continue }
    firstCost += c.cost
  }

  // ---- 异常检测（E04 同类：模型不一致） ----
  const flags = []
  const byWs = {}
  for (const s of sessions) {
    const ws = s.cwd || 'unknown'
    byWs[ws] ??= []
    byWs[ws].push(s)
  }
  for (const [ws, ss] of Object.entries(byWs)) {
    const models = ss.flatMap((s) => [...new Set(s.requests.map((r) => norm(r.model)).filter(Boolean))])
    const modal = Object.entries(models.reduce((a, m) => ((a[m] = (a[m] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1])[0]?.[0]
    for (const s of ss) {
      const ms = [...new Set(s.requests.map((r) => norm(r.model)).filter(Boolean))]
      for (const m of ms) {
        if (modal && m !== modal && (s.origin === 'subagent' || s.parentSession)) {
          flags.push(`[模型不一致] 会话 ${String(s.id).replace("session-","").slice(0,8)}（subagent, ${ws}）使用 ${m}，工作区主力模型为 ${modal}`)
        }
      }
      if (ms.length > 1) flags.push(`[会话内切换] 会话 ${String(s.id).replace("session-","").slice(0,8)}（${ws}）中途切换模型：${ms.join(' → ')}`)
    }
  }

  // ---- 输出 ----
  if (jsonIdx >= 0) {
    console.log(JSON.stringify({ currency, total, oldTotal, byModel, byDay, flags }, null, 2)); return
  }
  const label = { usd: '$', cny: '¥' }[currency] || ''
  console.log(`\nDSH 账单核查（${sessions.length} 个会话文件，${allReq.length} 次计费请求${days ? `，最近 ${days} 天` : '，全部历史'}）`)
  console.log(`货币：${cur}${currency === 'cny' ? '（v4-flash 人民币价未公开→未计价，可在 ~/.dsh/dsh-bill-check-prices.json 自补）' : ''}`)
  console.log(`\n合计（现行价）：${label}${fmt(total)}${hasUnknown ? '（含未计价部分，仅统计有费率的模型）' : ''}`)
  if (oldKnown) console.log(`同量旧价对照：${label}${fmt(oldTotal)}  →  涨价影响：${fmt(total / oldTotal)}×`)
  console.log(`Tokens：输入(未命中) ${fmtTok(inTok)} ｜ 缓存命中 ${fmtTok(hitTok)} ｜ 输出 ${fmtTok(outTok)} ｜ 命中率 ${(hitTok / Math.max(1, inTok + hitTok) * 100).toFixed(1)}%`)
  console.log(`高峰时段占比：${peakTok > 0 ? (peakTok / Math.max(1, inTok + hitTok + outTok) * 100).toFixed(1) : '0'}%（tokens）｜ ${peakReq}/${allReq.length} 次请求`)
  console.log(`时段迁移潜力：高峰请求全部挪到空闲可省 ${label}${fmt(shiftSaving)}（-${total > 0 ? (shiftSaving / total * 100).toFixed(0) : 0}%）`)
  if (firstKnown) console.log(`各会话首请求合计：${label}${fmt(firstCost)}（占总支出 ${total > 0 ? (firstCost / total * 100).toFixed(0) : 0}% — E05：首请求按 cache-miss 全价发出）`)

  console.log(`\n按模型：`)
  for (const [m, v] of Object.entries(byModel)) console.log(`  ${m.padEnd(20)} ${String(v.reqs).padStart(4)} 次  命中 ${fmtTok(v.hit).padStart(7)}  输出 ${fmtTok(v.out).padStart(7)}  ${label}${v.unpriced ? '未计价' : fmt(v.cost)}`)

  console.log(`\n按日（最近 14 天）：`)
  for (const d of Object.keys(byDay).sort().slice(-14)) {
    const v = byDay[d]
    console.log(`  ${d}  ${String(v.reqs).padStart(4)} 次  ${label}${fmt(v.cost)}`)
  }

  if (flags.length) {
    console.log(`\n⚠ 异常标记（${flags.length}）：`)
    for (const f of [...new Set(flags)].slice(0, 10)) console.log(`  ${f}`)
  } else console.log(`\n✓ 未发现模型不一致/会话内切换类异常`)

  if (csvPath) {
    const rows = [['date', 'workspace', 'session', 'origin', 'model', 'requests', 'input_miss', 'cache_hit', 'output', `cost_${currency}`]]
    const agg = {}
    for (const r of allReq) {
      const k = [dayOf(r.time), r.sess.cwd || 'unknown', String(r.sess.id).replace("session-","").slice(0,8), r.sess.origin || 'main', norm(r.model) || 'unknown'].join('|')
      agg[k] ??= { reqs: 0, in: 0, hit: 0, out: 0, cost: 0, unpriced: false }
      agg[k].reqs++; agg[k].in += r.input; agg[k].hit += r.cacheRead; agg[k].out += r.output
      const c = costOf(r, currency, userPrices).cost
      if (c === null) agg[k].unpriced = true; else agg[k].cost += c
    }
    for (const [k, v] of Object.entries(agg).sort()) rows.push([...k.split('|'), v.reqs, v.in, v.hit, v.out, v.unpriced ? '未计价' : v.cost.toFixed(6)])
    fs.writeFileSync(csvPath, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'))
    console.log(`\n对账明细已导出：${csvPath}（可与 DeepSeek 控制台按日核对，方法见 #1571）`)
  }
}

main()
