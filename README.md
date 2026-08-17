# dsh-bill-check

DeepSeek Harness（DSH）本地账单核查工具。

单文件、零依赖、零网络、零凭证。只读 `~/.dsh/sessions` 里的 token 计量字段，**从不读取或输出对话内容**。

## 它能回答什么

1. **我花了多少钱**——现行价合计、按模型、按日；v4-pro 可看 8/16 涨价前后对照。
2. **钱花在哪了**——subagent 与主会话分别归因（会话树），首请求占比（首请求按 cache-miss 全价发出）。
3. **有没有被坑**——模型不一致/会话内切换检测（对应社区报告的 subagent 静默切默认模型导致跨供应商误计费）。
4. **能省多少**——高峰时段占比与"挪到空闲时段"的节省测算（新价高峰=空闲×2，高峰窗口为北京时间 09:00–12:00 / 14:00–18:00）。
5. **对账**——导出按日/按会话/按模型的明细 CSV，与 DeepSeek 控制台逐日核对（方法参考 Discussions #1571）。

## 依赖与用法

```sh
# 需要 Node ≥ 18 与 zstd（macOS: brew install zstd；多数 Linux 自带）
node dsh-bill-check.cjs                    # 全部历史汇总
node dsh-bill-check.cjs --days 7           # 最近 7 天
node dsh-bill-check.cjs --csv bill.csv     # 导出对账明细
node dsh-bill-check.cjs --currency cny     # 人民币价目表
node dsh-bill-check.cjs --json             # 机读输出
```

会话目录取 `$DSH_HOME/sessions`，默认 `~/.dsh/sessions`。

## 费率表与来源（抓取日期 2026-08-17）

| 币种 | 模型 | 来源 |
|---|---|---|
| USD（默认） | v4-flash / v4-pro，高峰/空闲双档 | 官方定价页 api-docs.deepseek.com/quick_start/pricing |
| CNY | v4-pro 旧价（全天一口价）与现行空闲价（高峰=空闲×2） | Discussions #1571 作者对账实测（误差 −2%） |
| CNY | v4-flash | 官方未公开 → **未计价**，请自补（见下） |

高峰判定按官方口径 UTC 01:00–04:00 / 06:00–10:00（= 北京时间 09–12 / 14–18 点）。

### 自定义/补充费率

创建 `~/.dsh/dsh-bill-check-prices.json`（任意条目覆盖内置表；`any` = 不分时段）：

```json
{
  "cny": { "deepseek-v4-flash": { "off": { "hit": 0.05, "miss": 1.6, "out": 4.8 }, "peak": { "hit": 0.1, "miss": 3.2, "out": 9.6 } } },
  "usd": { "glm-5.3": { "any": { "hit": 0.0, "miss": 0.6, "out": 2.2 } } },
  "old": { "deepseek-v4-flash": { "any": { "hit": 0.02, "miss": 1.1, "out": 3.3 } } }
}
```

**原则：未知费率一律显示"未计价"，绝不猜价**（算错账单比不算更糟）。

## 已知限制

- 只统计 DSH 写盘的请求：进程外/其他工具发出的请求不在内（#1571 作者实测因此差 −5%）。
- 多供应商（GLM 等）默认无费率；token 数照常统计。
- token 字段取自 `assistant/message.usage`（`inputTokens` 与 `cacheReadTokens` 互斥，计费输入=两者之和——与官方 `prompt_cache_hit/miss` 口径一致）。
- 模型归因取该消息前最近一条 `request/context`；中途切模型会被标记为"会话内切换"。

## 与 #1571 的 dsh-cache-audit.py 的关系

致敬且互补：`dsh-cache-audit.py`（deepseekprice.com）聚焦**命中率与三套价目表的账单对比**；本工具补上它没做的四件事——**subagent/会话树归因与模型异常检测、高峰时段迁移节省测算、首请求占比、对账 CSV 导出**。两者数字可互相验证。

## 路线

本脚本验证的计量口径将并入规划中的 `dsh-cost-guard` 原生插件（Web 面板、轮级徽标、预算熔断、异常守卫）。Issue 与 PR 欢迎。
